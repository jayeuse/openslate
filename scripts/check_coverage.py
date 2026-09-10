"""Enforce overall and changed executable-line coverage from current source reports."""

import argparse
import json
import math
import os
import re
import subprocess
from pathlib import Path

THRESHOLD = 90


def git(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=root, text=True, capture_output=True, check=False
    )
    if result.returncode:
        raise ValueError(f"Cannot resolve coverage base or diff: {result.stderr.strip()}")
    return result.stdout


def source_inventory(root: Path, project: str) -> set[str]:
    folder = root / project / ("app" if project == "backend" else "src")
    return {
        file.relative_to(root).as_posix()
        for file in folder.rglob("*")
        if file.is_file()
        and (
            file.suffix == ".py"
            if project == "backend"
            else file.suffix in {".ts", ".tsx"} and not file.name.endswith(".d.ts")
        )
    }


def canonical_path(root: Path, project: str, value: str) -> str:
    path = Path(value)
    if not path.is_absolute():
        path = root / path if path.parts[0] == project else root / project / path
    try:
        canonical = path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise ValueError(f"Coverage source outside repository: {value}") from error
    prefix = f"{project}/{'app' if project == 'backend' else 'src'}/"
    if not canonical.startswith(prefix):
        raise ValueError(f"Coverage source outside {prefix}: {value}")
    return canonical


def line_set(values: list, limit: int) -> set[int]:
    if any(type(line) is not int or line < 1 or line > limit for line in values):
        raise ValueError("Invalid or stale executable line location")
    if len(set(values)) != len(values):
        raise ValueError("Duplicate executable line locations")
    return set(values)


def read_lines(root: Path, project: str, report: Path) -> dict[str, tuple[set[int], set[int]]]:
    document = json.loads(report.read_text())
    files = document["files"] if project == "backend" else document
    result = {}
    for name, entry in files.items():
        canonical = canonical_path(root, project, name)
        if canonical in result:
            raise ValueError(f"Duplicate coverage identity: {canonical}")
        if not (root / canonical).is_file():
            raise ValueError(f"Stale coverage source: {canonical}")
        limit = len((root / canonical).read_text().splitlines())
        if project == "backend":
            covered = line_set(entry["executed_lines"], limit)
            missing = line_set(entry["missing_lines"], limit)
            if covered & missing:
                raise ValueError(f"Covered and missing lines overlap: {canonical}")
        else:
            statements, hits = entry["statementMap"], entry["s"]
            if set(statements) != set(hits):
                raise ValueError(f"Incomplete statement counts: {canonical}")
            counts = {}
            for identifier, statement in statements.items():
                line = statement["start"]["line"]
                line_set([line], limit)
                count = hits[identifier]
                if type(count) not in (int, float) or not math.isfinite(count) or count < 0:
                    raise ValueError(f"Invalid execution count: {canonical}")
                counts[line] = max(counts.get(line, 0), count)
            covered = {line for line, count in counts.items() if count > 0}
            missing = set(counts) - covered
        result[canonical] = (covered, missing)
    expected = source_inventory(root, project)
    if expected - result.keys():
        raise ValueError(
            "Missing coverage for source: " + ", ".join(sorted(expected - result.keys()))
        )
    if result.keys() - expected:
        raise ValueError("Coverage includes files outside executable source inventory")
    return result


def changed_lines(root: Path, base: str, files: set[str]) -> tuple[str, dict[str, set[int]]]:
    if not base:
        raise ValueError("A coverage base reference is required")
    revision = git(root, "rev-parse", "--verify", f"{base}^{{commit}}").strip()
    result = {}
    for name in sorted(files):
        exists = (
            subprocess.run(
                ["git", "cat-file", "-e", f"{revision}:{name}"],
                cwd=root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode
            == 0
        )
        if not exists:
            result[name] = set(range(1, len((root / name).read_text().splitlines()) + 1))
            continue
        difference = git(
            root, "diff", "--no-ext-diff", "--no-renames", "--unified=0", revision, "--", name
        )
        lines = set()
        for match in re.finditer(r"^@@ .* \+(\d+)(?:,(\d+))? @@", difference, re.MULTILINE):
            start = int(match[1])
            count = int(match[2]) if match[2] is not None else 1
            lines.update(range(start, start + count))
        result[name] = lines
    return revision, result


def metric(covered: int, total: int) -> dict:
    return {"covered": covered, "total": total, "percent": covered * 100 / total if total else None}


def evaluate(root: Path, project: str, report: Path, base: str) -> dict:
    lines = read_lines(root, project, report)
    revision, changed = changed_lines(root, base, set(lines))
    files = []
    covered_total = executable_total = changed_covered = changed_total = 0
    for name, (covered, missing) in sorted(lines.items()):
        executable = covered | missing
        touched = executable & changed[name]
        covered_total += len(covered)
        executable_total += len(executable)
        changed_covered += len(touched & covered)
        changed_total += len(touched)
        files.append(
            {
                "path": name,
                "overall": metric(len(covered), len(executable)),
                "uncovered": sorted(missing),
                "changed_total": len(touched),
                "changed_uncovered": sorted(touched & missing),
            }
        )
    if executable_total == 0:
        raise ValueError("No executable source measured")
    overall = metric(covered_total, executable_total)
    changed_metric = metric(changed_covered, changed_total)
    return {
        "project": project,
        "base_revision": revision,
        "head_revision": git(root, "rev-parse", "HEAD").strip(),
        "threshold": THRESHOLD,
        "overall": overall,
        "changed": changed_metric,
        "changed_status": "measured"
        if changed_total
        else "N/A: no changed executable production lines",
        "non_executable_files": [name for name, (yes, no) in sorted(lines.items()) if not yes | no],
        "passed": covered_total * 100 >= THRESHOLD * executable_total
        and (not changed_total or changed_covered * 100 >= THRESHOLD * changed_total),
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", choices=("backend", "frontend"), required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--base-ref", default=os.getenv("COVERAGE_BASE_REF"))
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    try:
        result = evaluate(
            Path(__file__).resolve().parents[1],
            arguments.project,
            arguments.report,
            arguments.base_ref,
        )
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        return 1
    serialized = json.dumps(result, indent=2)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(serialized + "\n")
    print(serialized)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
