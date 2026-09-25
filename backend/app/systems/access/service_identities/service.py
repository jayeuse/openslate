from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.service_identities.schemas import (
    ServiceIdentityCreate,
    ServiceIdentityUpdate,
    effective_status,
)
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def unavailable(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database unavailable"
    )


def commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise conflict(message) from error
    except SQLAlchemyError as error:
        raise unavailable(db) from error


def etag(row: ServiceIdentity) -> str:
    derived = effective_status(
        status=row.status, is_deleted=row.is_deleted, expires_at=row.expires_at
    )
    return f'"{row.id}:{row.updated_at.isoformat()}:{derived}"'


def require_match(value: str | None, row: ServiceIdentity) -> None:
    if value is None:
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED, detail="If-Match is required"
        )
    if value != etag(row):
        raise HTTPException(
            status_code=status.HTTP_412_PRECONDITION_FAILED, detail="Service identity changed"
        )


def get_service_identity(db: Session, service_identity_id: UUID) -> ServiceIdentity:
    try:
        row = db.get(ServiceIdentity, service_identity_id)
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Service identity not found"
        )
    return row


def lock_service_identity(db: Session, service_identity_id: UUID) -> ServiceIdentity:
    try:
        row = db.scalar(
            select(ServiceIdentity)
            .where(ServiceIdentity.id == service_identity_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if row is None:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Service identity not found"
        )
    return row


def lock_valid_owner(db: Session, owner_id: UUID) -> User:
    try:
        owner = db.scalar(
            select(User)
            .where(
                User.id == owner_id,
                User.is_deleted.is_(False),
                User.status == UserStatus.ACTIVE.value,
                User.identity_kind == IdentityKind.INTERNAL.value,
                or_(User.expires_at.is_(None), User.expires_at > datetime.now(UTC)),
            )
            .with_for_update()
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if owner is None:
        db.rollback()
        raise conflict("Owner must be an active internal user")
    return owner


def lock_valid_role(db: Session, role_id: UUID) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(
                Role.id == role_id, Role.is_deleted.is_(False), Role.role != UserRole.ADMIN.value
            )
            .with_for_update()
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if role is None:
        db.rollback()
        raise conflict("Role must be active and cannot be Administrator")
    return role


def create_service_identity(db: Session, payload: ServiceIdentityCreate) -> ServiceIdentity:
    lock_valid_owner(db, payload.owner_id)
    lock_valid_role(db, payload.role_id)
    row = ServiceIdentity(**payload.model_dump())
    db.add(row)
    commit(db, "Unable to create service identity")
    db.refresh(row)
    return row


def update_service_identity(
    db: Session, service_identity_id: UUID, payload: ServiceIdentityUpdate, if_match: str | None
) -> ServiceIdentity:
    if not payload.model_fields_set:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one field is required",
        )
    row = lock_service_identity(db, service_identity_id)
    if row.is_deleted:
        raise conflict("Service identity is deleted")
    require_match(if_match, row)
    fields = payload.model_fields_set
    if "owner_id" in fields:
        lock_valid_owner(db, payload.owner_id)
    if "role_id" in fields:
        lock_valid_role(db, payload.role_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    commit(db, "Unable to update service identity")
    db.refresh(row)
    return row


def delete_service_identity(db: Session, service_identity_id: UUID, if_match: str | None) -> None:
    row = lock_service_identity(db, service_identity_id)
    if row.is_deleted:
        raise conflict("Service identity is already deleted")
    require_match(if_match, row)
    row.is_deleted = True
    row.deleted_at = utc_now()
    commit(db, "Unable to delete service identity")


def restore_service_identity(
    db: Session, service_identity_id: UUID, if_match: str | None
) -> ServiceIdentity:
    row = lock_service_identity(db, service_identity_id)
    if not row.is_deleted:
        raise conflict("Service identity is not deleted")
    require_match(if_match, row)
    lock_valid_owner(db, row.owner_id)
    lock_valid_role(db, row.role_id)
    row.is_deleted = False
    row.deleted_at = None
    commit(db, "Unable to restore service identity")
    db.refresh(row)
    return row
