"""Fail-closed change classification shared by local and CI checks.

The classifier deliberately works from Git's view of the checkout instead of
only looking at the index.  A local pre-push run must include the committed
branch delta, staged and unstaged edits, and non-ignored untracked files.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final

GATE_NAMES: Final[tuple[str, ...]] = (
    "frontend",
    "backend",
    "server_image",
    "docs",
)

_FRONTEND_PREFIX = "frontend/"
_BACKEND_PREFIX = "backend/"
_BACKEND_RUNTIME_PREFIX = "infra/supabase/"
_CONTRACTS_PREFIX = "contracts/"
_SERVER_IMAGE_PREFIXES: Final[tuple[str, ...]] = ("infra/", _CONTRACTS_PREFIX)
_SERVER_IMAGE_PATHS: Final[frozenset[str]] = frozenset(
    {
        ".dockerignore",
        ".env.example",
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    }
)
_DOC_PREFIXES: Final[tuple[str, ...]] = ("docs/",)
_DOC_SUFFIXES: Final[tuple[str, ...]] = (".md", ".mdx", ".rst")
_TOOLING_PREFIXES: Final[tuple[str, ...]] = (
    ".github/",
    ".codex/",
    ".agents/",
    "scripts/",
    "tests/tooling/",
)
_KNOWN_ROOT_FILES: Final[frozenset[str]] = frozenset(
    {
        ".gitignore",
        ".prettierignore",
        ".prettierrc",
        "Makefile",
        "package.json",
        "package-lock.json",
        "pyproject.toml",
        "uv.lock",
    }
)


class ClassificationError(RuntimeError):
    """Raised when Git cannot provide a trustworthy change set."""


@dataclass(frozen=True)
class GateDecision:
    """A deterministic decision and the evidence behind it."""

    run: bool
    reason: str

    def as_dict(self) -> dict[str, bool | str]:
        return {"run": self.run, "reason": self.reason}


@dataclass(frozen=True)
class ChangeScope:
    """Verified base, complete changed-path set, and gate decisions."""

    base_ref: str | None
    paths: tuple[str, ...]
    decisions: dict[str, GateDecision]
    error: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "base": self.base_ref,
            "error": self.error,
            "paths": list(self.paths),
            "decisions": {name: self.decisions[name].as_dict() for name in GATE_NAMES},
        }


def _run_git(root: Path, arguments: list[str]) -> bytes:
    try:
        result = subprocess.run(
            ["git", *arguments],
            cwd=root,
            check=False,
            capture_output=True,
        )
    except OSError as error:
        raise ClassificationError(f"Git command could not run: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        suffix = f": {detail}" if detail else ""
        raise ClassificationError(f"Git command failed ({result.returncode}){suffix}")
    return result.stdout


def resolve_base(root: Path, base: str | None) -> str:
    """Resolve *base* to one verified commit object or raise."""

    if base is None or not base.strip():
        raise ClassificationError("A comparison base revision is required")
    candidate = base.strip()
    if "\x00" in candidate:
        raise ClassificationError("The comparison base contains a NUL byte")
    if not candidate.strip("0"):
        raise ClassificationError("The comparison base is the all-zero Git revision")
    output = _run_git(
        root,
        [
            "rev-parse",
            "--verify",
            "--end-of-options",
            f"{candidate}^{{commit}}",
        ],
    )
    resolved = output.decode("utf-8").strip().splitlines()
    if len(resolved) != 1 or not resolved[0]:
        raise ClassificationError("Git returned an invalid comparison base")
    return resolved[0]


def _parse_paths(output: bytes) -> tuple[str, ...]:
    try:
        values = [item.decode("utf-8") for item in output.split(b"\0") if item]
    except UnicodeDecodeError as error:
        raise ClassificationError("Git returned a non-UTF-8 path") from error
    if any("\0" in value for value in values):
        raise ClassificationError("Git returned an invalid path")
    return tuple(values)


def collect_changed_paths(root: Path, base_ref: str) -> tuple[str, ...]:
    """Collect committed, staged, unstaged, and non-ignored untracked paths."""

    outputs = (
        _run_git(root, ["diff", "--name-only", "-z", "HEAD", "--"]),
        _run_git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
        _run_git(root, ["diff", "--name-only", "-z", f"{base_ref}...HEAD", "--"]),
    )
    return tuple(sorted({path for output in outputs for path in _parse_paths(output)}))


def _decision(run: bool, reason: str) -> GateDecision:
    return GateDecision(run=run, reason=reason)


def _path_list(paths: tuple[str, ...]) -> str:
    return ", ".join(paths)


def _is_doc(path: str) -> bool:
    name = Path(path).name
    return (
        path.startswith(_DOC_PREFIXES)
        or path.endswith(_DOC_SUFFIXES)
        or name.upper().startswith(("README", "LICENSE", "CHANGELOG"))
    )


def _is_known_path(path: str) -> bool:
    return (
        _is_doc(path)
        or path.startswith(
            (
                _FRONTEND_PREFIX,
                _BACKEND_PREFIX,
                *_SERVER_IMAGE_PREFIXES,
                *_TOOLING_PREFIXES,
            )
        )
        or path in _SERVER_IMAGE_PATHS
        or path in _KNOWN_ROOT_FILES
    )


def _fail_closed(paths: tuple[str, ...], base_ref: str | None, error: str) -> ChangeScope:
    reason = f"Classification failed; running all gates (fail-closed): {error}"
    return ChangeScope(
        base_ref=base_ref,
        paths=paths,
        error=error,
        decisions={name: _decision(True, reason) for name in GATE_NAMES},
    )


def classify_paths(paths: list[str] | tuple[str, ...], base_ref: str) -> ChangeScope:
    """Classify an already collected, deterministic path list."""

    ordered = tuple(sorted(set(paths)))
    if not ordered:
        reason = "No changed paths were found; run all requested gates"
        return ChangeScope(
            base_ref=base_ref,
            paths=ordered,
            decisions={name: _decision(True, reason) for name in GATE_NAMES},
        )

    unknown = tuple(path for path in ordered if not _is_known_path(path))
    if unknown:
        reason = f"Unclassified path(s): {_path_list(unknown)}; running all gates"
        return ChangeScope(
            base_ref=base_ref,
            paths=ordered,
            decisions={name: _decision(True, reason) for name in GATE_NAMES},
        )

    docs = tuple(path for path in ordered if _is_doc(path))
    functional = tuple(path for path in ordered if not _is_doc(path))
    docs_reason = (
        f"Documentation changed: {_path_list(docs)}" if docs else "No documentation paths changed"
    )
    if not functional:
        return ChangeScope(
            base_ref=base_ref,
            paths=ordered,
            decisions={
                "frontend": _decision(False, "Documentation-only changes"),
                "backend": _decision(False, "Documentation-only changes"),
                "server_image": _decision(False, "Documentation-only changes"),
                "docs": _decision(True, docs_reason),
            },
        )

    frontend_paths = tuple(path for path in functional if path.startswith(_FRONTEND_PREFIX))
    # Shared contract data (for example the OpenAPI snapshot) is read by frontend tests.
    contract_paths = tuple(path for path in functional if path.startswith(_CONTRACTS_PREFIX))
    frontend_route_paths = tuple(
        path
        for path in frontend_paths
        if path
        in {
            "frontend/api-route-manifest.json",
            "frontend/src/lib/api.ts",
            "frontend/src/lib/auth-api.ts",
        }
        or (
            path.startswith("frontend/src/")
            and ("/adapters/" in path or path.endswith("/state/api.ts"))
        )
    )
    backend_paths = tuple(
        path for path in functional if path.startswith((_BACKEND_PREFIX, _BACKEND_RUNTIME_PREFIX))
    )
    server_image_paths = tuple(
        path
        for path in functional
        if path.startswith(_SERVER_IMAGE_PREFIXES) or path in _SERVER_IMAGE_PATHS
    )
    tooling_paths = tuple(path for path in functional if path.startswith(_TOOLING_PREFIXES))
    broad = bool(tooling_paths)
    frontend_run = broad or bool(frontend_paths) or bool(contract_paths)
    # The OpenAPI snapshot is also checked against the FastAPI app by a backend test.
    backend_run = broad or bool(backend_paths) or bool(frontend_route_paths) or bool(contract_paths)
    server_image_run = (
        broad or bool(frontend_paths) or bool(backend_paths) or bool(server_image_paths)
    )

    frontend_reason = (
        f"Frontend paths changed: {_path_list(frontend_paths)}"
        if frontend_paths
        else f"Shared CI/tooling paths changed: {_path_list(tooling_paths)}"
        if broad
        else f"Shared contracts changed: {_path_list(contract_paths)}"
        if contract_paths
        else "No frontend paths changed"
    )
    backend_reason = (
        f"Backend paths changed: {_path_list(backend_paths)}"
        if backend_paths
        else f"Shared CI/tooling paths changed: {_path_list(tooling_paths)}"
        if broad
        else (
            "Frontend API contracts changed; run test_frontend_route_coverage.py: "
            f"{_path_list(frontend_route_paths)}"
        )
        if frontend_route_paths
        else f"Shared contracts changed: {_path_list(contract_paths)}"
        if contract_paths
        else "No backend paths changed"
    )
    server_image_reason = (
        f"Shared CI/tooling paths changed: {_path_list(tooling_paths)}"
        if broad
        else f"Frontend paths changed: {_path_list(frontend_paths)}"
        if frontend_paths
        else f"Backend paths changed: {_path_list(backend_paths)}"
        if backend_paths
        else f"Server image inputs changed: {_path_list(server_image_paths)}"
        if server_image_paths
        else "No unified server image inputs changed"
    )

    return ChangeScope(
        base_ref=base_ref,
        paths=ordered,
        decisions={
            "frontend": _decision(
                frontend_run,
                frontend_reason,
            ),
            "backend": _decision(
                backend_run,
                backend_reason,
            ),
            "server_image": _decision(
                server_image_run,
                server_image_reason,
            ),
            "docs": _decision(bool(docs), docs_reason),
        },
    )


def classify_changes(root: Path, base: str | None) -> ChangeScope:
    """Resolve the base and classify the complete checkout, failing closed."""

    resolved: str | None = None
    try:
        resolved = resolve_base(root, base)
        return classify_paths(collect_changed_paths(root, resolved), resolved)
    except ClassificationError as error:
        return _fail_closed((), resolved, str(error))


def _github_value(value: str) -> str:
    """Encode control characters for GitHub's environment-file format."""

    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def write_github_output(scope: ChangeScope, destination: Path) -> None:
    """Append stable gate outputs for a GitHub Actions step."""

    lines = [f"base={_github_value(scope.base_ref or '')}"]
    for name in GATE_NAMES:
        decision = scope.decisions[name]
        lines.append(f"run_{name}={'true' if decision.run else 'false'}")
        lines.append(f"reason_{name}={_github_value(decision.reason)}")
    with destination.open("a", encoding="utf-8") as output:
        output.write("\n".join(lines) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        help="Git revision used as the comparison base; invalid or missing values fail closed",
    )
    parser.add_argument(
        "--github-output",
        type=Path,
        help="Optional GitHub Actions environment-file path to receive gate outputs",
    )
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    scope = classify_changes(root, args.base)
    print(json.dumps(scope.as_dict(), indent=2, sort_keys=True))
    if args.github_output is not None:
        try:
            write_github_output(scope, args.github_output)
        except OSError as error:
            print(f"Cannot write GitHub output: {error}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
