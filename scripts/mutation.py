"""Optional native mutation lane; historical seeds are not fresh mutation evidence."""

import json
import re
import runpy
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
BASELINE = ROOT / "docs/plans/mutation-baseline.json"
OUTPUT = BACKEND / "test-results/mutation-scheduled"


def base(data, state):
    return state.get("last_success") or data["selection_revision"]


def select(data, state, sha, changed):
    if state.get("pending"):
        return state  # Finish this exact cycle, never reuse completed work at another SHA.
    modules = data["modules"]
    recorded = set(modules) | {p for entry in modules.values() for p in entry["owners"]}
    recorded |= set(data.get("zero_hit_excluded", []))
    notes = []
    for path in changed:
        if path.startswith(("backend/app/", "backend/operations/sample/", "backend/tests/")):
            if path.endswith(".py") and path.removeprefix("backend/") not in recorded:
                kind = "test" if path.startswith("backend/tests/") else "source"
                notes.append(f"unmapped {kind}: {path}")
    modes = {
        p: "full"
        for p, entry in modules.items()
        if any("backend/" + f in changed for f in [p, *entry["owners"]])
    }
    modes.update({p: "full" for p in state.get("failures", {}) if p in modules})
    if not state.get("last_success"):
        for path, entry in modules.items():
            if entry["baseline"] and entry["baseline"]["survivors"]:
                modes.setdefault(path, "rescan")
    result = dict(state, cycle=sha, modes=modes, pending=sorted(modes), results={})
    result["notes"] = notes
    result.setdefault("last_success", None)
    result.setdefault("failures", {})
    if not modes and not result["failures"] and not notes:
        result["last_success"] = sha
    return result


def compare(codes, baseline, mode, exit_code):
    wanted = baseline["survivors"] if mode == "rescan" and baseline else list(codes)
    verdicts = {key: codes.get(key) for key in wanted}
    survivors = sorted(k for k, code in verdicts.items() if code == 0)
    killed = sum(code in (1, 3) for code in verdicts.values())
    no_tests = sorted(k for k, code in verdicts.items() if code in (5, 33))
    timeouts = sorted(k for k, code in verdicts.items() if code in (36, -24, 24, 152, 255))
    complete = bool(wanted) and exit_code == 0
    complete &= all(code in (0, 1, 3, 5, 33) for code in verdicts.values())
    complete &= not (mode == "rescan" and no_tests)
    new = sorted(set(survivors) - set(baseline["survivors"] if baseline else []))
    errors = [] if complete else ["unresolved native run"]
    if baseline is None:
        errors.append("missing baseline")
    if mode == "full" and complete and baseline and killed < baseline["killed"]:
        errors.append("killed count dropped")
    if new and baseline:
        errors.append("new survivors")
    proposal = {"killed": killed, "survivors": survivors} if baseline is None and complete else None
    result = dict(complete=complete, errors=errors, killed=killed, survivors=survivors)
    result.update(
        no_tests=no_tests, timeouts=timeouts, new_survivors=new, proposal=proposal, mode=mode
    )
    return result


def finish(state, module, result):
    result["revision"] = state["cycle"]
    state["results"][module] = result
    if result["errors"]:
        state["failures"][module] = result
    else:
        state["failures"].pop(module, None)
    if result["complete"] or result.get("settled"):
        state["pending"].remove(module)
    if not state["pending"] and not state["failures"] and not state.get("notes"):
        state["last_success"] = state["cycle"]


def prepare(state, module):
    sample = module.startswith("operations/sample/")
    filename = "sample_mutation.py" if sample else "app_mutation.py"
    helper = runpy.run_path(str(BACKEND / "tests" / filename))
    root = BACKEND / "test-results/mutation/scheduled" / module.replace("/", "__")
    root.mkdir(parents=True, exist_ok=True)
    marker = root / "cycle.txt"
    if not marker.exists() or marker.read_text() != state["cycle"]:
        shutil.rmtree(root / "mutants", ignore_errors=True)
        (root / "retried.txt").unlink(missing_ok=True)
        (root / "completed.txt").unlink(missing_ok=True)
    marker.write_text(state["cycle"])
    for name in helper["LINKED"]:
        link = root / name
        if link.is_symlink():
            link.unlink()
        link.symlink_to(BACKEND / name)
    text = (BACKEND / "pyproject.toml").read_text()
    text = helper["sample_pyproject"](text) if sample else helper["module_pyproject"](text, module)
    if sample:
        # Scheduled ownership includes controls; standalone planner runs stay narrower.
        text = text.replace('    "--ignore=tests/operations/sample/controls",\n', "")
    text = re.sub(r"^only_mutate = .*", "only_mutate = " + json.dumps([module]), text, flags=re.M)
    (root / "pyproject.toml").write_text(text)
    return root


def main():
    command, *args = sys.argv[1:]
    if command not in ("plan", "prepare", "compare"):
        raise ValueError("use plan, prepare MODULE, or compare MODULE EXIT_CODE")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    checkpoint = OUTPUT / "state.json"
    data = json.loads(BASELINE.read_text())
    state = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if command == "plan":
        diff = ["git", "diff", "--name-only", "--no-renames", base(data, state), sha]
        changed = subprocess.check_output(diff, cwd=ROOT, text=True).splitlines()
        state = select(data, state, sha, changed)
    else:
        module = args[0]
        if module not in state["pending"] or state["cycle"] != sha:
            raise ValueError("module must be pending at the exact tested cycle revision")
        root = prepare(state, module)
        if command == "prepare":
            print(root)
            return
        meta = root / "mutants" / (module + ".meta")
        codes = json.loads(meta.read_text())["exit_code_by_key"] if meta.exists() else {}
        result = compare(
            codes, data["modules"][module]["baseline"], state["modes"][module], int(args[1])
        )
        result["settled"] = int(args[1]) not in (124, 137)  # Include timeout's forced SIGKILL.
        finish(state, module, result)
    checkpoint.write_text(json.dumps(state, indent=2) + "\n")


if __name__ == "__main__":
    main()
