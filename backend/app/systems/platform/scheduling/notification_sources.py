"""Current-readable source references for the added notification kinds."""

from uuid import UUID

from sqlalchemy import Select, false, or_, select, true
from sqlalchemy.orm import Session, aliased

from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.manage.backups.models import BackupRun
from app.systems.openview.reports.models import Report
from app.systems.platform.scheduling.models import (
    InAppNotification,
    NotificationKind,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxPublication
from app.systems.sandbox.records.models import Record


def additional_notification_ids(db: Session, user: User) -> Select[tuple[UUID]]:
    role = sole_active_membership(db, user.id).role
    failed_report = (
        select(InAppNotification.id)
        .join(ScheduledWork, ScheduledWork.id == InAppNotification.work_id)
        .join(Report, Report.id == ScheduledWork.report_id)
        .join(Module, Module.id == Report.module_id)
        .where(
            InAppNotification.kind == NotificationKind.REPORT_RUN_FAILED,
            InAppNotification.subject_type == "scheduled_work",
            InAppNotification.subject_id == ScheduledWork.id,
            ScheduledWork.kind == WorkKind.REPORT_RUN,
            ScheduledWork.state == WorkState.FAILED,
            module_filter(db, user, AccessLevel.READ, Report.module_id),
            Report.is_deleted.is_(False),
            Report.deleted_at.is_(None),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
    )

    backup = (
        select(InAppNotification.id)
        .join(BackupRun, BackupRun.id == InAppNotification.subject_id)
        .where(
            InAppNotification.kind == NotificationKind.BACKUP_FAILED,
            InAppNotification.subject_type == "backup_run",
            InAppNotification.work_id.is_(None),
            BackupRun.is_deleted.is_(False),
            BackupRun.deleted_at.is_(None),
            BackupRun.reconciled_at.is_not(None),
            BackupRun.state.in_(("failed", "interrupted")),
            true() if role == UserRole.ADMIN.value else false(),
        )
    )
    assigned = (
        select(InAppNotification.id)
        .join(Record, Record.id == InAppNotification.subject_id)
        .where(
            InAppNotification.kind == NotificationKind.RECORD_ASSIGNED,
            InAppNotification.subject_type == "record",
            InAppNotification.work_id.is_(None),
            module_filter(db, user, AccessLevel.READ, Record.module_id),
        )
    )
    accepted_user = aliased(User)
    accepted_membership = aliased(Membership)
    invitation = (
        select(InAppNotification.id)
        .join(accepted_user, accepted_user.id == InAppNotification.subject_id)
        .join(accepted_membership, accepted_membership.user_id == accepted_user.id)
        .where(
            InAppNotification.kind == NotificationKind.INVITATION_ACCEPTED,
            InAppNotification.subject_type == "user",
            InAppNotification.work_id.is_(None),
            accepted_user.is_deleted.is_(False),
            accepted_user.deleted_at.is_(None),
            accepted_membership.invitation_accepted_at.is_not(None),
            accepted_user.status != "pending",
            true() if role == UserRole.ADMIN.value else false(),
        )
    )
    publication = (
        select(InAppNotification.id)
        .join(SandboxVersion, SandboxVersion.id == InAppNotification.subject_id)
        .join(SandboxPublication, SandboxPublication.version_id == SandboxVersion.id)
        .where(
            InAppNotification.kind == NotificationKind.SANDBOX_PUBLISHED,
            InAppNotification.subject_type == "sandbox_version",
            InAppNotification.work_id.is_(None),
            SandboxVersion.kind == "published",
            SandboxVersion.is_deleted.is_(False),
            SandboxVersion.deleted_at.is_(None),
            SandboxPublication.is_deleted.is_(False),
            SandboxPublication.deleted_at.is_(None),
            SandboxPublication.document_id == SandboxVersion.document_id,
            true() if role == UserRole.ADMIN.value else false(),
        )
    )
    access = select(InAppNotification.id).where(
        InAppNotification.kind == NotificationKind.ACCESS_CHANGED,
        InAppNotification.subject_type == "user",
        InAppNotification.work_id.is_(None),
        InAppNotification.subject_id == InAppNotification.recipient_id,
        InAppNotification.subject_id == user.id,
    )
    return select(InAppNotification.id).where(
        or_(
            InAppNotification.id.in_(failed_report),
            InAppNotification.id.in_(backup),
            InAppNotification.id.in_(assigned),
            InAppNotification.id.in_(invitation),
            InAppNotification.id.in_(publication),
            InAppNotification.id.in_(access),
        )
    )


def record_module_ids(db: Session, record_ids: set[UUID]) -> dict[UUID, UUID]:
    if not record_ids:
        return {}
    return {
        record_id: module_id
        for record_id, module_id in db.execute(
            select(Record.id, Record.module_id).where(Record.id.in_(record_ids))
        ).tuples()
    }


def version_sequences(db: Session, version_ids: set[UUID]) -> dict[UUID, int]:
    if not version_ids:
        return {}
    return {
        version_id: sequence
        for version_id, sequence in db.execute(
            select(SandboxVersion.id, SandboxVersion.sequence).where(
                SandboxVersion.id.in_(version_ids)
            )
        ).tuples()
    }
