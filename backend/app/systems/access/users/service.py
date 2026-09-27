"""Local user invitations coordinated with the Identity capability."""

from datetime import timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload, selectinload
from uuid6 import uuid7

from app.common.dependencies import require_fresh_exact_admin
from app.core.base_model import utc_now
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.policy.models import AccessGroupMember
from app.systems.access.policy.service import load_creation_defaults
from app.systems.access.users.coordination import (
    InvitationConflict,
    InvitationError,
    InvitationNotFound,
    get_user,
    resolve_department_memberships,
    validate_identity_profile,
)
from app.systems.access.users.invitation_provider import prepare_invitation_user
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
    UserDepartment,
    UserRole,
    UserStatus,
)
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
    append_security_event,
)


def _security_event(
    *,
    event_type: str,
    outcome: SecurityEventOutcome,
    operation_id: UUID,
    actor_id: UUID | None = None,
    subject_id: UUID | None = None,
    reason: str | None = None,
) -> None:
    try:
        append_committed_security_event(
            SecurityEventIngestRequest(
                event_type=event_type,
                outcome=outcome,
                source="users.service",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=subject_id,
                reason=reason,
            )
        )
    except SecurityEventPersistenceError as error:
        raise InvitationError("Unable to record security event") from error


def _record_invitation_failure(
    operation_id: UUID, actor_id: UUID | None, *,
    event_type: str = "user.invitation", subject_id: UUID | None = None,
) -> None:
    """Record a secondary failure event without replacing the primary safe error."""

    try:
        _security_event(
            event_type=event_type,
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=subject_id,
        )
    except InvitationError:
        pass


def _lock_role(db: Session, role_id: UUID) -> Role:
    role = db.scalar(
        select(Role).where(Role.id == role_id, Role.is_deleted.is_(False)).with_for_update()
    )
    if not isinstance(role, Role):
        raise InvitationError("Role is not active")
    return role


def _lock_role_any_state(db: Session, role_id: UUID) -> Role | None:
    role = db.scalar(select(Role).where(Role.id == role_id).with_for_update())
    if role is not None and not isinstance(role, Role):
        raise InvitationError("Unable to lock invitation role")
    return role


def _lock_admin_role(db: Session) -> Role:
    role = db.scalar(
        select(Role)
        .where(Role.role == UserRole.ADMIN, Role.is_deleted.is_(False))
        .with_for_update()
    )
    if not isinstance(role, Role):
        raise InvitationError("Unable to lock administrator membership")
    return role


def _lock_profile(db: Session, user_id: UUID) -> User | None:
    profile = db.scalar(
        select(User)
        .options(joinedload(User.role), selectinload(User.department_memberships))
        .where(User.id == user_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User)
    )
    if profile is not None and not isinstance(profile, User):
        raise InvitationError("Unable to lock invitation profile")
    return profile


def _other_non_deleted_assignment_exists(
    db: Session, role_id: UUID, excluded_user_id: UUID
) -> bool:
    return bool(
        db.scalar(
            select(func.count())
            .select_from(User)
            .where(
                User.role_id == role_id,
                User.id != excluded_user_id,
                User.is_deleted.is_(False),
            )
        )
    )


