"""Storage cleanup uncertainty halts queue execution without reaching the engine."""

from unittest.mock import Mock

import pytest

from app.systems.platform.files import providers, scan_processing


@pytest.mark.parametrize("finish_fails", [False, True])
def test_uncertain_download_finishes_unavailable_then_halts(monkeypatch, finish_fails):
    uncertain = getattr(providers, "StorageCleanupUncertain", providers.ProviderUnavailable)
    storage, scanner, db = Mock(), Mock(), Mock()
    storage.download.side_effect = uncertain("cleanup unresolved")
    monkeypatch.setattr(scan_processing, "require_resolved_engine", Mock())
    monkeypatch.setattr(scan_processing, "claim_next", Mock(return_value=Mock()))
    finish = Mock(side_effect=RuntimeError("database unavailable") if finish_fails else None)
    monkeypatch.setattr(scan_processing, "finish_attempt", finish)
    with pytest.raises(scan_processing.WorkerHalted):
        scan_processing.process_next(db, storage, scanner)
    assert finish.call_args.kwargs == {"failure": "scan_unavailable"}
    scanner.scan.assert_not_called()
