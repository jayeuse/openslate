#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
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
        raise SystemExit(f"Missing file: {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {path}: {exc}")


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

    graph = {
        item.get("id"): item.get("depends_on", [])
        for item in tasks
        if item.get("id")
    }
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


def check_workspace(root: Path) -> list[str]:
    """Return setup failures without exposing configuration contents."""
    failures: list[str] = []
    required = (
        "AGENTS.md",
        ".agents/orchestration/PROTOCOL.md",
        ".agents/orchestration/RUN.md",
    )
    for relative in required:
        path = root / relative
        if not path.is_file() or not path.read_text().strip():
            failures.append(f"Missing or empty workflow asset: {relative}")

    guide = root / "AGENTS.md"
    if not guide.is_file():
        return failures
    instructions = guide.read_text()
    roles = set()
    for line in instructions.splitlines():
        if line.startswith("| "):
            roles.update(re.findall(r"`([a-z]+(?:-[a-z]+)*)`", line))
    roles.update(re.findall(r"`((?:architect|security|debug)-deep)`", instructions))
    if not roles:
        failures.append("No worker roles found in the root routing table")

    directory = root / ".codex/agents"
    for role in sorted(roles):
        if not (directory / f"{role}.toml").is_file():
            failures.append(f"Missing routed worker: {role}")

    workers = sorted(directory.glob("*.toml"))
    if not workers:
        failures.append("No local worker configurations found")
    for path in workers:
        try:
            worker = tomllib.loads(path.read_text())
        except (OSError, UnicodeError, tomllib.TOMLDecodeError):
            failures.append(f"Cannot parse worker configuration: {path.name}")
            continue
        if worker.get("name") != path.stem:
            failures.append(f"Worker name does not match filename: {path.name}")
        for field in ("model", "model_reasoning_effort", "developer_instructions"):
            if not isinstance(worker.get(field), str) or not worker[field].strip():
                failures.append(f"Missing worker {field}: {path.name}")
        agents = worker.get("agents")
        if not isinstance(agents, dict) or agents.get("enabled") is not False:
            failures.append(f"Worker must disable delegation: {path.name}")
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
