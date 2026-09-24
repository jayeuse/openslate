"""Service-identity persistence error and lifecycle-state contracts."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.service_identities.schemas import ServiceIdentityUpdate
from app.systems.access.service_identities.service import (
    commit,
    delete_service_identity,
    get_service_identity,
    lock_service_identity,
    lock_valid_owner,
    lock_valid_role,
    restore_service_identity,
    update_service_identity,
)


def _row(*, is_deleted: bool = False) -> ServiceIdentity:
    now = datetime.now(UTC)
    return ServiceIdentity(
        id=uuid4(),
        name="Export worker",
        purpose="Generate a scheduled export",
        owner_id=uuid4(),
        role_id=uuid4(),
        expires_at=now + timedelta(days=1),
        status="active",
        is_deleted=is_deleted,
        deleted_at=now if is_deleted else None,
        updated_at=now,
    )


def test_get_and_lock_service_identity_report_missing_rows() -> None:
    db = Mock(spec=Session)
    db.get.return_value = None

    with pytest.raises(HTTPException) as missing_get:
        get_service_identity(db, uuid4())
    assert missing_get.value.status_code == 404
    assert missing_get.value.detail == "Service identity not found"

    db.scalar.return_value = None
    with pytest.raises(HTTPException) as missing_lock:
        lock_service_identity(db, uuid4())
    assert missing_lock.value.status_code == 404
    assert missing_lock.value.detail == "Service identity not found"
    db.rollback.assert_called_once()


@pytest.mark.parametrize("lock", [lock_service_identity, lock_valid_owner, lock_valid_role])
def test_locked_service_identity_references_map_database_errors_to_unavailable(lock) -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = SQLAlchemyError("connection details must stay private")

    with pytest.raises(HTTPException) as unavailable:
        lock(db, uuid4())

    assert unavailable.value.status_code == 503
    assert unavailable.value.detail == "Database unavailable"
    db.rollback.assert_called_once()


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_detail"),
    [
        (
            IntegrityError("insert", {}, RuntimeError("unique constraint")),
            409,
            "Unable to create service identity",
        ),
        (SQLAlchemyError("database credentials"), 503, "Database unavailable"),
    ],
)
def test_commit_maps_database_failures_to_safe_http_errors(
    error: SQLAlchemyError,
    expected_status: int,
    expected_detail: str,
) -> None:
    db = Mock(spec=Session)
    db.commit.side_effect = error

    with pytest.raises(HTTPException) as failure:
        commit(db, "Unable to create service identity")

    assert failure.value.status_code == expected_status
    assert failure.value.detail == expected_detail
    db.rollback.assert_called_once()


def test_update_rejects_empty_and_deleted_service_identities_before_writing() -> None:
    db = Mock(spec=Session)
    with pytest.raises(HTTPException) as empty:
        update_service_identity(db, uuid4(), ServiceIdentityUpdate(), None)
    assert empty.value.status_code == 422
    assert empty.value.detail == "At least one field is required"
    db.scalar.assert_not_called()

    row = _row(is_deleted=True)
    db.scalar.return_value = row
    with pytest.raises(HTTPException) as deleted:
        update_service_identity(db, row.id, ServiceIdentityUpdate(name="Renamed"), '"stale"')
    assert deleted.value.status_code == 409
    assert deleted.value.detail == "Service identity is deleted"
    db.commit.assert_not_called()


def test_delete_and_restore_reject_incompatible_lifecycle_states() -> None:
    db = Mock(spec=Session)
    deleted = _row(is_deleted=True)
    db.scalar.return_value = deleted

    with pytest.raises(HTTPException) as repeated_delete:
        delete_service_identity(db, deleted.id, '"current"')
    assert repeated_delete.value.status_code == 409
    assert repeated_delete.value.detail == "Service identity is already deleted"

    active = _row()
    db.scalar.return_value = active
    with pytest.raises(HTTPException) as restore_active:
        restore_service_identity(db, active.id, '"current"')
    assert restore_active.value.status_code == 409
    assert restore_active.value.detail == "Service identity is not deleted"
    db.commit.assert_not_called()