def invite_user(
    db: Session,
    payload: InvitationCreate,
    *,
    actor_id: UUID | None = None,
    bootstrap: bool = False,
    client: SupabaseAuthClient | None = None,
) -> User:
    """Commit local authorization before creating and mailing a provider identity."""

    if (actor_id is None) != bootstrap:
        raise InvitationError("Invitation actor is required outside bootstrap")
    operation_id = uuid7()
    provider = client or get_supabase_auth_client()
    try:
        if actor_id is not None:
            require_fresh_exact_admin(db, actor_id)
        try:
            defaults = load_creation_defaults(db)
        except (ValueError, HTTPException) as error:
            raise InvitationError("Access defaults are unavailable") from error
        role = defaults.role if payload.role_id is None else _lock_role(db, payload.role_id)
        expires_at = payload.expires_at
        if payload.identity_kind is IdentityKind.GUEST and expires_at is None:
            expires_at = utc_now() + timedelta(days=defaults.guest_duration_days)
        validate_identity_profile(
            db,
            identity_kind=payload.identity_kind,
            sponsor_user_id=payload.sponsor_user_id,
            expires_at=expires_at,
            role=role,
        )
        department_ids = resolve_department_memberships(
            db,
            list(defaults.department_ids)
            if payload.department_ids is None
            else payload.department_ids,
            payload.primary_department_id,
        )
        existing = db.scalar(
            select(User)
            .where(or_(User.email == payload.email, User.username == payload.username))
            .with_for_update(of=User)
        )
        if existing is not None:
            raise InvitationConflict("Email or username is already in use")
        if (
            bootstrap
            and role.role == UserRole.ADMIN
            and _other_non_deleted_assignment_exists(db, role.id, UUID(int=0))
        ):
            raise InvitationError("An administrator reservation already exists")
        user = User(
            email=payload.email,
            username=payload.username,
            role_id=role.id,
            role=role,
            display_name=payload.display_name,
            identity_kind=payload.identity_kind.value,
            job_title=payload.job_title,
            sponsor_user_id=payload.sponsor_user_id,
            expires_at=expires_at,
            status=UserStatus.PENDING.value,
            invitation_sent_at=None,
            provider_invitation_operation_id=operation_id,
            department_memberships=[],
        )
        db.add(user)
        for department_id in department_ids:
            db.add(
                UserDepartment(
                    user=user,
                    department_id=department_id,
                    is_primary=department_id == payload.primary_department_id,
                )
            )
        db.flush()
        for group_id in defaults.group_ids:
            db.add(AccessGroupMember(group_id=group_id, user_id=user.id, performed_by=actor_id))
        db.commit()
    except InvitationError:
        db.rollback()
        _record_invitation_failure(operation_id, actor_id)
        raise
    except (IntegrityError, SQLAlchemyError) as error:
        db.rollback()
        _record_invitation_failure(operation_id, actor_id)
        raise InvitationConflict("Email or username is already in use") from error
    try:
        provider_user = provider.admin_create_invitation_user(user.email, user.id, operation_id)
        expected_marker = {
            "openslate_user_id": str(user.id),
            "openslate_invitation_operation_id": str(operation_id),
        }
        if provider_user.email != user.email or any(
            provider_user.app_metadata.get(k) != v for k, v in expected_marker.items()
        ):
            raise InvitationError("Provider invitation does not match")
        sent = provider.admin_send_invitation(user.email)
        if sent.id != provider_user.id:
            raise InvitationError("Provider invitation does not match")
        db.refresh(user, with_for_update=True)
        if (
            user.is_deleted
            or user.status != UserStatus.PENDING.value
            or user.provider_invitation_operation_id != operation_id
        ):
            raise InvitationError("Invitation is no longer pending")
        user.supabase_user_id = provider_user.id
        user.invitation_sent_at = utc_now()
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="user.invitation",
                outcome=SecurityEventOutcome.SUCCESS,
                source="users.service",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=user.id,
            ),
        )
        db.commit()
        return get_user(db, user.id)
    except (InvalidProviderCredentials, SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        _record_invitation_failure(operation_id, actor_id)
        raise InvitationError("Unable to send invitation") from error
    except InvitationError:
        db.rollback()
        _record_invitation_failure(operation_id, actor_id)
        raise


def revoke_invitation(db: Session, user_id: UUID, *, actor_id: UUID) -> None:
    """Remove local invitation authority even if a provider email already exists."""

    try:
        require_fresh_exact_admin(db, actor_id)
        profile = _lock_profile(db, user_id)
        if profile is None or profile.is_deleted:
            raise InvitationNotFound("Invitation does not exist")
        if profile.status != UserStatus.PENDING.value or profile.invitation_sent_at is None:
            raise InvitationConflict("Invitation is no longer pending")
        timestamp = utc_now()
        profile.invitation_sent_at = None
        profile.tokens_valid_after = timestamp
        revoke_user_sessions(db, profile.id, except_session_id=None, now=timestamp)
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="user.invitation_revocation",
                outcome=SecurityEventOutcome.SUCCESS,
                source="users.service",
                operation_id=uuid7(),
                actor_id=actor_id,
                subject_id=profile.id,
            ),
        )
        db.commit()
    except (InvitationError, HTTPException):
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to revoke invitation") from error


