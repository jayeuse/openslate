"""Deployment leadership, startup recovery and polling lifetime on PostgreSQL."""

import pytest

from app.systems.files import worker
from app.systems.files.scan_processing import WorkerHalted

pytestmark = pytest.mark.integration


def test_only_one_worker_can_hold_the_deployment_leader_session(guarded_db):
    engine = guarded_db.get_bind().engine
    with worker.ScannerLeader(engine) as first:
        first.verify()
        with pytest.raises(WorkerHalted):
            with worker.ScannerLeader(engine):
                pytest.fail("Concurrent scanner worker was admitted")
        first.verify()
    with worker.ScannerLeader(engine) as replacement:
        replacement.verify()


def test_lost_leader_connection_cannot_continue_scanning(guarded_db):
    engine = guarded_db.get_bind().engine
    with worker.ScannerLeader(engine) as leader:
        leader.connection.invalidate()
        with pytest.raises(WorkerHalted):
            leader.verify()
    with worker.ScannerLeader(engine) as replacement:
        replacement.verify()


def test_cli_uncertain_execution_exits_without_restart_and_releases_leadership(
    guarded_db, monkeypatch, capsys
):
    engine = guarded_db.get_bind().engine
    monkeypatch.setattr(worker, "get_engine", lambda: engine)
    monkeypatch.setattr(worker, "get_scanner", lambda: object())
    monkeypatch.setattr(worker, "get_storage", lambda: object())
    monkeypatch.setattr("sys.argv", ["worker", "--acknowledge-engine-replacement"])
    attempted = []

    def unresolved(*args, **kwargs):
        kwargs["verify_leader"]()
        attempted.append(True)
        raise WorkerHalted("engine work uncertain")

    monkeypatch.setattr(worker, "process_next", unresolved)
    assert worker.main() == 2
    assert attempted == [True]
    assert "inspect unresolved work" in capsys.readouterr().err
    with worker.ScannerLeader(engine) as replacement:
        replacement.verify()


def test_worker_waits_thirty_seconds_on_unavailable_or_empty_queue(guarded_db, monkeypatch):
    engine = guarded_db.get_bind().engine
    monkeypatch.setattr(worker, "get_engine", lambda: engine)
    monkeypatch.setattr(worker, "get_scanner", lambda: object())
    monkeypatch.setattr(worker, "get_storage", lambda: object())
    monkeypatch.setattr("sys.argv", ["worker"])
    attempts = []
    waits = []

    def idle(*args, **kwargs):
        attempts.append(True)
        if len(attempts) > 1:
            raise KeyboardInterrupt
        return False

    monkeypatch.setattr(worker, "process_next", idle)
    monkeypatch.setattr(worker, "sleep", waits.append)
    assert worker.main() == 0
    assert waits == [30] and len(attempts) == 2
