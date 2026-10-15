"""Optional native mutation lane; historical seeds are not fresh mutation evidence."""

import copy
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = (
    Path(os.environ["GITHUB_WORKSPACE"])
    if os.environ.get("GITHUB_WORKSPACE")
    else Path(__file__).resolve().parents[1]
)
BACKEND = ROOT / "backend"
BASELINE = ROOT / "docs/plans/mutation-baseline.json"
OUTPUT = BACKEND / "test-results/mutation-scheduled"


def base(data, state):
    return state.get("last_success") or data["selection_revision"]


def retirement_verified(module, original, candidate):
    if not original:
        return False
    path = "backend/" + module
    try:
        before = json.loads(
            subprocess.check_output(
                ["git", "show", f"{original}:docs/plans/mutation-baseline.json"],
                cwd=ROOT,
                text=True,
            )
        )["modules"]
        after = json.loads(
            subprocess.check_output(
                ["git", "show", f"{candidate}:docs/plans/mutation-baseline.json"],
                cwd=ROOT,
                text=True,
            )
        )["modules"]
        old_source = subprocess.check_output(
            ["git", "ls-tree", "--name-only", original, "--", path], cwd=ROOT, text=True
        ).splitlines()
        new_source = subprocess.check_output(
            ["git", "ls-tree", "--name-only", candidate, "--", path], cwd=ROOT, text=True
        ).splitlines()
        return (
            isinstance(before, dict)
            and isinstance(after, dict)
            and module in before
            and path in old_source
            and module not in after
            and path not in new_source
        )
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError, TypeError):
        return False  # Absence is not proof when the original or candidate cannot be read.


def select(data, state, sha, changed):
    terminal = state.get("precomparison_failure")
    recover = terminal and terminal["revision"] == state.get("cycle") and sha != state["cycle"]
    if (state.get("pending") or terminal) and not recover:
        return state  # Finish this exact cycle, never reuse completed work at another SHA.
    modules = data["modules"]
    failures = dict(state.get("failures", {}))
    unfinished = set(state.get("pending", [])) if recover else set()
    retirements = {}
    for path in sorted(set(failures) | unfinished):
        failure = failures.get(path)
        revision = failure.get("revision") if failure is not None else state.get("cycle")
        if path not in modules and retirement_verified(path, revision, sha):
            retirements[path] = copy.deepcopy(
                dict(
                    module=path,
                    original_revision=revision,
                    retirement_revision=sha,
                    failure=failure,
                    unfinished=path in unfinished,
                )
            )
            failures.pop(path, None)
    recorded = set(modules) | {p for entry in modules.values() for p in entry["owners"]}
    recorded |= set(data.get("zero_hit_excluded", []))
    recorded |= set(retirements)
    recorded |= {
        receipt["module"]
        for receipt in state.get("retirement_receipts", [])
        if receipt["retirement_revision"] == sha
        or (
            receipt["module"] not in modules
            and retirement_verified(receipt["module"], receipt["original_revision"], sha)
        )
    }
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
    modes.update({p: "full" for p in failures if p in modules})
    if recover:
        for path in state["pending"]:
            if path in retirements:
                continue
            modes.setdefault(path, state["modes"][path])
    if not state.get("last_success"):
        for path, entry in modules.items():
            if entry["baseline"] and entry["baseline"]["survivors"]:
                modes.setdefault(path, "rescan")
    result = dict(
        state, cycle=sha, modes=modes, pending=sorted(modes), results={}, failures=failures
    )
    if retirements:
        result["retirement_receipts"] = [
            *state.get("retirement_receipts", []),
            *retirements.values(),
        ]
    if recover:
        receipt = copy.deepcopy(
            {key: value for key, value in state.items() if key != "precomparison_receipts"}
        )
        result["precomparison_receipts"] = [*state.get("precomparison_receipts", []), receipt]
        result.pop("precomparison_failure")
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
    if (
        not state["pending"]
        and not state["failures"]
        and not state.get("notes")
        and not state.get("precomparison_failure")
    ):
        state["last_success"] = state["cycle"]


def pre_failure(state, stage, exit_code, revision, module=None):
    if stage not in ("python", "uv", "sync", "prepare") or exit_code == 0:
        raise ValueError("only terminal dependency setup or preparation failures may be marked")
    if not state.get("pending") or state["cycle"] != revision:
        raise ValueError("pre-comparison failure must belong to pending work at the exact cycle")
    if module is not None and module not in state["pending"]:
        raise ValueError("failed preparation module must be pending")
    state.setdefault(
        "precomparison_failure",
        dict(stage=stage, exit_code=exit_code, revision=revision, module=module),
    )


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
    if command not in ("plan", "prepare", "compare", "pre-failure"):
        raise ValueError(
            "use plan, prepare MODULE, compare MODULE EXIT_CODE, "
            "or pre-failure STAGE EXIT_CODE [MODULE]"
        )
    OUTPUT.mkdir(parents=True, exist_ok=True)
    checkpoint = OUTPUT / "state.json"
    state = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if command == "pre-failure":
        stage, code, *module = args
        pre_failure(state, stage, int(code), sha, *module)
        checkpoint.write_text(json.dumps(state, indent=2) + "\n")
        return  # Does not depend on a working manifest, helper or installed environment.
    data = json.loads(BASELINE.read_text())
    if command == "plan":
        diff = ["git", "diff", "--name-only", "--no-renames", base(data, state), sha]
        changed = subprocess.check_output(diff, cwd=ROOT, text=True).splitlines()
        state = select(data, state, sha, changed)
    else:
        module = args[0]
        if module not in state["pending"] or state["cycle"] != sha:
            raise ValueError("module must be pending at the exact tested cycle revision")
        try:
            root = prepare(state, module)
        except (Exception, SystemExit):
            pre_failure(state, "prepare", 1, sha, module)
            checkpoint.write_text(json.dumps(state, indent=2) + "\n")
            raise  # Only this preparation boundary, not comparison or reporting errors.
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
