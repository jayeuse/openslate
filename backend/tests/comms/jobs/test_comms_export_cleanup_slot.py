"""A purge that already holds its request's file slot cleans export artifacts in it (F13)."""

import hashlib
from contextlib import ExitStack
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.systems.comms.jobs import export_service
from app.systems.platform.files.providers import transfer_slot

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
    # The purge request holds one of the two slots; a background export held the other,
    # so a second slot for the artifact cleanup was refused with 503 files_busy.
    with ExitStack() as busy:
        busy.enter_context(transfer_slot())
        busy.enter_context(transfer_slot())
        assert export_service.cleanup_artifact(
            _db(), uuid4(), pending_cleanup, now=datetime.now(UTC), slot_held=True
        )
    assert pending_cleanup.objects == {}


def test_cleanup_without_a_held_slot_still_takes_its_own(pending_cleanup: Storage) -> None:
    with ExitStack() as busy:
        busy.enter_context(transfer_slot())
        busy.enter_context(transfer_slot())
        with pytest.raises(HTTPException) as refused:
            export_service.cleanup_artifact(_db(), uuid4(), pending_cleanup)
    assert refused.value.status_code == 503
    assert pending_cleanup.objects == {"artifact": CONTENT}
