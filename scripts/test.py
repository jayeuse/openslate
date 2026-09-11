"""Select existing test sections; live mutations remain explicit opt-in commands."""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

SECTIONS = {
    "backend": ("security", "audit", "api", "runtime", "database", "scripts"),
    "frontend": ("public", "security", "shell", "sample", "sandbox", "runtime"),
}
FRONTEND_LAYERS = ("isolated", "http", "browser")


def backend_section(path: str) -> str:
    """Keep legacy filenames selectable while focused suites move into folders."""
    name = Path(path).name
    if "/runtime/" in path or name.startswith(
        ("test_runtime", "test_health", "test_readiness", "test_observability")
    ):
        return "runtime"
    if (
        "/audit/" in path
        or "/security_events/" in path
        or name.startswith(("test_audit", "test_request_context"))
    ):
        return "audit"
    if (
        "/migration_" in path
        or name.startswith(("test_migration", "test_disposable_database"))
        or path.endswith("relationships_integration/test_migration.py")
    ):
        return "database"
    if "/reset_application_data/" in path or name.startswith(
        (
            "test_seed",
            "test_bootstrap",
            "test_provision",
            "test_fullstack_runner",
            "test_python_file_size",
        )
    ):
        return "scripts"
    if "/rbac/" in path or name.startswith(
        ("test_auth", "test_security", "test_user", "test_invitation", "test_supabase")
    ):
        return "security"
    return "api"


def frontend_section(path: str) -> str | None:
    parts = Path(path).parts
    for layer in FRONTEND_LAYERS:
        if layer in parts:
            index = parts.index(layer) + 1
            if index < len(parts) and parts[index] == "comms":
                return "sample"
            if index < len(parts) and parts[index] in SECTIONS["frontend"]:
                return parts[index]
    return None


def affected_sections(project: str, paths: list[str]) -> set[str]:
    """Explicit dependencies, with broad fallback for shared or unknown code."""
    all_sections = set(SECTIONS[project])
    selected: set[str] = set()
    for path in paths:
        if path.startswith("docs/") or path.endswith(".md"):
            continue
        if path.startswith(
            (
                ".github/",
                "infra/",
                "supabase/",
                "contracts/",
                "backend/migrations/",
                "scripts/test",
            )
        ) or path in {".env.example", ".dockerignore"}:
            return all_sections
        if path.startswith(f"{project}/tests/"):
            if project == "backend" and Path(path).name.startswith("test_"):
                selected.add(backend_section(path))
            elif (
                project == "frontend"
                and path.endswith(".spec.ts")
                and (section := frontend_section(path))
            ):
                selected.add(section)
            else:
                return all_sections
            continue
        if path.startswith("backend/app/"):
            if "/systems/" not in path or path.endswith("/models.py"):
                return all_sections
            system = path.split("/systems/", 1)[1].split("/", 1)[0]
            if project == "backend":
                if system in {"auth", "users", "roles"}:
                    selected.update(("security", "audit", "api"))
                elif system == "audit":
                    selected.update(("audit", "api"))
                elif system in {
                    "departments",
                    "modules",
                    "fields",
                    "records",
                    "relationships",
                    "lifecycle",
                }:
                    selected.update(("api", "audit", "database", "security"))
                else:
                    return all_sections
            else:
                # Backend contracts can affect the BFF, session boundary and
                # workspace entry points. Keep a conservative cross-stack batch.
                return all_sections
            continue
        if project == "backend":
            if path.startswith("backend/"):
                return all_sections
            continue
        if path.startswith("frontend/src/"):
            if "/components/sample/" in path or "/app/(app)/(workspace)/" in path:
                # Shared people, permissions and state connect every sample
                # pillar, including the canvas interaction suite.
                selected.update(("sample", "sandbox"))
            elif "/sandbox/" in path or "/lib/sandbox" in path:
                selected.update(("sample", "sandbox"))
            elif any(
                route in path
                for route in (
                    "/app/(app)/departments/",
                    "/app/(app)/modules/",
                    "/app/(app)/administration/",
                    "/app/(app)/settings/workspace/",
                    "/app/(app)/onboarding/",
                    "/app/(app)/workspace/",
                )
            ):
                selected.update(("sample", "shell"))
            elif "/app/login/" in path or "/app/auth/" in path or "/app/setup/" in path:
                selected.update(("security", "public"))
            else:
                return all_sections
        elif path.startswith("frontend/"):
            return all_sections
    return selected


def select_files(root: Path, project: str, sections: set[str], layer: str) -> list[str]:
    directory = root / project
    if project == "backend":
        files = (
            path
            for path in (directory / "tests").rglob("test_*.py")
            if backend_section(path.relative_to(directory).as_posix()) in sections
        )
    else:
        layers = FRONTEND_LAYERS if layer == "all" else (layer,)
        files = (
            path
            for group in layers
            for path in (directory / "tests" / group).rglob("*.spec.ts")
            if frontend_section(path.relative_to(directory).as_posix()) in sections
        )
    return sorted(path.relative_to(directory).as_posix() for path in files)


