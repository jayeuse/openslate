"""Record-attachment authorization uses the authoritative workspace policy."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.systems.access.users.models import Role, User
from app.systems.access.users.permissions import Capability
from app.systems.platform.files import access, scan_processing, scan_queue, service
from app.systems.platform.files.scan_processing import ScanClaim

NOW = datetime(2026, 9, 23, tzinfo=UTC)


def _actor(*, role: str = "member") -> User:
    role_row = Role(id=uuid4(), role=role, permissions={}, is_deleted=False)
    return User(
        id=uuid4(),
        role_id=role_row.id,
        role=role_row,
        status="active",
        is_deleted=False,
    )


def test_record_attachment_uses_workspace_policy_capability_snapshot(
    monkeypatch: pytest.MonkeyPatch,
):
    actor = _actor()
    database = object()
    calls: list[tuple[object, object, object, object]] = []

    def policy_authorize(
        db: object,
        *,
        actor_id: object,
        expected_role_id: object,
        capabilities: object,
    ) -> User:
        calls.append((db, actor_id, expected_role_id, capabilities))
        return actor

    monkeypatch.setattr(access, "authorize_workspace_capabilities", policy_authorize)

    assert access.authorize(database, actor, "record_attachment") is actor
    assert calls == [(database, actor.id, actor.role_id, (Capability.RECORDS_READ,))]


def test_record_attachment_write_and_administrator_still_use_policy(
    monkeypatch: pytest.MonkeyPatch,
):
    actor = _actor(role="admin")
    calls: list[tuple[Capability, ...]] = []

    def policy_authorize(_db: object, **kwargs: object) -> User:
        calls.append(kwargs["capabilities"])  # type: ignore[arg-type]
        raise HTTPException(status_code=403, detail="Forbidden")

    monkeypatch.setattr(access, "authorize_workspace_capabilities", policy_authorize)

    with pytest.raises(HTTPException) as denied:
        access.authorize(object(), actor, "record_attachment", write=True)

    assert denied.value.status_code == 403
    assert calls == [(Capability.RECORDS_WRITE,)]


def test_record_attachment_surfaces_policy_unavailability(monkeypatch: pytest.MonkeyPatch):
    actor = _actor()

    def unavailable(_db: object, **_kwargs: object) -> User:
        raise HTTPException(status_code=503, detail="Authorization unavailable")

    monkeypatch.setattr(access, "authorize_workspace_capabilities", unavailable)

    with pytest.raises(HTTPException) as unavailable_error:
        access.authorize(object(), actor, "record_attachment")

    assert unavailable_error.value.status_code == 503


def test_library_document_and_workspace_logo_keep_exact_admin_guard(
    monkeypatch: pytest.MonkeyPatch,
):
    calls: list[object] = []
    admin = _actor(role="admin")

    def policy_authorize(**kwargs: object) -> User:
        calls.append(kwargs)
        return admin

    monkeypatch.setattr(access, "authorize_workspace_capabilities", policy_authorize)

    assert access.authorize(None, admin, "library_document") is admin
    assert access.authorize(None, admin, "workspace_logo", write=True) is admin
    assert calls == []


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

    def authorize(_db, _user, purpose, *, write=False):
        assert purpose == "record_attachment" and write is True
        events.append("policy")
        return actor

    monkeypatch.setattr(service if operation is service.upload else scan_queue, "load", load)
    monkeypatch.setattr(
        service if operation is service.upload else scan_queue, "fresh_user", lambda _db, _id: actor
    )
    monkeypatch.setattr(
        service if operation is service.upload else scan_queue,
        "authorize",
        authorize,
    )

    with pytest.raises(StopAtFileLock):
        operation(object(), actor.id, uuid4(), **kwargs)

    assert events == ["file-read", "policy", "file-lock"]


def test_claim_next_suspends_only_deliberate_policy_denial(monkeypatch: pytest.MonkeyPatch):
    actor = _actor()
    candidate = SimpleNamespace(
        id=uuid4(), scan_requested_by=actor.id, purpose="record_attachment"
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
        "authorize",
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
        id=uuid4(), scan_requested_by=actor.id, purpose="record_attachment"
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
        "authorize",
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
    candidate = SimpleNamespace(purpose="record_attachment")
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
        "authorize",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPException(status_code=403)),
    )

    scan_processing.finish_attempt(database, claim, NOW)

    assert locked.failure_code == "scan_suspended"
    assert locked.scan_next_attempt_at is None


def test_finish_attempt_propagates_policy_unavailability_without_suspending(
    monkeypatch: pytest.MonkeyPatch,
):
    claim = _claim()
    candidate = SimpleNamespace(purpose="record_attachment")
    rollbacks: list[str] = []
    database = SimpleNamespace(info={}, rollback=lambda: rollbacks.append("rollback"))
    monkeypatch.setattr(scan_processing, "load", lambda *_args, **_kwargs: candidate)
    monkeypatch.setattr(scan_processing, "fresh_user", lambda _db, _id: _actor())
    monkeypatch.setattr(
        scan_processing,
        "authorize",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPException(status_code=503)),
    )

    with pytest.raises(HTTPException) as unavailable:
        scan_processing.finish_attempt(database, claim, NOW)

    assert unavailable.value.status_code == 503
    assert rollbacks == ["rollback"]
