"""Guarded provider recovery for an active OpenSlate administrator."""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
    append_security_event,
)


class LocalRecoveryError(RuntimeError):
    """A safe failure for local administrator recovery."""


@dataclass(frozen=True, slots=True)
class RecoveredAdmin:
    user_id: UUID


def recover_local_admin(
    db: Session,
    user_id: UUID,
    *,
    local_invocation: bool,
    elevated: bool,
) -> RecoveredAdmin:
    """Revoke app sessions, then email recovery through the bound provider account."""

    if not local_invocation or not elevated:
        raise LocalRecoveryError("Local elevated administrator recovery is required")
    timestamp = utc_now()
    user = db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update(of=User)
    )
    if (
        user is None
        or not is_active_account(db, user, now=timestamp)
        or user.status != UserStatus.ACTIVE.value
        or sole_active_membership(db, user.id).role != UserRole.ADMIN.value
        or user.supabase_user_id is None
    ):
        db.rollback()
        raise LocalRecoveryError("Target is not an active administrator")
    provider = get_supabase_auth_client()
    try:
        provider_user = provider.get_admin_user(user.supabase_user_id)
        if (
            provider_user.id != user.supabase_user_id
            or provider_user.email != user.email
            or not provider_user.is_eligible(now=timestamp)
        ):
            raise LocalRecoveryError("Provider administrator does not match")
        revoke_user_sessions(db, user.id, except_session_id=None, now=timestamp)
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="identity.local_admin_recovery",
                outcome=SecurityEventOutcome.ATTEMPT,
                source="identity.admin_recovery",
                operation_id=uuid7(),
                subject_id=user.id,
                reason="local elevated recovery",
            ),
        )
        db.commit()
    except (InvalidProviderCredentials, SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise LocalRecoveryError("Administrator recovery failed") from error
    except LocalRecoveryError:
        db.rollback()
        raise
    try:
        provider.request_recovery(user.email)
        append_committed_security_event(
            SecurityEventIngestRequest(
                event_type="identity.local_admin_recovery",
                outcome=SecurityEventOutcome.SUCCESS,
                source="identity.admin_recovery",
                operation_id=uuid7(),
                subject_id=user.id,
                reason="provider recovery email requested",
            )
        )
    except (SupabaseAuthUnavailable, SecurityEventPersistenceError) as error:
        raise LocalRecoveryError("Administrator recovery failed") from error
    return RecoveredAdmin(user.id)
