"""Uncertain probe cleanup must stop the worker before another subprocess can start."""

from contextlib import nullcontext

from app.systems.files import scan_processing, worker
from app.systems.files.providers import ScannerExecutionUncertain


def test_uncertain_probe_stops_cli_without_claiming_or_reprobing(monkeypatch, capsys):
    probes = []

    class Scanner:
        def probe(self):
            probes.append(True)
            raise ScannerExecutionUncertain("Probe client cleanup was not confirmed")

    class Leader:
        def verify(self):
            pass

    monkeypatch.setattr("sys.argv", ["worker"])
    monkeypatch.setattr(worker, "get_engine", lambda: object())
    monkeypatch.setattr(worker, "ScannerLeader", lambda engine: nullcontext(Leader()))
    monkeypatch.setattr(worker, "AuditSession", lambda engine: nullcontext(object()))
    monkeypatch.setattr(worker, "get_scanner", lambda **_: Scanner())
    monkeypatch.setattr(worker, "get_storage", lambda: object())
    monkeypatch.setattr(worker, "require_resolved_engine", lambda db: None)
    monkeypatch.setattr(scan_processing, "require_resolved_engine", lambda db: None)
    monkeypatch.setattr(worker, "expire_unused_reservations", lambda db, now: 0)

    def forbidden(*args, **kwargs):
        raise AssertionError("Uncertain probe must not sleep, retry, or claim file work")

    monkeypatch.setattr(worker, "sleep", forbidden)
    monkeypatch.setattr(scan_processing, "claim_next", forbidden)
    assert worker.main() == 2
    assert probes == [True]
    assert "inspect unresolved work" in capsys.readouterr().err
