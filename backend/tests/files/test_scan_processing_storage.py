"""Storage cleanup uncertainty halts queue execution without reaching the engine."""

from unittest.mock import Mock
from uuid import uuid4

import pytest

from app.systems.platform.files import providers, scan_processing
from app.systems.platform.files.providers import ScanVerdict
from app.systems.platform.files.storage import LocalFilesystemStorage


def test_clean_exact_quarantine_bytes_are_promoted_before_ready_state(monkeypatch):
    content = b"exact clean bytes"
    digest = __import__("hashlib").sha256(content).hexdigest()
    claim = scan_processing.ScanClaim(uuid4(), uuid4(), uuid4(), "a" * 32, digest, len(content))
    storage, scanner, db = Mock(), Mock(), Mock()
    storage.read_quarantine.return_value = content
    scanner.scan.return_value = ScanVerdict("clean", digest, "test", "test")
    monkeypatch.setattr(scan_processing, "require_resolved_engine", Mock())
    monkeypatch.setattr(scan_processing, "claim_next", Mock(return_value=claim))
    finish = Mock()
    monkeypatch.setattr(scan_processing, "finish_attempt", finish)

    assert scan_processing.process_next(db, storage, scanner) is True
    storage.read_quarantine.assert_called_once_with(claim.key)
    storage.promote.assert_called_once_with(
        claim.key, expected_digest=claim.digest, expected_size=claim.size
    )
    finish.assert_called_once()
    assert finish.call_args.kwargs["verdict"] == scanner.scan.return_value


def test_commit_failure_after_promotion_leaves_bytes_recoverable_for_a_retry(
    monkeypatch, tmp_path
):
    content = b"exact clean bytes"
    digest = __import__("hashlib").sha256(content).hexdigest()
    claim = scan_processing.ScanClaim(uuid4(), uuid4(), uuid4(), "a" * 32, digest, len(content))
    storage = LocalFilesystemStorage(tmp_path / "private-files")
    storage.upload(claim.key, content, "application/octet-stream")
    scanner, db = Mock(), Mock()
    scanner.scan.return_value = ScanVerdict("clean", digest, "test", "test")
    monkeypatch.setattr(scan_processing, "require_resolved_engine", Mock())
    monkeypatch.setattr(scan_processing, "claim_next", Mock(return_value=claim))
    monkeypatch.setattr(
        scan_processing, "finish_attempt", Mock(side_effect=RuntimeError("db failed"))
    )
    unresolved = Mock(side_effect=scan_processing.WorkerHalted("recovery required"))
    monkeypatch.setattr(scan_processing, "mark_promotion_unresolved", unresolved)

    with pytest.raises(scan_processing.WorkerHalted, match="recovery required"):
        scan_processing.process_next(db, storage, scanner)
    unresolved.assert_called_once_with(db, claim)
    assert storage.download(claim.key) == content
    assert storage.read_quarantine(claim.key) == content

    finish = Mock()
    monkeypatch.setattr(scan_processing, "finish_attempt", finish)
    assert scan_processing.process_next(db, storage, scanner) is True
    assert finish.call_args.kwargs["verdict"].outcome == "clean"


def test_leadership_loss_after_clean_promotion_marks_recovery_required(monkeypatch, tmp_path):
    content = b"exact clean bytes"
    digest = __import__("hashlib").sha256(content).hexdigest()
    claim = scan_processing.ScanClaim(uuid4(), uuid4(), uuid4(), "a" * 32, digest, len(content))
    storage = LocalFilesystemStorage(tmp_path / "private-files")
    storage.upload(claim.key, content, "application/octet-stream")
    scanner, db = Mock(), Mock()
    scanner.scan.return_value = ScanVerdict("clean", digest, "test", "test")
    monkeypatch.setattr(scan_processing, "require_resolved_engine", Mock())
    monkeypatch.setattr(scan_processing, "claim_next", Mock(return_value=claim))
    unresolved = Mock(side_effect=scan_processing.WorkerHalted("recovery required"))
    monkeypatch.setattr(scan_processing, "mark_promotion_unresolved", unresolved)
    calls = 0

    def lose_leadership():
        nonlocal calls
        calls += 1
        if calls == 4:
            raise scan_processing.WorkerHalted("leadership lost")

    with pytest.raises(scan_processing.WorkerHalted, match="recovery required"):
        scan_processing.process_next(db, storage, scanner, verify_leader=lose_leadership)

    unresolved.assert_called_once_with(db, claim)
    assert storage.download(claim.key) == content
    assert storage.read_quarantine(claim.key) == content


def test_infected_finalization_failure_is_not_marked_as_promotion_unresolved(monkeypatch):
    content = b"infected bytes"
    digest = __import__("hashlib").sha256(content).hexdigest()
    claim = scan_processing.ScanClaim(uuid4(), uuid4(), uuid4(), "a" * 32, digest, len(content))
    storage, scanner, db = Mock(), Mock(), Mock()
    storage.read_quarantine.return_value = content
    scanner.scan.return_value = ScanVerdict("infected", digest, "test", "test")
    monkeypatch.setattr(scan_processing, "require_resolved_engine", Mock())
    monkeypatch.setattr(scan_processing, "claim_next", Mock(return_value=claim))
    monkeypatch.setattr(
        scan_processing, "finish_attempt", Mock(side_effect=RuntimeError("database unavailable"))
    )
    unresolved = Mock(side_effect=scan_processing.WorkerHalted("promotion recovery"))
    monkeypatch.setattr(scan_processing, "mark_promotion_unresolved", unresolved)

    with pytest.raises(RuntimeError, match="database unavailable"):
        scan_processing.process_next(db, storage, scanner)

    storage.promote.assert_not_called()
    unresolved.assert_not_called()


def test_mismatched_quarantine_bytes_are_rejected_without_promotion(monkeypatch):
    claim = scan_processing.ScanClaim(uuid4(), uuid4(), uuid4(), "a" * 32, "0" * 64, 5)
    storage, scanner, db = Mock(), Mock(), Mock()
    storage.read_quarantine.return_value = b"bytes"
    monkeypatch.setattr(scan_processing, "require_resolved_engine", Mock())
    monkeypatch.setattr(scan_processing, "claim_next", Mock(return_value=claim))
    finish = Mock()
    monkeypatch.setattr(scan_processing, "finish_attempt", finish)

    assert scan_processing.process_next(db, storage, scanner) is True
    storage.promote.assert_not_called()
    scanner.scan.assert_not_called()
    assert finish.call_args.kwargs == {"failure": "scan_integrity_error"}


@pytest.mark.parametrize("finish_fails", [False, True])
def test_uncertain_download_finishes_unavailable_then_halts(monkeypatch, finish_fails):
    uncertain = getattr(providers, "StorageCleanupUncertain", providers.ProviderUnavailable)
    storage, scanner, db = Mock(), Mock(), Mock()
    storage.read_quarantine.side_effect = uncertain("cleanup unresolved")
    monkeypatch.setattr(scan_processing, "require_resolved_engine", Mock())
    monkeypatch.setattr(scan_processing, "claim_next", Mock(return_value=Mock()))
    finish = Mock(side_effect=RuntimeError("database unavailable") if finish_fails else None)
    monkeypatch.setattr(scan_processing, "finish_attempt", finish)
    with pytest.raises(scan_processing.WorkerHalted):
        scan_processing.process_next(db, storage, scanner)
    assert finish.call_args.kwargs == {"failure": "scan_unavailable"}
    scanner.scan.assert_not_called()
