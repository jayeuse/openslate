"""Specific current-admin fanout helpers in each source owner's transaction."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.manage.backups.models import BackupRun
from app.systems.platform.scheduling.models import InAppNotification, NotificationKind
from app.systems.sandbox.designs.models import SandboxVersion


def _admin_recipient_ids(db: Session, preferred: UUID | None = None) -> list[UUID]:
    candidates = db.scalars(
        select(User)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.role == UserRole.ADMIN.value)
        .order_by(User.id)
        .execution_options(populate_existing=True)
    )
    eligible = [user.id for user in candidates if is_active_account(db, user)]
    return [preferred] if preferred is not None and preferred in eligible else eligible


def notify_backup_failure(db: Session, run: BackupRun) -> None:
    preferred = run.requester_id if run.provenance == "manual" else None
    for recipient_id in _admin_recipient_ids(db, preferred):
        db.add(
            InAppNotification(
                org_id=None,
                recipient_id=recipient_id,
                kind=NotificationKind.BACKUP_FAILED,
                subject_type="backup_run",
                subject_id=run.id,
            )
        )


def notify_invitation_accepted(db: Session, accepted: User, inviter_id: UUID | None) -> None:
    for recipient_id in _admin_recipient_ids(db, inviter_id):
        db.add(
            InAppNotification(
                org_id=bound_organization(db),
                recipient_id=recipient_id,
                kind=NotificationKind.INVITATION_ACCEPTED,
                subject_type="user",
                subject_id=accepted.id,
            )
        )


def notify_sandbox_publication(db: Session, version: SandboxVersion) -> None:
    for recipient_id in _admin_recipient_ids(db):
        db.add(
            InAppNotification(
                org_id=version.org_id,
                recipient_id=recipient_id,
                kind=NotificationKind.SANDBOX_PUBLISHED,
                subject_type="sandbox_version",
                subject_id=version.id,
            )
        )
