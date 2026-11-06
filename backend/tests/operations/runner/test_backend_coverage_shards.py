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


def _unit_lane(backend: Path, shards: Path, lines, *, skipped: int = 0, part=(1, 1), name="unit"):
    folder = shards / f"backend-coverage-{name}"
    folder.mkdir(parents=True)
    data = CoverageData(basename=str(folder / "coverage.data"))
    data.add_lines({str(backend / name): numbers for name, numbers in lines.items()})
    data.write()
    (folder / "pytest.xml").write_text(JUNIT.format(tests=4, skipped=skipped))
    (folder / "metadata.json").write_text(
        json.dumps(
            {
                "revision": "head",
                "lane": "unit",
                "part": list(part),
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
    _unit_lane(backend, shards, {"app/two.py": [2]})

    assert backend_coverage.combine_backend_coverage(backend, shards, 2) == 0

    output = backend / "test-results/coverage"
    report = json.loads((output / "coverage.json").read_text())["files"]
    executed = {Path(name).name: entry["executed_lines"] for name, entry in report.items()}
    assert executed["one.py"] == [1, 2]
    assert executed["two.py"] == [1, 2]
    metadata = json.loads((output / "metadata.json").read_text())
    assert metadata["test_counts"] == {"tests": 10, "failures": 0, "errors": 0, "skipped": 0}
    written = (output / "test-durations.json").read_text()
    assert written.count("\n") == 1
    assert json.loads(written) == {"tests/test_1.py::t": 1.0, "tests/test_2.py::t": 1.0}


def test_a_missing_shard_fails_closed(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})

    with pytest.raises(SystemExit, match="Expected 2 coverage shards"):
        backend_coverage.combine_backend_coverage(backend, shards, 2)


def test_a_missing_unit_lane_fails_closed(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})

    with pytest.raises(SystemExit, match="Expected one unit lane"):
        backend_coverage.combine_backend_coverage(backend, shards, 2)


def test_every_unit_part_joins_the_combined_report(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1, 2]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})
    for group in (1, 2, 3):
        _unit_lane(backend, shards, {"app/two.py": [2]}, part=(group, 3), name=f"unit-{group}")

    assert backend_coverage.combine_backend_coverage(backend, shards, 2, unit_parts=3) == 0

    metadata = json.loads((backend / "test-results/coverage/metadata.json").read_text())
    assert metadata["test_counts"] == {"tests": 18, "failures": 0, "errors": 0, "skipped": 0}


def test_a_lost_unit_part_fails_closed(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})
    for group in (1, 3):
        _unit_lane(backend, shards, {"app/two.py": [2]}, part=(group, 3), name=f"unit-{group}")

    with pytest.raises(SystemExit, match=r"found \[\(1, 3\), \(3, 3\)\]"):
        backend_coverage.combine_backend_coverage(backend, shards, 2, unit_parts=3)


@pytest.mark.parametrize(
    "parts",
    [
        pytest.param([(1, 3), (2, 3), (2, 3)], id="the same part twice"),
        pytest.param([(1, 3), (2, 3), (3, 4)], id="a part of another layout"),
        pytest.param([(1, 1), (2, 3), (3, 3)], id="the local single part"),
    ],
)
def test_unit_evidence_from_another_part_fails_closed(combine, parts) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})
    for index, part in enumerate(parts):
        _unit_lane(backend, shards, {"app/two.py": [2]}, part=part, name=f"unit-{index}")

    with pytest.raises(SystemExit, match="Unexpected or duplicate unit lane evidence"):
        backend_coverage.combine_backend_coverage(backend, shards, 2, unit_parts=3)


def test_combine_writes_unit_durations_from_the_junit_reports_of_every_part(combine) -> None:
    backend, shards = combine
    (backend / "tests/area").mkdir(parents=True)
    (backend / "tests/area/test_rules.py").write_text("")
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})
    for group, report in (
        (
            1,
            '<testcase classname="tests.area.test_rules" name="test_plain" time="1.2345"/>'
            '<testcase classname="tests.area.test_rules" name="test_id[a.b/c::d]" time="2"/>',
        ),
        (
            2,
            '<testcase classname="tests.area.test_rules.TestGroup" name="test_case" time="3"/>'
            f'<testcase classname="tests.area.test_rules" name="test_id[{"x" * 600}]" time="4"/>'
            '<testcase classname="tests.gone" name="test_moved" time="5"/>',
        ),
    ):
        _unit_lane(backend, shards, {"app/two.py": [2]}, part=(group, 2), name=f"unit-{group}")
        (shards / f"backend-coverage-unit-{group}/pytest.xml").write_text(
            f'<testsuites><testsuite tests="4" failures="0" errors="0" skipped="0">{report}'
            "</testsuite></testsuites>"
        )

    assert backend_coverage.combine_backend_coverage(backend, shards, 2, unit_parts=2) == 0

    written = (backend / "test-results/coverage/unit-durations.json").read_text()
    assert written.count("\n") == 1
    assert json.loads(written) == {
        "tests/area/test_rules.py::TestGroup::test_case": 3.0,
        "tests/area/test_rules.py::test_id[a.b/c::d]": 2.0,
        "tests/area/test_rules.py::test_plain": 1.234,
    }


