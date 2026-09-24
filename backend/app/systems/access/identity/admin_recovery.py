"""Guarded local recovery for an active OpenSlate administrator."""

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import is_identity_eligible, is_internal_identity
from app.systems.access.identity.service import generated_temporary_password, replace_password
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event


class LocalRecoveryError(RuntimeError):
    """A safe failure for local administrator recovery."""


@dataclass(frozen=True, slots=True)
class RecoveredAdmin:
    user_id: UUID
    temporary_password: str


def recover_local_admin(
    db: Session,
    user_id: UUID,
    *,
    local_invocation: bool,
    elevated: bool,
) -> RecoveredAdmin:
    if not local_invocation or not elevated:
        raise LocalRecoveryError("Local elevated administrator recovery is required")
    timestamp = utc_now()
    user = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(User.id == user_id)
        .with_for_update(of=User)
    )
    if (
        user is None
        or not is_identity_eligible(user, now=timestamp)
        or not is_internal_identity(user)
        or user.status != UserStatus.ACTIVE.value
        or user.role is None
        or user.role.is_deleted
        or user.role.role != UserRole.ADMIN
    ):
        db.rollback()
        raise LocalRecoveryError("Target is not an active administrator")
    secret = generated_temporary_password()
    try:
        replace_password(db, user, secret, temporary=True, now=timestamp)
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="identity.local_admin_recovery",
                outcome=SecurityEventOutcome.SUCCESS,
                source="identity.admin_recovery",
                operation_id=uuid7(),
                subject_id=user.id,
                reason="local elevated recovery",
            ),
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise LocalRecoveryError("Administrator recovery failed") from error
    return RecoveredAdmin(user.id, secret)
