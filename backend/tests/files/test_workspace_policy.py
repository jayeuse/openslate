"""Record-attachment authorization uses the authoritative workspace policy."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.platform.files import access, scan_processing, scan_queue, service
from app.systems.platform.files.scan_processing import ScanClaim

NOW = datetime(2026, 9, 23, tzinfo=UTC)


def _actor(*, role: str = "member") -> User:
    return User(
        id=uuid4(),
        role=role,
        status="active",
        is_deleted=False,
    )


def _database(module_id: object | None) -> SimpleNamespace:
    record = None if module_id is None else SimpleNamespace(module_id=module_id)
    return SimpleNamespace(get=lambda _model, _id: record)


@pytest.mark.parametrize(
    ("granted", "write", "status"),
    [
        (AccessLevel.READ, False, None),
        (AccessLevel.WRITE, True, None),
        (AccessLevel.READ, True, 403),
        (None, False, 404),
    ],
    ids=["read", "write", "read-only-write", "hidden-module"],
)
def test_record_attachment_follows_the_record_module_level(
    monkeypatch: pytest.MonkeyPatch,
    granted: AccessLevel | None,
    write: bool,
    status: int | None,
) -> None:
    actor = _actor()
    module_id = uuid4()
    calls: list[object] = []

    def module_level(_db: object, user: User, requested: object) -> AccessLevel | None:
        calls.append((user, requested))
        return granted

    monkeypatch.setattr(access, "module_level", module_level)
    database = _database(module_id)

    if status is None:
        assert (
            access.authorize(database, actor, "record_attachment", write=write, record_id=uuid4())
            is actor
        )
    else:
        with pytest.raises(HTTPException) as denied:
            access.authorize(database, actor, "record_attachment", write=write, record_id=uuid4())
        assert denied.value.status_code == status
    assert calls == [(actor, module_id)]


def test_record_attachment_for_a_missing_record_is_not_found() -> None:
    with pytest.raises(HTTPException) as missing:
        access.authorize(_database(None), _actor(), "record_attachment", record_id=uuid4())

    assert missing.value.status_code == 404


def test_library_document_and_workspace_logo_are_administrator_only() -> None:
    admin = _actor(role="admin")

    assert access.authorize(None, admin, "library_document") is admin  # type: ignore[arg-type]
    assert access.authorize(None, admin, "workspace_logo", write=True) is admin  # type: ignore[arg-type]
    with pytest.raises(HTTPException) as denied:
        access.authorize(None, _actor(), "library_document")  # type: ignore[arg-type]
    assert denied.value.status_code == 403


@pytest.mark.parametrize(
    ("operation", "kwargs"),
    [
        (service.upload, {"content": b"bytes", "storage": object()}),
        (scan_queue.request_scan, {}),
    ],
    ids=["upload", "scan-request"],
)
def test_attachment_mutations_authorize_before_the_file_lock(
    monkeypatch: pytest.MonkeyPatch, operation, kwargs
):
    actor = _actor()
    events: list[str] = []
    candidate = type("Candidate", (), {"purpose": "record_attachment"})()

    class StopAtFileLock(Exception):
        pass

    def load(_db, _file_id, **load_kwargs):
        events.append("file-lock" if load_kwargs.get("lock") else "file-read")
        if load_kwargs.get("lock"):
            raise StopAtFileLock
        return candidate

    def authorize_contextual_file(_db, _user, file, *, board_id=None, write=False):
        assert file.purpose == "record_attachment" and board_id is None and write is True
        events.append("policy")
        return actor

    monkeypatch.setattr(service if operation is service.upload else scan_queue, "load", load)
    monkeypatch.setattr(
        service if operation is service.upload else scan_queue, "fresh_user", lambda _db, _id: actor
    )
    monkeypatch.setattr(
        service if operation is service.upload else scan_queue,
        "authorize_contextual_file",
        authorize_contextual_file,
    )

    with pytest.raises(StopAtFileLock):
        operation(object(), actor.id, uuid4(), **kwargs)

    assert events == ["file-read", "policy", "file-lock"]


def test_claim_next_suspends_only_deliberate_policy_denial(monkeypatch: pytest.MonkeyPatch):
    actor = _actor()
    candidate = SimpleNamespace(
        id=uuid4(), scan_requested_by=actor.id, purpose="record_attachment", board_id=None
    )
    locked = SimpleNamespace(
        state="pending_scan",
        operation_id=None,
        failure_code=None,
        scan_next_attempt_at=NOW,
        operation_expires_at=None,
    )
    database = SimpleNamespace(
        info={}, scalar=lambda _statement: candidate, rollback=lambda: None, commit=lambda: None
    )
    monkeypatch.setattr(scan_processing, "fresh_user", lambda _db, _id: actor)
    monkeypatch.setattr(
        scan_processing,
        "authorize_contextual_file",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPException(status_code=403)),
    )
    monkeypatch.setattr(scan_processing, "load", lambda *_args, **_kwargs: locked)

    assert scan_processing.claim_next(database, NOW) is None
    assert locked.failure_code == "scan_suspended"
    assert locked.scan_next_attempt_at is None


def test_claim_next_propagates_policy_unavailability_without_suspending(
    monkeypatch: pytest.MonkeyPatch,
):
    actor = _actor()
    candidate = SimpleNamespace(
        id=uuid4(), scan_requested_by=actor.id, purpose="record_attachment", board_id=None
    )
    rollbacks: list[str] = []
    database = SimpleNamespace(
        info={},
        scalar=lambda _statement: candidate,
        rollback=lambda: rollbacks.append("rollback"),
    )
    monkeypatch.setattr(scan_processing, "fresh_user", lambda _db, _id: actor)
    monkeypatch.setattr(
        scan_processing,
        "authorize_contextual_file",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPException(status_code=503)),
    )
    monkeypatch.setattr(
        scan_processing,
        "load",
        lambda *_args, **_kwargs: pytest.fail(
            "unavailable policy must not lock or suspend the file"
        ),
    )

    with pytest.raises(HTTPException) as unavailable:
        scan_processing.claim_next(database, NOW)

    assert unavailable.value.status_code == 503
    assert rollbacks == ["rollback"]


def _claim() -> ScanClaim:
    return ScanClaim(
        file_id=uuid4(),
        operation_id=uuid4(),
        requester_id=uuid4(),
        key="attachment",
        digest="digest",
        size=1,
    )


def test_finish_attempt_suspends_only_deliberate_policy_denial(monkeypatch: pytest.MonkeyPatch):
    claim = _claim()
    candidate = SimpleNamespace(purpose="record_attachment", board_id=None)
    locked = SimpleNamespace(
        state="pending_scan",
        operation_id=claim.operation_id,
        operation_expires_at=NOW + timedelta(minutes=1),
        digest=claim.digest,
        object_key=claim.key,
        actual_size=claim.size,
        scan_requested_by=claim.requester_id,
        failure_code=None,
        scan_next_attempt_at=NOW,
    )
    calls = 0

    def load(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return candidate if calls == 1 else locked

    database = SimpleNamespace(info={}, rollback=lambda: None, commit=lambda: None)
    monkeypatch.setattr(scan_processing, "load", load)
    monkeypatch.setattr(scan_processing, "fresh_user", lambda _db, _id: _actor())
    monkeypatch.setattr(
        scan_processing,
        "authorize_contextual_file",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPException(status_code=403)),
    )

    scan_processing.finish_attempt(database, claim, NOW)

    assert locked.failure_code == "scan_suspended"
    assert locked.scan_next_attempt_at is None


def test_finish_attempt_propagates_policy_unavailability_without_suspending(
    monkeypatch: pytest.MonkeyPatch,
):
    claim = _claim()
    candidate = SimpleNamespace(purpose="record_attachment", board_id=None)
    rollbacks: list[str] = []
    database = SimpleNamespace(info={}, rollback=lambda: rollbacks.append("rollback"))
    monkeypatch.setattr(scan_processing, "load", lambda *_args, **_kwargs: candidate)
    monkeypatch.setattr(scan_processing, "fresh_user", lambda _db, _id: _actor())
    monkeypatch.setattr(
        scan_processing,
        "authorize_contextual_file",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPException(status_code=503)),
    )

    with pytest.raises(HTTPException) as unavailable:
        scan_processing.finish_attempt(database, claim, NOW)

    assert unavailable.value.status_code == 503
    assert rollbacks == ["rollback"]
