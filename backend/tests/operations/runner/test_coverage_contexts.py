import json

from coverage import CoverageData

from tests import coverage_contexts


def test_reports_lines_that_only_one_test_executes(tmp_path) -> None:
    data = CoverageData(basename=str(tmp_path / "contexts.data"))
    source = str(tmp_path / "app.py")
    for context, lines in (
        ("tests/test_a.py::test_one|run", [1, 2, 3]),
        ("tests/test_a.py::test_one|setup", [9]),
        ("tests/test_a.py::test_two|run", [2, 3]),
        ("tests/test_b.py::test_three|run", [3, 4]),
    ):
        data.set_context(context)
        data.add_lines({source: lines})
    data.write()

    assert coverage_contexts.unique_lines(tmp_path / "contexts.data") == {
        "tests/test_a.py::test_one": 2,
        "tests/test_a.py::test_two": 0,
        "tests/test_b.py::test_three": 1,
    }

    assert coverage_contexts.main([str(tmp_path / "contexts.data")]) == 0
    written = json.loads((tmp_path / "contexts.unique.json").read_text())
    assert written["zero_unique"] == ["tests/test_a.py::test_two"]


def test_a_contexts_batch_records_per_test_coverage_then_reports(tmp_path, monkeypatch) -> None:
    from tests import backend_batches

    backend = tmp_path / "backend"
    (backend / "tests").mkdir(parents=True)
    (backend / "tests/test_area.py").write_text("def test_a():\n    assert True\n")
    (tmp_path / "private").mkdir()
    monkeypatch.setattr("tests.postgres_runtime.assert_runner_database_url", lambda *_a, **_k: None)
    batch = backend_batches.parse_batch(
        ["--backend-batch", "--contexts", "tests/test_area.py"], backend
    )
    calls = []

    backend_batches.run_backend_batches(
        lambda command, _cwd, env: calls.append((command, env)),
        backend,
        tmp_path / "private",
        {"TEST_DATABASE_URL": "x", "MIGRATION_DATABASE_URL": "y"},
        "run-1",
        batch,
    )

    (pytest_command, pytest_env), (report_command, _) = calls
    assert "--cov-context=test" in pytest_command
    assert "--no-cov" not in pytest_command
    data = backend / "test-results/contexts/run-1.data"
    assert pytest_env["COVERAGE_CORE"] == "ctrace"
    assert pytest_env["COVERAGE_FILE"] == str(data)
    assert report_command[1:] == ["tests/coverage_contexts.py", str(data)]
