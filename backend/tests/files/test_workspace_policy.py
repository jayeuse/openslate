"""Record-attachment authorization uses the authoritative workspace policy."""

from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.platform.files import access, service
from tests.users.user_support import local_user


def _actor(*, role: str = "member") -> tuple[User, Membership]:
    return local_user(UserRole(role))


def _database(module_id: object | None, membership: Membership) -> SimpleNamespace:
    record = None if module_id is None else SimpleNamespace(module_id=module_id)
    return SimpleNamespace(get=lambda _model, _id: record, dirty=set(),
                           scalars=lambda _query: Mock(all=lambda: [membership]))


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
    actor, membership = _actor()
    module_id = uuid4()
    calls: list[object] = []

    def module_level(_db: object, user: User, requested: object) -> AccessLevel | None:
        calls.append((user, requested))
        return granted

    monkeypatch.setattr(access, "module_level", module_level)
    database = _database(module_id, membership)

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
    actor, membership = _actor()
    with pytest.raises(HTTPException) as missing:
        access.authorize(_database(None, membership), actor, "record_attachment", record_id=uuid4())

    assert missing.value.status_code == 404


def test_workspace_logo_is_administrator_only() -> None:
    admin, admin_membership = _actor(role="admin")
    actor, membership = _actor()

    assert access.authorize(
        _database(None, admin_membership), admin, "workspace_logo", write=True
    ) is admin
    with pytest.raises(HTTPException) as denied:
        access.authorize(_database(None, membership), actor, "workspace_logo")
    assert denied.value.status_code == 403


def test_attachment_upload_authorizes_before_the_file_lock(monkeypatch: pytest.MonkeyPatch):
    actor, _membership = _actor()
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

    monkeypatch.setattr(service, "load", load)
    monkeypatch.setattr(service, "fresh_user", lambda _db, _id: actor)
    monkeypatch.setattr(service, "authorize_contextual_file", authorize_contextual_file)

    with pytest.raises(StopAtFileLock):
        service.upload(object(), actor.id, uuid4(), content=b"bytes", storage=object())

    assert events == ["file-read", "policy", "file-lock"]