def test_a_skipped_test_in_the_unit_lane_fails_the_gate(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})
    _unit_lane(backend, shards, {"app/two.py": [2]}, skipped=1)

    assert backend_coverage.combine_backend_coverage(backend, shards, 2) == 1


def test_a_skipped_test_in_any_shard_fails_the_gate(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]}, skipped=1)
    _unit_lane(backend, shards, {"app/two.py": [2]})

    assert backend_coverage.combine_backend_coverage(backend, shards, 2) == 1


def test_a_shard_from_a_changed_source_tree_fails_the_gate(combine) -> None:
    backend, shards = combine
    _shard(backend, shards, 1, 2, {"app/one.py": [1]})
    _shard(backend, shards, 2, 2, {"app/two.py": [1]})
    _unit_lane(backend, shards, {"app/two.py": [2]})
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


def test_a_local_parallel_shard_writes_its_own_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Parallel shards on one checkout each cleared and wrote test-results/coverage.
    from tests.fullstack_summary import summary_path

    backend = tmp_path / "backend"
    assert backend_coverage.coverage_output(backend) == backend / "test-results/coverage"
    shard = tmp_path / "shards" / "shard-2"
    monkeypatch.setenv(backend_coverage.OUTPUT_OVERRIDE, str(shard))
    assert backend_coverage.coverage_output(backend) == shard
    assert summary_path(backend, tmp_path, batch=None, backend_only=True) == shard / "summary.json"


def test_stack_shards_run_only_integration_tests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    backend = _backend(tmp_path)
    private = tmp_path / "private"
    private.mkdir()
    monkeypatch.setenv(backend_coverage.OUTPUT_OVERRIDE, str(tmp_path / "out"))
    monkeypatch.setattr(backend_coverage.subprocess, "check_output", lambda *_a, **_k: "head\n")
    monkeypatch.setattr("tests.postgres_runtime.assert_runner_database_url", lambda *_a, **_k: None)

    def run(command, _cwd, _env):
        commands.append(command)

    environment = {"TEST_DATABASE_URL": "x", "MIGRATION_DATABASE_URL": "y"}
    with pytest.raises(RuntimeError):
        backend_coverage.run_backend_coverage(
            run, backend, private, environment, "run", shard=(1, 2)
        )

    pytest_command = next(command for command in commands if "pytest" in command)
    options = [
        pytest_command[index + 1] for index, part in enumerate(pytest_command) if part == "-m"
    ]
    assert options == ["pytest", "integration"]


@pytest.mark.parametrize(
    ("part", "split"),
    [
        pytest.param((1, 1), [], id="the local gate runs one whole lane"),
        pytest.param(
            (2, 3),
            [
                "--splits=3",
                "--group=2",
                "--splitting-algorithm=least_duration",
                "--durations-path=tests/.test_durations_unit",
            ],
            id="a CI part runs its group",
        ),
    ],
)
def test_unit_lane_runs_its_part_and_records_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, part, split
) -> None:
    commands: list[list[str]] = []
    backend = _backend(tmp_path)
    output = tmp_path / "out"
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    monkeypatch.delenv("MIGRATION_DATABASE_URL", raising=False)
    monkeypatch.setattr(backend_coverage.subprocess, "check_output", lambda *_a, **_k: "head\n")

    def run(command, **_kwargs):
        commands.append(command)
        (output / "pytest.xml").write_text(JUNIT.format(tests=2, skipped=0))
        return MagicMock(returncode=0)

    monkeypatch.setattr(backend_coverage.subprocess, "run", run)

    assert backend_coverage.run_unit_lane(backend, output, 4, part=part) == 0

    command = commands[0]
    assert [command[command.index("-m", 3) + 1], command[command.index("-n") + 1]] == [
        "not integration",
        "4",
    ]
    assert command[command.index("--dist") + 1] == "worksteal"
    assert [option for option in command if option.startswith(("--split", "--group", "--dur"))] == (
        split
    )
    assert json.loads((output / "metadata.json").read_text())["part"] == list(part)


def test_unit_lane_refuses_stack_database_urls(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("TEST_DATABASE_URL", "postgresql://example.invalid/db")

    with pytest.raises(SystemExit, match="runs without a stack"):
        backend_coverage.run_unit_lane(_backend(tmp_path), tmp_path / "out", workers=2)
