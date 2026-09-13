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
    "containers",
    "frontend_container",
    "frontend_mobile",
    "frontend_extended",
    "backend_container",
    "fullstack",
    "docs",
)
FUNCTIONAL_GATES: Final[tuple[str, ...]] = (
    "frontend",
    "backend",
    "fullstack",
)

# These are intentionally narrow.  A path is allowed to suppress the real
# stack only when it is part of the local sample surface, not merely because
# it happens to live under frontend/.
LOCAL_SAMPLE_PREFIXES: Final[tuple[str, ...]] = (
    "frontend/src/components/sample/",
    "frontend/tests/browser/sample/",
    "frontend/tests/isolated/sample/",
)
LOCAL_SAMPLE_PATHS: Final[frozenset[str]] = frozenset(
    {
        "frontend/CONTROLS-ACCEPTANCE.md",
        "frontend/src/app/(app)/(workspace)/[pillar]/page.tsx",
        "frontend/tests/isolated/manage-state.spec.ts",
    }
)

_FRONTEND_PREFIX = "frontend/"
_BACKEND_PREFIX = "backend/"
_CONTAINER_PREFIXES: Final[tuple[str, ...]] = (
    "infra/",
    "supabase/",
)
_CONTAINER_PATHS: Final[frozenset[str]] = frozenset(
    {
        ".dockerignore",
        ".env.example",
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    }
)
_FRONTEND_IMAGE_PATHS: Final[frozenset[str]] = frozenset(
    {
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/next.config.ts",
        "frontend/scripts/run-next.mjs",
        "frontend/scripts/start-standalone.mjs",
        "frontend/src/lib/environment.ts",
        "infra/docker/frontend.Dockerfile",
    }
)
_BACKEND_IMAGE_PATHS: Final[frozenset[str]] = frozenset(
    {
        "infra/docker/backend.Dockerfile",
    }
)
_SHARED_DOCKER_PREFIXES: Final[tuple[str, ...]] = ("contracts/",)
_DOC_PREFIXES: Final[tuple[str, ...]] = ("docs/",)
_DOC_SUFFIXES: Final[tuple[str, ...]] = (".md", ".mdx", ".rst")
_TOOLING_PREFIXES: Final[tuple[str, ...]] = (
    ".github/",
    ".codex/",
    ".agents/",
    "scripts/",
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


def _is_local_sample_path(path: str) -> bool:
    return path in LOCAL_SAMPLE_PATHS or path.startswith(LOCAL_SAMPLE_PREFIXES)


def _is_mobile_frontend_path(path: str) -> bool:
    return (
        path == "frontend/playwright.config.ts"
        or path.startswith("frontend/tests/browser/")
        or (path.startswith(_FRONTEND_PREFIX) and path.endswith(".css"))
        or (
            path.endswith(".tsx")
            and path.startswith(("frontend/src/app/", "frontend/src/components/"))
        )
    )


def _is_browser_spec(path: str) -> bool:
    return path.startswith("frontend/tests/browser/") and path.endswith(
        (".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx")
    )


def _is_known_path(path: str) -> bool:
    return (
        _is_doc(path)
        or _is_local_sample_path(path)
        or path.startswith(
            (
                _FRONTEND_PREFIX,
                _BACKEND_PREFIX,
                *_CONTAINER_PREFIXES,
                *_TOOLING_PREFIXES,
                *_SHARED_DOCKER_PREFIXES,
            )
        )
        or path in _CONTAINER_PATHS
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
                "containers": _decision(False, "Documentation-only changes"),
                "frontend_container": _decision(False, "Documentation-only changes"),
                "frontend_mobile": _decision(False, "Documentation-only changes"),
                "frontend_extended": _decision(False, "Documentation-only changes"),
                "backend_container": _decision(False, "Documentation-only changes"),
                "fullstack": _decision(False, "Documentation-only changes"),
                "docs": _decision(True, docs_reason),
            },
        )

    local_sample_only = all(_is_local_sample_path(path) for path in functional)
    frontend_paths = tuple(path for path in functional if path.startswith(_FRONTEND_PREFIX))
    backend_paths = tuple(path for path in functional if path.startswith(_BACKEND_PREFIX))
    container_paths = tuple(
        path
        for path in functional
        if path.startswith(_CONTAINER_PREFIXES) or path in _CONTAINER_PATHS
    )
    tooling_paths = tuple(path for path in functional if path.startswith(_TOOLING_PREFIXES))
    broad_tooling_paths = tuple(path for path in tooling_paths if path not in _FRONTEND_IMAGE_PATHS)
    shared_docker_paths = tuple(
        path
        for path in functional
        if path.startswith(_SHARED_DOCKER_PREFIXES) or path in _CONTAINER_PATHS
    )
    infrastructure_paths = tuple(
        path
        for path in functional
        if path.startswith(_CONTAINER_PREFIXES)
        and path not in _FRONTEND_IMAGE_PATHS
        and path not in _BACKEND_IMAGE_PATHS
    )

    broad = bool(broad_tooling_paths)
    frontend_run = broad or bool(frontend_paths)
    backend_run = broad or bool(backend_paths)
    frontend_container_run = (
        broad
        or bool(shared_docker_paths)
        or bool(infrastructure_paths)
        or bool(_FRONTEND_IMAGE_PATHS.intersection(functional))
    )
    frontend_mobile_paths = tuple(
        path for path in functional if _is_mobile_frontend_path(path)
    )
    frontend_mobile_run = broad or bool(frontend_mobile_paths)
    # Fail closed for browser-spec changes. This avoids a maintained filename
    # allowlist silently missing a newly tagged or renamed @extended scenario.
    frontend_extended_paths = tuple(
        path for path in functional if _is_browser_spec(path)
    )
    frontend_extended_run = broad or bool(frontend_extended_paths)
    backend_container_run = (
        broad
        or bool(backend_paths)
        or bool(shared_docker_paths)
        or bool(infrastructure_paths)
        or bool(_BACKEND_IMAGE_PATHS.intersection(functional))
    )
    container_run = (
        broad or bool(container_paths) or frontend_container_run or backend_container_run
    )
    fullstack_run = broad or bool(frontend_paths or backend_paths or container_paths)
    frontend_image_definitions = tuple(
        sorted(_FRONTEND_IMAGE_PATHS.intersection(functional))
    )
    backend_image_definitions = tuple(
        sorted(_BACKEND_IMAGE_PATHS.intersection(functional))
    )
    container_reason_paths = (
        container_paths or frontend_paths or backend_paths or tooling_paths
    )

    if local_sample_only:
        fullstack_run = False
        fullstack_reason = (
            "Local sample-only paths; disposable full-stack provisioning is not required"
        )
    elif fullstack_run:
        fullstack_reason = (
            f"Functional change requires real-stack acceptance: {_path_list(functional)}"
        )
    else:
        fullstack_reason = "No full-stack-affecting paths changed"

    frontend_reason = (
        f"Frontend paths changed: {_path_list(frontend_paths)}"
        if frontend_paths
        else f"Shared CI/tooling paths changed: {_path_list(tooling_paths)}"
        if broad
        else "No frontend paths changed"
    )
    backend_reason = (
        f"Backend paths changed: {_path_list(backend_paths)}"
        if backend_paths
        else f"Shared CI/tooling paths changed: {_path_list(tooling_paths)}"
        if broad
        else "No backend paths changed"
    )
    frontend_container_reason = (
        f"Shared/unknown tooling paths changed: {_path_list(broad_tooling_paths)}"
        if broad
        else f"Shared Docker context paths changed: {_path_list(shared_docker_paths)}"
        if shared_docker_paths
        else f"Frontend image input changed: {_path_list(frontend_image_definitions)}"
        if frontend_container_run
        else "No frontend image inputs changed"
    )
    frontend_mobile_reason = (
        f"Mobile-sensitive frontend paths changed: {_path_list(frontend_mobile_paths)}"
        if frontend_mobile_paths
        else f"Shared CI/tooling paths changed: {_path_list(tooling_paths)}"
        if broad
        else "No mobile-sensitive frontend paths changed"
    )
    frontend_extended_reason = (
        "Browser specifications changed; run extended acceptance: "
        f"{_path_list(frontend_extended_paths)}"
        if frontend_extended_paths
        else f"Shared CI/tooling paths changed: {_path_list(tooling_paths)}"
        if broad
        else "No extended frontend specifications changed"
    )
    backend_container_reason = (
        f"Shared/unknown tooling paths changed: {_path_list(broad_tooling_paths)}"
        if broad
        else f"Shared Docker context paths changed: {_path_list(shared_docker_paths)}"
        if shared_docker_paths
        else f"Backend image paths changed: {_path_list(backend_paths)}"
        if backend_paths
        else f"Backend image definition changed: {_path_list(backend_image_definitions)}"
        if backend_container_run
        else "No backend image inputs changed"
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
            "containers": _decision(
                container_run,
                (
                    f"Container/tooling or application paths changed: "
                    f"{_path_list(container_reason_paths)}"
                )
                if container_run
                else "No container-affecting paths changed",
            ),
            "frontend_container": _decision(
                frontend_container_run,
                frontend_container_reason,
            ),
            "frontend_mobile": _decision(
                frontend_mobile_run,
                frontend_mobile_reason,
            ),
            "frontend_extended": _decision(
                frontend_extended_run,
                frontend_extended_reason,
            ),
            "backend_container": _decision(
                backend_container_run,
                backend_container_reason,
            ),
            "fullstack": _decision(fullstack_run, fullstack_reason),
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
