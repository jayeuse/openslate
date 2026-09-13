#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / ".agents" / "orchestration" / "task-template.json"
RUNTIME = ROOT / ".agent-runtime"

VALID_STATUSES = {
    "pending",
    "running",
    "blocked",
    "failed",
    "passed",
    "cancelled",
}


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"Missing file: {path}") from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {path}: {exc}") from exc


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def task_dir(task_id: str) -> Path:
    return RUNTIME / task_id


def cmd_init(args: argparse.Namespace) -> None:
    destination = task_dir(args.task_id)
    if destination.exists():
        raise SystemExit(f"Task already exists: {args.task_id}")

    task = load_json(TEMPLATE)
    task["id"] = args.task_id
    state = {"task_id": args.task_id, "status": "draft", "tasks": []}

    write_json(destination / "task.json", task)
    write_json(destination / "state.json", state)

    print(destination.relative_to(ROOT))
    print("Created task.json and state.json")


def cmd_status(args: argparse.Namespace) -> None:
    state = load_json(task_dir(args.task_id) / "state.json")
    print(f"{args.task_id}: {state.get('status', 'unknown')}")

    tasks = state.get("tasks", [])
    if not tasks:
        print("No planned tasks.")
        return

    width = max(len(str(item.get("id", ""))) for item in tasks)
    for item in tasks:
        task_id = str(item.get("id", "")).ljust(width)
        status = str(item.get("status", "unknown")).upper().ljust(10)
        owner = str(item.get("owner", "-"))
        title = str(item.get("title", ""))
        print(f"{task_id}  {status}  {owner:12}  {title}")


def cmd_validate(args: argparse.Namespace) -> None:
    task = load_json(task_dir(args.task_id) / "task.json")
    state = load_json(task_dir(args.task_id) / "state.json")

    errors: list[str] = []

    for field in ("id", "goal", "outcome", "non_goals", "scope", "proof", "approvals"):
        if field not in task:
            errors.append(f"task.json missing field: {field}")

    tasks = state.get("tasks")
    if not isinstance(tasks, list):
        errors.append("state.json field 'tasks' must be a list")
        tasks = []

    ids: set[str] = set()
    for index, item in enumerate(tasks):
        prefix = f"tasks[{index}]"
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            errors.append(f"{prefix} missing id")
            continue
        if item_id in ids:
            errors.append(f"duplicate task id: {item_id}")
        ids.add(item_id)

        if not item.get("owner"):
            errors.append(f"{item_id} missing owner")

        status = item.get("status")
        if status not in VALID_STATUSES:
            errors.append(f"{item_id} has invalid status: {status!r}")

        if not isinstance(item.get("depends_on", []), list):
            errors.append(f"{item_id} depends_on must be a list")

    for item in tasks:
        item_id = item.get("id")
        for dependency in item.get("depends_on", []):
            if dependency not in ids:
                errors.append(f"{item_id} depends on unknown task: {dependency}")

    graph = {item.get("id"): item.get("depends_on", []) for item in tasks if item.get("id")}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            errors.append(f"dependency cycle includes: {node}")
            return
        if node in visited:
            return
        visiting.add(node)
        for dep in graph.get(node, []):
            if dep in graph:
                visit(dep)
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node)

    if errors:
        print("INVALID")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)

    print("VALID")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage local OpenSlate agent task state.")
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="Create runtime files for a task.")
    init.add_argument("task_id")
    init.set_defaults(func=cmd_init)

    status = commands.add_parser("status", help="Show task status.")
    status.add_argument("task_id")
    status.set_defaults(func=cmd_status)

    validate = commands.add_parser("validate", help="Validate task and state structure.")
    validate.add_argument("task_id")
    validate.set_defaults(func=cmd_validate)

    doctor = commands.add_parser("doctor", help="Check local agent workflow setup.")
    doctor.set_defaults(func=cmd_doctor)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


WORKER_FIELDS = (
    "description",
    "model",
    "model_reasoning_effort",
    "developer_instructions",
)


def _read_text(path: Path) -> str | None:
    """Read text while keeping filesystem details out of diagnostics."""
    try:
        return path.read_text()
    except (OSError, UnicodeError):
        return None


def _is_file(path: Path) -> bool:
    """Return whether a path is a regular file without surfacing OS errors."""
    try:
        return path.is_file()
    except OSError:
        return False


def _worker_files(directory: Path) -> list[Path] | None:
    """Return TOML worker files, or None when the directory cannot be read."""
    try:
        if not directory.is_dir():
            return []
        return sorted(path for path in directory.iterdir() if path.suffix == ".toml")
    except OSError:
        return None


