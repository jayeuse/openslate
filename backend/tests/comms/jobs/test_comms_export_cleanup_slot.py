"""A purge that already holds its request's processing slot cleans export artifacts in it (F13)."""

import hashlib
from contextlib import ExitStack
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.systems.comms.jobs import export_service
from app.systems.platform.files import providers
from app.systems.platform.files.providers import FileCapacity, file_processing

CONTENT = b"export artifact"


class Storage:
    def __init__(self) -> None:
        self.objects = {"artifact": CONTENT}

    def download(self, key: str) -> bytes | None:
        return self.objects.get(key)

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)


@pytest.fixture
def pending_cleanup(monkeypatch: pytest.MonkeyPatch) -> Storage:
    monkeypatch.setattr(providers, "_pool", FileCapacity(256 * 1024 * 1024, 2))
    job = SimpleNamespace(
        cleanup_pending=True,
        cleanup_after=None,
        artifact_key="artifact",
        artifact_size=len(CONTENT),
        artifact_sha256=hashlib.sha256(CONTENT).hexdigest(),
        artifact_upload_confirmed=True,
    )
    monkeypatch.setattr(export_service, "load", lambda *_args, **_kwargs: (job, None))
    monkeypatch.setattr(export_service, "bound_organization_column", lambda: uuid4())
    return Storage()


def _db() -> MagicMock:
    db = MagicMock()
    db.scalar.return_value = None  # The confirmed deletion is already committed.
    return db


def test_cleanup_in_the_callers_slot_finishes_while_every_other_slot_is_busy(
    pending_cleanup: Storage,
) -> None:
    # The purge request holds one slot and background work holds the rest; waiting for a
    # second slot here would wait on the purge itself.
    with ExitStack() as busy:
        busy.enter_context(file_processing(wait_seconds=0))
        busy.enter_context(file_processing(wait_seconds=0))
        assert export_service.cleanup_artifact(
            _db(), uuid4(), pending_cleanup, now=datetime.now(UTC), slot_held=True
        )
    assert pending_cleanup.objects == {}


def test_cleanup_without_a_held_slot_still_takes_its_own(
    pending_cleanup: Storage, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(providers, "PROCESSING_WAIT_SECONDS", 0.05)
    with ExitStack() as busy:
        busy.enter_context(file_processing(wait_seconds=0))
        busy.enter_context(file_processing(wait_seconds=0))
        with pytest.raises(HTTPException) as refused:
            export_service.cleanup_artifact(_db(), uuid4(), pending_cleanup)
    assert refused.value.status_code == 503
    assert pending_cleanup.objects == {"artifact": CONTENT}