def resend_invitation(
    db: Session,
    user_id: UUID,
    *,
    actor_id: UUID,
    client: SupabaseAuthClient | None = None,
) -> User:
    """Resend only to the provider identity bound by the local pending operation."""

    operation_id = uuid7()
    _security_event(
        event_type="user.invitation_resend", outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id, actor_id=actor_id, subject_id=user_id,
    )
    provider = client or get_supabase_auth_client()
    try:
        require_fresh_exact_admin(db, actor_id)
        profile = _lock_profile(db, user_id)
        if (
            profile is None
            or profile.is_deleted
            or profile.status != UserStatus.PENDING.value
            or getattr(profile, "invitation_accepted_at", None) is not None
            or profile.supabase_user_id is None
            or profile.provider_invitation_operation_id is None
        ):
            raise InvitationError("Invitation is not pending")
        provider_user = prepare_invitation_user(provider, profile)
        sent = provider.admin_send_invitation(profile.email)
        if sent.id != provider_user.id:
            raise InvitationError("Provider invitation does not match")
        profile.supabase_user_id = provider_user.id
        profile.invitation_sent_at = utc_now()
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="user.invitation_resend",
                outcome=SecurityEventOutcome.SUCCESS,
                source="users.service",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=profile.id,
            ),
        )
        db.commit()
        return get_user(db, profile.id)
    except (InvalidProviderCredentials, SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        _record_invitation_failure(
            operation_id, actor_id, event_type="user.invitation_resend", subject_id=user_id
        )
        raise InvitationError("Unable to resend invitation") from error
    except (InvitationError, HTTPException):
        db.rollback()
        _record_invitation_failure(
            operation_id, actor_id, event_type="user.invitation_resend", subject_id=user_id
        )
        raise


def reconcile_invitation(
    db: Session,
    user_id: UUID,
    *,
    actor_id: UUID | None,
    bootstrap: bool = False,
    client: SupabaseAuthClient | None = None,
) -> User:
    """Explicitly recover a provider invite after a local commit failure."""

    provider = client or get_supabase_auth_client()
    try:
        if (actor_id is None) != bootstrap:
            raise InvitationError("Invitation actor is required outside bootstrap")
        if actor_id is not None:
            require_fresh_exact_admin(db, actor_id)
        profile = _lock_profile(db, user_id)
        if (
            profile is None
            or profile.is_deleted
            or profile.status != UserStatus.PENDING.value
            or getattr(profile, "invitation_accepted_at", None) is not None
            or profile.provider_invitation_operation_id is None
        ):
            raise InvitationError("Invitation is not pending")
        if bootstrap:
            admin_role = _lock_admin_role(db)
            if profile.role_id != admin_role.id or _other_non_deleted_assignment_exists(
                db, admin_role.id, profile.id
            ):
                raise InvitationError("Bootstrap reservation is unavailable")
        operation_id = profile.provider_invitation_operation_id
        provider_user = prepare_invitation_user(provider, profile)
        sent = provider.admin_send_invitation(profile.email)
        if sent.id != provider_user.id:
            raise InvitationError("Provider invitation does not match")
        profile.supabase_user_id = provider_user.id
        profile.invitation_sent_at = utc_now()
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="user.invitation_resend",
                outcome=SecurityEventOutcome.SUCCESS,
                source="users.service",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=profile.id,
            ),
        )
        db.commit()
        return get_user(db, profile.id)
    except (InvalidProviderCredentials, SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise InvitationError("Unable to reconcile invitation") from error
    except (InvitationError, HTTPException):
        db.rollback()
        raise