def changed_files(root: Path, base: str | None) -> list[str]:
    commands = [
        ["git", "diff", "--name-only", "-z", "HEAD"],
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    ]
    if base:
        # Resolve before use so a ref cannot be interpreted as a Git option.
        resolved = (
            subprocess.check_output(
                [
                    "git",
                    "rev-parse",
                    "--verify",
                    "--end-of-options",
                    f"{base}^{{commit}}",
                ],
                cwd=root,
            )
            .decode()
            .strip()
        )
        commands.append(["git", "diff", "--name-only", "-z", f"{resolved}...HEAD"])
    paths: set[str] = set()
    for command in commands:
        paths.update(
            filter(
                None, subprocess.check_output(command, cwd=root).decode().split("\0")
            )
        )
    return sorted(paths)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", choices=SECTIONS)
    parser.add_argument("mode", choices=("section", "affected", "full"))
    parser.add_argument("sections", nargs="*", help="Section names (section mode only)")
    parser.add_argument(
        "--layer",
        choices=("isolated", "integration", "http", "browser", "all"),
        default="all",
    )
    parser.add_argument(
        "--base",
        help="Include branch changes since this Git ref, plus uncommitted changes",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Show selection without starting tests or services",
    )
    parser.add_argument("--match", help="Focused pytest name expression or Playwright title regex")
    parser.add_argument("--browser", choices=("chromium", "mobile-chromium", "all"),
                        help="Local browser batch target (default: chromium)")
    parser.add_argument("--interactive", action="store_true",
                        help="Keep a disposable backend batch stack until quit or EOF")
    args = parser.parse_args()
    if args.mode == "full" and (args.match or args.browser or args.interactive):
        parser.error("local filters are not accepted by full mode")
    if args.browser and (args.project != "frontend" or args.layer not in {"all", "browser"}):
        parser.error("--browser requires the frontend browser or all layer")
    if args.interactive and (args.project != "backend" or args.layer == "isolated"):
        parser.error("--interactive requires a backend integration or all batch")
    valid_layers = (
        {"isolated", "integration", "all"}
        if args.project == "backend"
        else {"isolated", "http", "browser", "all"}
    )
    if args.layer not in valid_layers:
        parser.error(
            f"{args.project} supports layers: {', '.join(sorted(valid_layers))}"
        )
    if args.mode == "section" and not args.sections:
        parser.error(f"choose sections: {', '.join(SECTIONS[args.project])}")
    if args.mode != "section" and args.sections:
        parser.error("section names apply only to section mode")
    if args.base and args.mode != "affected":
        parser.error("--base applies only to affected mode")
    invalid = set(args.sections) - set(SECTIONS[args.project])
    if invalid:
        parser.error(f"unknown section: {', '.join(sorted(invalid))}")
    root = Path(__file__).resolve().parents[1]
    try:
        sections = (
            affected_sections(args.project, changed_files(root, args.base))
            if args.mode == "affected"
            else set(args.sections or SECTIONS[args.project])
        )
    except subprocess.CalledProcessError:
        parser.exit(
            2, "Cannot determine changes; no tests were run. Check the Git base.\n"
        )
    files = select_files(root, args.project, sections, args.layer)
    print(
        f"{args.project}: sections={','.join(sorted(sections)) or 'none'} layer={args.layer}",
        flush=True,
    )
    if not files:
        print("No tests selected for these changes/sections and this layer.")
        return 0
    if args.project == "frontend" and args.mode != "full":
        print(f"browser target={args.browser or 'chromium'}; focused batch, not a full gate",
              flush=True)
    if args.match:
        print(f"case filter={args.match}", flush=True)
    if args.list:
        print("\n".join(files))
        print(f"{len(files)} test files; selection only, no tests executed.")
        return 0
    env = os.environ.copy()
    if args.project == "backend" and args.mode != "full" and args.layer != "isolated":
        command = ["uv", "run", "python", "-m", "tests.fullstack_runner",
                   "--backend-batch", f"--layer={args.layer}"]
        if args.interactive:
            command.append("--interactive")
        if args.match:
            command.append(f"--match={args.match}")
    elif args.project == "backend":
        command = ["uv", "run", "pytest"]
        if args.mode != "full" or args.layer != "all":
            command += ["--no-cov", "-x"]
        if args.match:
            command += ["-k", args.match]
        if args.layer != "all":
            command += [
                "-m",
                "not integration" if args.layer == "isolated" else "integration",
            ]
    else:
        env["TEST_LAYER"] = args.layer
        env["BASE_URL"] = "http://127.0.0.1:3104"
        env["PLAYWRIGHT_CONFIGURATION"] = "synthetic"
        command = ["node", "scripts/run-playwright.mjs"]
        if args.mode != "full":
            command += ["--max-failures=1", "--reporter=line"]
            if args.browser != "all":
                projects = [group for group in ("isolated", "http")
                            if args.layer in {"all", group}]
                if args.layer in {"all", "browser"}:
                    projects.append(args.browser or "chromium")
                command += [f"--project={project}" for project in projects]
        if args.match:
            command.append(f"--grep={args.match}")
    return subprocess.call([*command, *files], cwd=root / args.project, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
