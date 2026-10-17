"""Service behavior for Access groups."""

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.schemas as schemas
import app.systems.access.policy.service as policy_service
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.users.models import User, UserRole, UserStatus
from tests.users.user_support import local_user


def _group(*, deleted: bool = False) -> Group:
    now = datetime.now(UTC)
    return Group(
        id=uuid7(),
        name="Operations",
        description="Team",
        revision=3,
        created_at=now,
        updated_at=now,
        is_deleted=deleted,
        deleted_at=now if deleted else None,
    )


def _member_user() -> User:
    return User(
        id=uuid7(),
        email="member@example.test",
        username="member",
        status=UserStatus.ACTIVE.value,
        is_deleted=False,
    )


@pytest.mark.parametrize(("failure", "status_code"), [("integrity", 409), ("database", 503)])
def test_commit_translates_integrity_and_database_failures(failure: str, status_code: int) -> None:
    db = Mock(spec=Session)
    db.commit.side_effect = (
        IntegrityError("commit", {}, RuntimeError("duplicate"))
        if failure == "integrity"
        else SQLAlchemyError("connection failed")
    )

    with pytest.raises(HTTPException) as error:
        policy_service.commit(db, "Name unavailable")

    assert error.value.status_code == status_code
    assert db.rollback.call_count == 1


def test_group_reads_map_absence_and_database_errors() -> None:
    db = Mock(spec=Session)
    db.get.return_value = None
    with pytest.raises(HTTPException) as missing:
        policy_service.get_group(db, uuid7())
    assert missing.value.status_code == 404

    db.get.side_effect = SQLAlchemyError("read failed")
    with pytest.raises(HTTPException) as unavailable:
        policy_service.get_group(db, uuid7())
    assert unavailable.value.status_code == 503
    assert db.rollback.call_count == 1


def test_group_lock_maps_missing_rows_and_database_errors() -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = None
    with pytest.raises(HTTPException) as missing:
        policy_service.lock_group(db, uuid7())
    assert missing.value.status_code == 404
    assert db.rollback.call_count == 1

    db.scalar.side_effect = SQLAlchemyError("lock failed")
    with pytest.raises(HTTPException) as unavailable:
        policy_service.lock_group(db, uuid7())
    assert unavailable.value.status_code == 503
    assert db.rollback.call_count == 2


def test_group_member_map_returns_members_and_handles_empty_or_failed_reads() -> None:
    first_group, second_group = uuid7(), uuid7()
    first_member, second_member = uuid7(), uuid7()
    db = Mock(spec=Session)
    db.execute.return_value.tuples.return_value = [
        (first_group, first_member),
        (first_group, second_member),
        (second_group, second_member),
    ]

    assert policy_service.group_member_map(db, [first_group, second_group]) == {
        first_group: [first_member, second_member],
        second_group: [second_member],
    }
    db.execute.assert_called_once()

    db.reset_mock()
    assert policy_service.group_member_map(db, []) == {}
    db.execute.assert_not_called()

    db.execute.side_effect = SQLAlchemyError("member read failed")
    with pytest.raises(HTTPException) as unavailable:
        policy_service.group_member_map(db, [first_group])
    assert unavailable.value.status_code == 503
    assert db.rollback.call_count == 1


def test_replacing_an_unchanged_active_member_set_is_a_no_op() -> None:
    group = _group()
    member = _member_user()
    existing = GroupMember(group_id=group.id, user_id=member.id)
    db = Mock(spec=Session)
    db.scalars.return_value.all.side_effect = [[existing], [member]]

    changed = policy_service.replace_group_members(db, group, [member.id], uuid7())

    assert changed is False
    db.delete.assert_not_called()
    db.add.assert_not_called()
    db.flush.assert_not_called()


@pytest.mark.parametrize(("failure", "status_code"), [("integrity", 409), ("database", 503)])
def test_group_creation_maps_database_failures_and_rolls_back(
    failure: str, status_code: int
) -> None:
    db = Mock(spec=Session)
    actor, membership = local_user(UserRole.ADMIN)
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    db.flush.side_effect = (
        IntegrityError("insert", {}, RuntimeError("duplicate"))
        if failure == "integrity"
        else SQLAlchemyError("insert failed")
    )

    with pytest.raises(HTTPException) as error:
        policy_service.create_group(db, schemas.GroupCreate(name="Operations"), actor.id)

    assert error.value.status_code == status_code
    assert db.rollback.call_count == 1


def test_group_metadata_update_changes_revision_once_and_no_op_keeps_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group = _group()
    db = Mock(spec=Session)
    actor_id = uuid7()
    monkeypatch.setattr(policy_service, "lock_group", lambda *_args: group)

    updated = policy_service.update_group(
        db,
        group.id,
        schemas.GroupUpdate(name="People", description="Colleagues"),
        policy_service.group_etag(group),
        actor_id,
    )
    assert (updated.name, updated.description) == ("People", "Colleagues")
    assert updated.revision == 4
    assert updated.performed_by == actor_id

    next_actor = uuid7()
    unchanged = policy_service.update_group(
        db,
        group.id,
        schemas.GroupUpdate(name="People", description="Colleagues"),
        policy_service.group_etag(group),
        next_actor,
    )
    assert unchanged.revision == 4
    assert unchanged.performed_by == actor_id
    assert db.commit.call_count == 2


def test_group_update_rejects_deleted_rows_and_rolls_back_name_conflicts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deleted = _group(deleted=True)
    db = Mock(spec=Session)
    monkeypatch.setattr(policy_service, "lock_group", lambda *_args: deleted)
    with pytest.raises(HTTPException) as error:
        policy_service.update_group(
            db, deleted.id, schemas.GroupUpdate(name="Restored"), None, uuid7()
        )
    assert error.value.status_code == 409

    active = _group()
    monkeypatch.setattr(policy_service, "lock_group", lambda *_args: active)
    db.commit.side_effect = IntegrityError("update", {}, RuntimeError("duplicate"))
    with pytest.raises(HTTPException) as conflict:
        policy_service.update_group(
            db,
            active.id,
            schemas.GroupUpdate(name="Taken"),
            policy_service.group_etag(active),
            uuid7(),
        )
    assert conflict.value.status_code == 409
    assert conflict.value.detail == "Group name unavailable"
    assert db.rollback.called


def test_group_deletion_blocks_members_and_soft_deletes_an_empty_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    group = _group()
    db.scalar.side_effect = [1]
    with pytest.raises(HTTPException) as in_use:
        policy_service.ensure_group_deletable(db, group)
    assert in_use.value.status_code == 409
    assert in_use.value.detail == "Group has members"

    db.scalars.return_value.all.return_value = []

    monkeypatch.setattr(policy_service, "lock_group", lambda *_args: group)
    monkeypatch.setattr(policy_service, "ensure_group_deletable", lambda *_args: None)
    actor_id = uuid7()
    policy_service.delete_group(db, group.id, policy_service.group_etag(group), actor_id)
    assert group.is_deleted is True
    assert group.deleted_at is not None
    assert group.revision == 4
    assert group.performed_by == actor_id
    db.commit.assert_called_once()

    already_deleted = _group(deleted=True)
    monkeypatch.setattr(policy_service, "lock_group", lambda *_args: already_deleted)
    with pytest.raises(HTTPException) as deleted:
        policy_service.delete_group(
            db,
            already_deleted.id,
            policy_service.group_etag(already_deleted),
            actor_id,
        )
    assert deleted.value.status_code == 409
