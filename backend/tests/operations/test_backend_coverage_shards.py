"""CI shards merge into one complete coverage report before the normal gate."""

import json
from pathlib import Path

import pytest
from coverage import CoverageData

from tests import backend_coverage

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
    (folder / "test-durations.json").write_text(json.dumps({f"tests/test_{group}.py::t": 1.0}))
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
    durations = json.loads((output / "test-durations.json").read_text())
    assert set(durations) == {"tests/test_1.py::t", "tests/test_2.py::t"}


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