def _validate_worker(path: Path) -> list[str]:
    """Validate one worker definition without exposing its contents."""
    contents = _read_text(path)
    if contents is None:
        return [f"Cannot read worker configuration: {path.name}"]
    try:
        worker = tomllib.loads(contents)
    except tomllib.TOMLDecodeError:
        return [f"Cannot parse worker configuration: {path.name}"]

    failures: list[str] = []
    if worker.get("name") != path.stem:
        failures.append(f"Worker name does not match filename: {path.name}")
    for field in WORKER_FIELDS:
        value = worker.get(field)
        if not isinstance(value, str) or not value.strip():
            failures.append(f"Missing worker {field}: {path.name}")
    agents = worker.get("agents")
    if not isinstance(agents, dict) or agents.get("enabled") is not False:
        failures.append(f"Worker must disable delegation: {path.name}")
    return failures


def _routed_roles(instructions: str) -> set[str]:
    """Extract worker names from Markdown tables with a role column."""
    lines = instructions.splitlines()
    role_headers = {"worker", "workers", "role", "roles"}

    def cells(line: str) -> list[str] | None:
        if not line.lstrip().startswith("|"):
            return None
        return [cell.strip() for cell in line.strip().strip("|").split("|")]

    roles: set[str] = set()
    index = 0
    while index < len(lines):
        header = cells(lines[index])
        if header is None:
            index += 1
            continue
        end = index
        while end < len(lines) and cells(lines[end]) is not None:
            end += 1
        normalized = [value.strip("`").lower() for value in header]
        role_indexes = [
            position for position, value in enumerate(normalized) if value in role_headers
        ]
        if role_indexes:
            row_start = index + 1
            separator = cells(lines[row_start]) if row_start < end else None
            if (
                separator is not None
                and separator
                and all(set(value) <= {"-", ":", " "} for value in separator)
            ):
                row_start += 1
            for row in lines[row_start:end]:
                values = cells(row)
                if values is None or all(set(value) <= {"-", ":", " "} for value in values):
                    continue
                for position in role_indexes:
                    if position < len(values):
                        roles.update(re.findall(r"`([a-z]+(?:-[a-z]+)*)`", values[position]))
        index = end
    return roles


def _global_agents_directory(codex_home: Path | None) -> Path:
    """Resolve the global worker directory, allowing deterministic injection."""
    if codex_home is not None:
        return codex_home / "agents"
    configured_home = os.environ.get("CODEX_HOME")
    home = Path(configured_home) if configured_home else Path.home() / ".codex"
    return home / "agents"


def check_workspace(root: Path, codex_home: Path | None = None) -> list[str]:
    """Return setup failures without exposing configuration contents."""
    failures: list[str] = []
    required = (
        "AGENTS.md",
        ".agents/orchestration/PROTOCOL.md",
        ".agents/orchestration/RUN.md",
    )
    for relative in required:
        path = root / relative
        contents = _read_text(path) if _is_file(path) else None
        if not contents or not contents.strip():
            failures.append(f"Missing or empty workflow asset: {relative}")

    guide = root / "AGENTS.md"
    instructions = _read_text(guide) if _is_file(guide) else None
    if instructions is None:
        return failures

    roles = _routed_roles(instructions)
    if not roles:
        failures.append("No worker roles found in the root routing table")

    project_directory = root / ".codex/agents"
    project_workers = _worker_files(project_directory)
    if project_workers is None:
        failures.append("Cannot read project worker configurations")
        project_workers = []
    validated_project_paths: set[Path] = set()
    for path in project_workers:
        failures.extend(_validate_worker(path))
        validated_project_paths.add(path)

    global_directory = _global_agents_directory(codex_home)
    for role in sorted(roles):
        project_path = project_directory / f"{role}.toml"
        global_path = global_directory / f"{role}.toml"
        if _is_file(project_path):
            # A malformed project override is authoritative and must not fall
            # through to a global definition.
            if project_path not in validated_project_paths:
                failures.extend(_validate_worker(project_path))
            continue
        if not _is_file(global_path):
            failures.append(f"Missing routed worker: {role}")
            continue
        failures.extend(_validate_worker(global_path))
    return failures


def cmd_doctor(args: argparse.Namespace) -> None:
    try:
        failures = check_workspace(Path(__file__).resolve().parents[1])
    except (OSError, UnicodeError):
        print("FAIL: Cannot read required local workflow assets")
        raise SystemExit(1) from None
    for failure in failures:
        print(f"FAIL: {failure}")
    if failures:
        raise SystemExit(1)
    print("PASS: Local workflow assets, routing, and worker configuration")
    print("Application tests, runtime connectivity, and approval enforcement were not checked.")


if __name__ == "__main__":
    main()
