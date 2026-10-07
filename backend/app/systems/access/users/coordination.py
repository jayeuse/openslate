"""Locked user coordination used by account and invitation routes."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.users.eligibility import established_user_clause, is_established_user
from app.systems.access.users.models import User, UserRole, UserStatus


class InvitationError(RuntimeError):
    """A safe invitation lifecycle error."""


class InvitationConflict(InvitationError):
    """An invitation conflicts with a local identity."""


class InvitationNotFound(InvitationError):
    """The requested invitation profile does not exist."""


class ProfileValidationError(InvitationError):
    """An identity profile cannot be assigned safely."""


@dataclass(frozen=True, slots=True)
class UserState:
    role: str
    status: str
    is_deleted: bool
    deleted_at: datetime | None
    username: str
    invitation_sent_at: datetime | None
    invitation_accepted_at: datetime | None
    tokens_valid_after: datetime | None


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def forbidden(message: str = "Forbidden") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=message)


def not_found(resource: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource} not found")


def unavailable(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=message)


def commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise conflict(message) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Database operation unavailable") from error


def get_user(db: Session, user_id: UUID) -> User:
    user = db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise not_found("User")
    return user


def lock_user(db: Session, user_id: UUID) -> User:
    try:
        user = db.scalar(
            select(User)
            .where(User.id == user_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to lock user") from error
    if user is None:
        db.rollback()
        raise not_found("User")
    if not isinstance(user, User):
        db.rollback()
        raise unavailable("Unable to lock user")
    return user


def active_admin_count(db: Session, *, durable: bool = False) -> int:
    try:
        expiry_condition = (
            User.expires_at.is_(None)
            if durable
            else or_(User.expires_at.is_(None), User.expires_at > utc_now())
        )
        return int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .where(
                    User.is_deleted.is_(False),
                    User.status == UserStatus.ACTIVE.value,
                    User.role == UserRole.ADMIN.value,
                    established_user_clause(),
                    expiry_condition,
                )
            )
            or 0
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to evaluate administrator membership") from error


def is_active_admin(user: User, role: str | None = None, status_value: str | None = None) -> bool:
    return bool(
        not user.is_deleted
        and (status_value or user.status) == UserStatus.ACTIVE.value
        and is_identity_eligible(user)
        and is_established_user(user, status_value=status_value)
        and (role or user.role) == UserRole.ADMIN.value
    )


def token_cutoff(timestamp: datetime) -> datetime:
    """Token `iat` has whole-second precision; a sub-second cutoff would refuse a
    new sign-in in the same second. Revoked sessions still refuse older tokens."""
    return timestamp.replace(microsecond=0)


def advance_token_cutoff(user: User) -> None:
    now = token_cutoff(utc_now())
    if user.tokens_valid_after is None or user.tokens_valid_after < now:
        user.tokens_valid_after = now


def user_state(user: User) -> UserState:
    return UserState(
        role=user.role,
        status=user.status,
        is_deleted=user.is_deleted,
        deleted_at=user.deleted_at,
        username=user.username,
        invitation_sent_at=user.invitation_sent_at,
        invitation_accepted_at=user.invitation_accepted_at,
        tokens_valid_after=user.tokens_valid_after,
    )


def ensure_projected_admin_remains(
    db: Session,
    user: User,
    *,
    destination_role: str,
    destination_status: str,
    destination_deleted: bool = False,
    destination_expires_at: datetime | None = None,
    expiry_requested: bool = False,
) -> None:
    now = utc_now()
    was_active_admin = is_active_admin(user)
    projected_expiry = destination_expires_at if expiry_requested else user.expires_at
    will_be_active_admin = bool(
        not destination_deleted
        and destination_status == UserStatus.ACTIVE.value
        and (projected_expiry is None or projected_expiry > now)
        and is_established_user(user, status_value=destination_status)
        and destination_role == UserRole.ADMIN.value
    )
    if not (was_active_admin or will_be_active_admin):
        return
    projected = active_admin_count(db) - int(was_active_admin) + int(will_be_active_admin)
    if projected < 1:
        raise conflict("Cannot remove the last active admin")
    was_durable_admin = was_active_admin and user.expires_at is None
    will_be_durable_admin = will_be_active_admin and projected_expiry is None
    if (was_durable_admin and not will_be_durable_admin) or (
        expiry_requested and will_be_active_admin and not will_be_durable_admin
    ):
        projected_durable = (
            active_admin_count(db, durable=True)
            - int(was_durable_admin)
            + int(will_be_durable_admin)
        )
        if projected_durable < 1:
            raise conflict("Cannot remove the last durable admin")


def validate_identity_profile(
    db: Session,
    *,
    role: UserRole | str,
    sponsor_user_id: UUID | None,
    expires_at: datetime | None,
) -> None:
    """Validate the profile rules that need current database state.

    A guest needs an active, non-guest sponsor and a future expiry. Only a guest
    has a sponsor.
    """

    if UserRole(role) is not UserRole.GUEST:
        if sponsor_user_id is not None:
            raise ProfileValidationError("Only guests can have a sponsor")
        return
    if sponsor_user_id is None:
        raise ProfileValidationError("Guests require an active sponsor")
    if expires_at is None or expires_at.tzinfo is None or expires_at <= utc_now():
        raise ProfileValidationError("Guests require a future expiration")
    sponsor = db.scalar(select(User).where(User.id == sponsor_user_id).with_for_update(of=User))
    if not isinstance(sponsor, User) or (
        sponsor.is_deleted
        or sponsor.status != UserStatus.ACTIVE.value
        or sponsor.role == UserRole.GUEST.value
        or not is_identity_eligible(sponsor, now=utc_now())
    ):
        raise ProfileValidationError("Guest sponsor is not an active member or administrator")
