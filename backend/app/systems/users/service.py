from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.integrations.supabase import (
    SupabaseAdminClient,
    SupabaseAdminError,
)
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus


class InvitationError(RuntimeError):
    """A safe invitation lifecycle error."""


class InvitationConflict(InvitationError):
    """An invitation conflicts with an existing local identity."""


def _member_role(db: Session) -> Role:
    role = db.scalar(
        select(Role).where(Role.role == UserRole.MEMBER, Role.is_deleted.is_(False))
    )
    if role is None:
        raise InvitationError("Default member role is not configured")
    return role


def invite_user(
    db: Session,
    payload: InvitationCreate,
    *,
    client: SupabaseAdminClient | None = None,
) -> User:
    """Invite an Auth user, then finalize its trigger-created local profile."""

    role = (
        db.scalar(select(Role).where(Role.id == payload.role_id, Role.is_deleted.is_(False)))
        if payload.role_id is not None
        else _member_role(db)
    )
    if role is None:
        raise InvitationError("Role is not active")

    auth_client = client or SupabaseAdminClient()
    existing_profile = db.scalar(
        select(User).where(or_(User.email == payload.email, User.username == payload.username))
    )
    if existing_profile is not None:
        recoverable_pending_profile = (
            existing_profile.email == payload.email
            and existing_profile.status == UserStatus.PENDING.value
            and not existing_profile.is_deleted
            and existing_profile.username.startswith("auth_")
        )
        if not recoverable_pending_profile:
            raise InvitationConflict("Email or username is already in use")
        try:
            # A previous process may have stopped after Auth committed but before
            # the audited profile finalization. Invalidate that old invite and
            # restart the saga rather than permanently stranding the address.
            auth_client.delete_user(existing_profile.id)
            db.expire_all()
        except SupabaseAdminError as error:
            raise InvitationError("Unable to reconcile pending invitation") from error

    try:
        auth_user = auth_client.invite_user(payload.email, payload.username)
    except SupabaseAdminError as error:
        if error.status_code in {409, 422}:
            raise InvitationConflict("Email is already in use") from error
        raise InvitationError("Unable to send invitation") from error
    try:
        profile = db.scalar(select(User).where(User.id == auth_user.id))
        if profile is None:
            raise InvitationError("Unable to finalize invitation")
        profile.email = payload.email
        profile.username = payload.username
        profile.role_id = role.id
        profile.role = role
        profile.status = UserStatus.ACTIVE.value
        profile.is_deleted = False
        profile.deleted_at = None
        db.commit()
        db.refresh(profile)
        return profile
    except (InvitationError, IntegrityError, SQLAlchemyError, ValueError) as error:
        db.rollback()
        try:
            auth_client.delete_user(auth_user.id)
        except Exception:
            pass
        if isinstance(error, InvitationError):
            raise error
        if isinstance(error, IntegrityError):
            raise InvitationConflict("Email or username is already in use") from error
        raise InvitationError("Unable to finalize invitation") from error
