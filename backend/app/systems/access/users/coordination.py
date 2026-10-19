"""Locked user coordination used by account and invitation routes."""

from datetime import datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.users.eligibility import established_user_clause, is_established_user
from app.systems.access.users.membership import (
    bound_organization,
    is_platform_operator,
    organization_membership,
)
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.access.users.schemas import UserUpdate
from app.systems.manage.workspace.models import WorkspaceProfile


class InvitationError(RuntimeError):
    """A safe invitation lifecycle error."""


class InvitationConflict(InvitationError):
    """An invitation conflicts with a local identity."""


class InvitationNotFound(InvitationError):
    """The requested invitation profile does not exist."""


class ProfileValidationError(InvitationError):
    """An identity profile cannot be assigned safely."""


def protect_owners(db: Session, user: User) -> None:
    """Keep organization and installation owners able to sign in and act."""
    owner_id = db.scalar(
        select(WorkspaceProfile.owner_user_id).where(WorkspaceProfile.id == bound_organization(db))
    )
    if user.id == owner_id:
        raise conflict("The organization owner cannot be removed, disabled, or demoted")
    if is_platform_operator(db, user.id):
        raise conflict("An installation owner cannot be removed, disabled, or demoted here")


def require_user_patch(payload: UserUpdate) -> None:
    if not payload.model_fields_set:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )
    nullable = {"display_name", "job_title", "expires_at"}
    if any(
        getattr(payload, field) is None
        for field in payload.model_fields_set
        if field not in nullable
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


def apply_profile_update(
    db: Session, user: User, membership: Membership, payload: UserUpdate, *, destination_role: str
) -> None:
    fields = payload.model_fields_set
    if membership.role != UserRole.GUEST.value and "sponsor_user_id" in fields:
        raise ProfileValidationError("Only guests can have a sponsor")
    sponsor_user_id = (
        payload.sponsor_user_id if "sponsor_user_id" in fields else membership.sponsor_user_id
    )
    expires_at = payload.expires_at if "expires_at" in fields else membership.expires_at
    if fields & {"role", "sponsor_user_id", "expires_at"}:
        validate_identity_profile(
            db, role=destination_role, sponsor_user_id=sponsor_user_id, expires_at=expires_at
        )
    if "display_name" in fields:
        user.display_name = payload.display_name
    if "job_title" in fields:
        user.job_title = payload.job_title
    if "sponsor_user_id" in fields:
        membership.sponsor_user_id = sponsor_user_id
    if "expires_at" in fields:
        membership.expires_at = expires_at


def _lock_groups(db: Session, group_ids: set[UUID]) -> dict[UUID, Group]:
    if not group_ids:
        return {}
    rows = db.scalars(
        select(Group)
        .where(Group.id.in_(group_ids))
        .order_by(Group.id)
        .execution_options(populate_existing=True)
        .with_for_update()
    ).all()
    return {row.id: row for row in rows}


def lock_membership_groups(db: Session, user_id: UUID) -> dict[UUID, Group]:
    """After the Comms org guard, lock group rows before member and user rows."""
    try:
        ids = set(
            db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user_id)).all()
        )
        return _lock_groups(db, ids)
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to lock group memberships") from error


def leave_groups(db: Session, user: User, groups: dict[UUID, Group], actor_id: UUID) -> None:
    """An administrator has no group memberships; retain the existing group/member lock order."""
    try:
        memberships = list(
            db.scalars(
                select(GroupMember)
                .where(GroupMember.user_id == user.id)
                .order_by(GroupMember.group_id)
                .with_for_update()
            )
        )
        groups = {**groups, **_lock_groups(db, {row.group_id for row in memberships} - set(groups))}
        for item in memberships:
            db.delete(item)
            group = groups[item.group_id]
            group.revision += 1
            group.performed_by = actor_id
        db.flush()
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to remove group memberships") from error


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def forbidden(message: str) -> HTTPException:
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


