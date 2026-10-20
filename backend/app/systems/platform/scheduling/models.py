"""Persisted typed work occurrences and reference-only in-app notifications."""

from datetime import datetime
from enum import StrEnum
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from app.core.base_model import BaseModel, utc_now
from app.core.database.base import Base


class WorkState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


class WorkKind(StrEnum):
    REPORT_RUN = "report-run"
    POST_PUBLISH = "post-publish"
    EVENT_REMINDER = "event-reminder"
    COMMS_SCHEDULED_MESSAGE = "comms-scheduled-message"
    COMMS_EXPORT = "comms-export"


class ScheduledWork(Base):
    """One durable, idempotent source occurrence; no output is copied here."""

    __tablename__ = "scheduled_work"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_scheduled_work_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "comms_schedule_id"],
            ["comms_schedules.org_id", "comms_schedules.id"],
            name="fk_scheduled_work_comms_schedule",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "comms_export_id"],
            ["comms_exports.org_id", "comms_exports.id"],
            name="fk_scheduled_work_comms_export",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "comms_message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_scheduled_work_comms_message",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "report_id"],
            ["reports.org_id", "reports.id"],
            name="fk_scheduled_work_report_id_reports",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_scheduled_work_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "reminder_id"],
            ["board_event_reminders.org_id", "board_event_reminders.id"],
            name="fk_scheduled_work_reminder_id_board_event_reminders",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "publication_result_id"],
            ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_scheduled_work_publication_result_id_board_post_revisions",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "run_id"],
            ["report_runs.org_id", "report_runs.id"],
            name="fk_scheduled_work_run_id_report_runs",
            ondelete="RESTRICT",
        ),
        CheckConstraint(
            "kind IN ('report-run', 'post-publish', 'event-reminder', "
            "'comms-scheduled-message', 'comms-export')",
            name="ck_scheduled_work_kind",
        ),
        CheckConstraint(
            "(((kind = 'report-run' AND report_id IS NOT NULL AND post_id IS NULL "
            "AND reminder_id IS NULL AND occurrence_start_at IS NULL "
            "AND source_revision IS NULL AND scheduling_actor_id IS NULL "
            "AND publication_result_id IS NULL) OR "
            "(kind = 'post-publish' AND report_id IS NULL "
            "AND reminder_id IS NULL AND occurrence_start_at IS NULL "
            "AND post_id IS NOT NULL AND source_revision IS NOT NULL "
            "AND source_revision > 0 AND scheduling_actor_id IS NOT NULL AND run_id IS NULL) OR "
            "(kind = 'event-reminder' AND report_id IS NULL AND post_id IS NULL "
            "AND reminder_id IS NOT NULL AND occurrence_start_at IS NOT NULL "
            "AND source_revision IS NULL "
            "AND scheduling_actor_id IS NULL AND publication_result_id IS NULL "
            "AND run_id IS NULL)) AND comms_schedule_id IS NULL AND comms_export_id IS NULL "
            "AND comms_message_id IS NULL) OR "
            "(kind = 'comms-scheduled-message' AND comms_schedule_id IS NOT NULL "
            "AND comms_export_id IS NULL AND report_id IS NULL AND post_id IS NULL "
            "AND reminder_id IS NULL AND occurrence_start_at IS NULL AND run_id IS NULL "
            "AND publication_result_id IS NULL AND scheduling_actor_id IS NOT NULL "
            "AND source_revision IS NOT NULL AND source_revision > 0) OR "
            "(kind = 'comms-export' AND comms_export_id IS NOT NULL AND comms_schedule_id IS NULL "
            "AND comms_message_id IS NULL AND report_id IS NULL AND post_id IS NULL "
            "AND reminder_id IS NULL AND occurrence_start_at IS NULL AND run_id IS NULL "
            "AND publication_result_id IS NULL AND scheduling_actor_id IS NOT NULL "
            "AND source_revision IS NULL)",
            name="ck_scheduled_work_source",
        ),
        CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'failed', 'canceled')",
            name="ck_scheduled_work_state",
        ),
        CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5", name="ck_scheduled_work_attempt_count"
        ),
        CheckConstraint(
            "(state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) "
            "OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)",
            name="ck_scheduled_work_lease",
        ),
        CheckConstraint(
            "(kind = 'report-run' AND ((state = 'succeeded' AND run_id IS NOT NULL) "
            "OR (state <> 'succeeded' AND run_id IS NULL))) OR "
            "(kind = 'post-publish' AND "
            "((state = 'succeeded' AND publication_result_id IS NOT NULL) "
            "OR (state <> 'succeeded' AND publication_result_id IS NULL))) OR "
            "(kind IN ('event-reminder','comms-export') AND run_id IS NULL "
            "AND publication_result_id IS NULL) OR "
            "(kind = 'comms-scheduled-message' AND ((state = 'succeeded' "
            "AND comms_message_id IS NOT NULL) "
            "OR (state <> 'succeeded' AND comms_message_id IS NULL)))",
            name="ck_scheduled_work_run",
        ),
        UniqueConstraint("report_id", "scheduled_for", name="uq_scheduled_work_report_occurrence"),
        UniqueConstraint("post_id", "source_revision", name="uq_scheduled_work_post_occurrence"),
        UniqueConstraint("reminder_id", "occurrence_start_at", name="uq_scheduled_work_reminder"),
        UniqueConstraint("run_id", name="uq_scheduled_work_run"),
        UniqueConstraint("comms_schedule_id", name="uq_scheduled_work_comms_schedule"),
        UniqueConstraint("comms_export_id", name="uq_scheduled_work_comms_export"),
        Index("ix_scheduled_work_comms_message", "org_id", "comms_message_id"),
        Index("ix_scheduled_work_due", "kind", "state", "next_attempt_at", "id"),
        Index("ix_scheduled_work_expired", "kind", "state", "lease_expires_at", "id"),
        Index("ix_scheduled_work_scheduling_actor_id", "scheduling_actor_id"),
        Index("ix_scheduled_work_publication_result_id", "publication_result_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    kind: Mapped[WorkKind] = mapped_column(
        String(24), nullable=False, default=WorkKind.REPORT_RUN, server_default=text("'report-run'")
    )
    report_id: Mapped[UUID | None] = mapped_column(nullable=True)
    comms_schedule_id: Mapped[UUID | None] = mapped_column(nullable=True)
    comms_export_id: Mapped[UUID | None] = mapped_column(nullable=True)
    comms_message_id: Mapped[UUID | None] = mapped_column(nullable=True)
    post_id: Mapped[UUID | None] = mapped_column(nullable=True)
    reminder_id: Mapped[UUID | None] = mapped_column(nullable=True)
    occurrence_start_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    source_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scheduling_actor_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    publication_result_id: Mapped[UUID | None] = mapped_column(nullable=True)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    state: Mapped[WorkState] = mapped_column(String(16), nullable=False, default=WorkState.PENDING)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_attempt_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    run_id: Mapped[UUID | None] = mapped_column()
    failure_code: Mapped[str | None] = mapped_column(String(48))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class NotificationKind(StrEnum):
    REPORT_RUN = "report-run"
    POST_PUBLISH = "post-publish"
    EVENT_REMINDER = "event-reminder"
    REPORT_RUN_FAILED = "report-run-failed"
    BACKUP_FAILED = "backup-failed"
    RECORD_ASSIGNED = "record-assigned"
    INVITATION_ACCEPTED = "invitation-accepted"
    SANDBOX_PUBLISHED = "sandbox-published"
    ACCESS_CHANGED = "access-changed"
    COMMS_MENTION = "comms-mention"
    COMMS_DIRECT = "comms-direct"
    COMMS_THREAD_REPLY = "comms-thread-reply"
    COMMS_KEYWORD = "comms-keyword"


