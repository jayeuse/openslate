"""CI shards merge into one complete coverage report before the normal gate."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from coverage import CoverageData

from tests import backend_coverage
from tests import fullstack_runner as runner
from tests.operations.runner.test_fullstack_runner import _stub_fullstack_prerequisites

JUNIT = (
    '<testsuites><testsuite tests="{tests}" failures="0" errors="0" skipped="{skipped}"/>'
    "</testsuites>"
)


def _backend(tmp_path: Path) -> Path:
    backend = tmp_path / "backend"
    (backend / "app").mkdir(parents=True)
    (backend / "app/__init__.py").write_text("")
    (backend / "app/one.py").write_text("a = 1\nb = 2\n")
    (backend / "app/two.py").write_text("c = 3\nd = 4\n")
    return backend


def _shard(backend: Path, shards: Path, group: int, total: int, lines, *, skipped: int = 0):
    folder = shards / f"backend-coverage-shard-{group}"
    folder.mkdir(parents=True)
    data = CoverageData(basename=str(folder / "coverage.data"))
    data.add_lines({str(backend / name): numbers for name, numbers in lines.items()})
    data.write()
    (folder / "pytest.xml").write_text(JUNIT.format(tests=3, skipped=skipped))
    durations = {f"tests/test_{group}.py::t": 1.0, f"tests/test_{group}.py::t[{'x' * 600}]": 1.0}
    (folder / "test-durations.json").write_text(json.dumps(durations))
    (folder / "metadata.json").write_text(
        json.dumps(
            {
                "revision": "head",
                "shard": [group, total],
                "source_hashes": backend_coverage.source_inventory(backend),
                "source_stable": True,
            }
        )
    )


@pytest.fixture
def combine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    backend = _backend(tmp_path)
    shards = tmp_path / "shards"
    monkeypatch.chdir(backend)
    monkeypatch.setattr(backend_coverage.subprocess, "check_output", lambda *_a, **_k: "head\n")
    monkeypatch.setattr(backend_coverage, "run_gate", lambda *_args: 0)
    return backend, shards


def test_combined_shards_report_every_line_and_sum_the_tests(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1, 2]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})

    assert backend_coverage.combine_backend_coverage(backend, shards, 2) == 0

    output = backend / "test-results/coverage"
    report = json.loads((output / "coverage.json").read_text())["files"]
    executed = {Path(name).name: entry["executed_lines"] for name, entry in report.items()}
    assert executed["one.py"] == [1, 2]
    assert executed["two.py"] == [1]
    metadata = json.loads((output / "metadata.json").read_text())
    assert metadata["test_counts"] == {"tests": 6, "failures": 0, "errors": 0, "skipped": 0}
    written = (output / "test-durations.json").read_text()
    assert written.count("\n") == 1
    assert json.loads(written) == {"tests/test_1.py::t": 1.0, "tests/test_2.py::t": 1.0}


def test_a_missing_shard_fails_closed(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})

    with pytest.raises(SystemExit, match="Expected 2 coverage shards"):
        backend_coverage.combine_backend_coverage(backend, shards, 2)


def test_a_skipped_test_in_any_shard_fails_the_gate(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]}, skipped=1)

    assert backend_coverage.combine_backend_coverage(backend, shards, 2) == 1


def test_a_shard_from_a_changed_source_tree_fails_the_gate(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})
    (backend / "app/two.py").write_text("c = 30\nd = 4\n")

    assert backend_coverage.combine_backend_coverage(backend, shards, 2) == 1


def test_backend_coverage_shard_passes_its_group_and_skips_the_frontend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    shards: list[tuple[int, int]] = []

    def run(command: list[str], **_kwargs: object) -> MagicMock:
        commands.append(command)
        return MagicMock()

    _stub_fullstack_prerequisites(monkeypatch, tmp_path, run)

    def coverage(_run, _backend, _private, _environment, _run_id, shard) -> int:
        shards.append(shard)
        return 0

    monkeypatch.setattr(runner, "run_backend_coverage", coverage)

    assert runner.main(["--backend-coverage-shard", "2/4"]) == 0
    assert shards == [(2, 4)]
    assert ["npm", "run", "build", "--", "--webpack"] not in commands


@pytest.mark.parametrize("shard", ["0/4", "5/4", "two/4", "2"])
def test_runner_rejects_invalid_coverage_shard_before_starting_postgres(
    monkeypatch: pytest.MonkeyPatch, shard: str
) -> None:
    start = MagicMock()
    monkeypatch.setattr(runner, "DisposablePostgres", start)

    with pytest.raises(SystemExit):
        runner.main(["--backend-coverage-shard", shard])

    start.assert_not_called()