def shares_another_organization(db: Session, user: User) -> bool:
    """Whether the person also belongs to an organization other than the bound one.

    Account changes (status, username, profile, delete, security reset) reach every
    organization of the person. Owner decision (2026-10-16): an organization
    administrator then acts on the membership only; account changes belong to the
    person or the installation owner (platform operator).
    """
    return (
        db.scalar(
            select(Membership.id)
            .where(
                Membership.user_id == user.id,
                Membership.org_id != bound_organization(db),
                Membership.is_deleted.is_(False),
            )
            .limit(1)
        )
        is not None
    )


def refuse_account_details(db: Session) -> None:
    db.rollback()
    raise conflict(
        "This person also belongs to another organization; "
        "only they or the installation owner can change their account details"
    )


def organization_member(db: Session, user: User) -> Membership:
    """The person's membership in the bound organization; others are not found here."""
    membership = organization_membership(db, user.id, fresh=True)
    if membership is None:
        db.rollback()
        raise not_found("User")
    return membership


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
            Membership.expires_at.is_(None)
            if durable
            else or_(Membership.expires_at.is_(None), Membership.expires_at > utc_now())
        )
        return int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .join(Membership, Membership.user_id == User.id)
                .where(
                    User.is_deleted.is_(False),
                    User.status == UserStatus.ACTIVE.value,
                    # The last-administrator rule holds in each organization.
                    Membership.org_id == bound_organization(db),
                    Membership.role == UserRole.ADMIN.value,
                    Membership.status == UserStatus.ACTIVE.value,
                    Membership.is_deleted.is_(False),
                    established_user_clause(),
                    expiry_condition,
                )
            )
            or 0
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to evaluate administrator membership") from error


def is_active_admin(user: User, membership: Membership) -> bool:
    return bool(
        not user.is_deleted
        and user.status == UserStatus.ACTIVE.value
        and membership.status == UserStatus.ACTIVE.value
        and is_identity_eligible(user, membership)
        and is_established_user(membership)
        and membership.role == UserRole.ADMIN.value
    )


def token_cutoff(timestamp: datetime) -> datetime:
    """Token `iat` has whole-second precision; a sub-second cutoff would refuse a
    new sign-in in the same second. Revoked sessions still refuse older tokens."""
    return timestamp.replace(microsecond=0)


def advance_token_cutoff(user: User) -> None:
    now = token_cutoff(utc_now())
    if user.tokens_valid_after is None or user.tokens_valid_after < now:
        user.tokens_valid_after = now


def ensure_projected_admin_remains(
    db: Session,
    user: User,
    membership: Membership,
    *,
    destination_role: str,
    destination_status: str,
    destination_deleted: bool = False,
    destination_expires_at: datetime | None = None,
    expiry_requested: bool = False,
) -> None:
    now = utc_now()
    was_active_admin = is_active_admin(user, membership)
    projected_expiry = destination_expires_at if expiry_requested else membership.expires_at
    will_be_active_admin = bool(
        not destination_deleted
        and destination_status == UserStatus.ACTIVE.value
        and (projected_expiry is None or projected_expiry > now)
        and is_established_user(membership, status_value=destination_status)
        and destination_role == UserRole.ADMIN.value
    )
    if not (was_active_admin or will_be_active_admin):
        return
    projected = active_admin_count(db) - int(was_active_admin) + int(will_be_active_admin)
    if projected < 1:
        raise conflict("Cannot remove the last active admin")
    was_durable_admin = was_active_admin and membership.expires_at is None
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
        sponsor.is_deleted or sponsor.status != UserStatus.ACTIVE.value
    ):
        raise ProfileValidationError("Guest sponsor is not an active member or administrator")
    membership = organization_membership(db, sponsor.id)
    if (
        membership is None
        or membership.role == UserRole.GUEST.value
        or not is_identity_eligible(sponsor, membership, now=utc_now())
    ):
        raise ProfileValidationError("Guest sponsor is not an active member or administrator")