class InAppNotification(BaseModel):
    """A recipient-specific source reference without private content."""

    __tablename__ = "in_app_notifications"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_in_app_notifications_org_id_id"),
        CheckConstraint(
            "(kind = 'backup-failed') = (org_id IS NULL)",
            name="ck_in_app_notifications_organization",
        ),
        ForeignKeyConstraint(
            ["org_id", "work_id"],
            ["scheduled_work.org_id", "scheduled_work.id"],
            name="fk_in_app_notifications_work_id_scheduled_work",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "comms_conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_in_app_notifications_comms_conversation",
            ondelete="RESTRICT",
        ),
        CheckConstraint(
            "(subject_type = 'comms_message') = (comms_conversation_id IS NOT NULL)",
            name="ck_in_app_notifications_comms_reference",
        ),
        CheckConstraint(
            "(kind = 'report-run' AND subject_type = 'report_run' AND work_id IS NOT NULL) OR "
            "(kind = 'post-publish' AND subject_type = 'board_post' AND work_id IS NOT NULL) OR "
            "(kind = 'event-reminder' AND subject_type = 'board_event' AND work_id IS NOT NULL) OR "
            "(kind = 'report-run-failed' AND subject_type = 'scheduled_work' "
            "AND work_id IS NOT NULL AND subject_id = work_id) OR "
            "(kind = 'backup-failed' AND subject_type = 'backup_run' AND work_id IS NULL) OR "
            "(kind = 'record-assigned' AND subject_type = 'record' AND work_id IS NULL) OR "
            "(kind = 'invitation-accepted' AND subject_type = 'user' AND work_id IS NULL) OR "
            "(kind = 'sandbox-published' AND subject_type = 'sandbox_version' "
            "AND work_id IS NULL) OR "
            "(kind = 'access-changed' AND subject_type = 'user' AND work_id IS NULL "
            "AND subject_id = recipient_id) OR "
            "(kind IN ('comms-mention','comms-direct','comms-thread-reply','comms-keyword') "
            "AND subject_type = 'comms_message' AND work_id IS NULL AND org_id IS NOT NULL)",
            name="ck_in_app_notifications_reference",
        ),
        UniqueConstraint("work_id", "recipient_id", name="uq_in_app_notifications_work_recipient"),
        Index(
            "uq_in_app_notifications_comms_recipient",
            "org_id",
            "recipient_id",
            "subject_id",
            unique=True,
            postgresql_where=text("subject_type = 'comms_message'"),
        ),
        Index("ix_in_app_notifications_recipient_created", "recipient_id", "created_at", "id"),
        Index(
            "ix_in_app_notifications_recipient_unread",
            "recipient_id",
            "created_at",
            "id",
            postgresql_where=text("read_at IS NULL AND is_deleted = false"),
        ),
    )

    org_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True
    )
    kind: Mapped[NotificationKind] = mapped_column(String(32), nullable=False)
    subject_type: Mapped[str] = mapped_column(String(24), nullable=False)
    subject_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    work_id: Mapped[UUID | None] = mapped_column(nullable=True)
    comms_conversation_id: Mapped[UUID | None] = mapped_column(nullable=True)
    recipient_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
