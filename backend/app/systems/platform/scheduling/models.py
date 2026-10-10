"""Persisted typed work occurrences and reference-only in-app notifications."""

from datetime import datetime
from enum import StrEnum
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
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


class ScheduledWork(Base):
    """One durable, idempotent source occurrence; no output is copied here."""

    __tablename__ = "scheduled_work"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "kind IN ('report-run', 'post-publish', 'event-reminder')",
            name="ck_scheduled_work_kind",
        ),
        CheckConstraint(
            "(kind = 'report-run' AND report_id IS NOT NULL AND post_id IS NULL "
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
            "AND run_id IS NULL)",
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
            "(kind = 'event-reminder' AND run_id IS NULL AND publication_result_id IS NULL)",
            name="ck_scheduled_work_run",
        ),
        UniqueConstraint("report_id", "scheduled_for", name="uq_scheduled_work_report_occurrence"),
        UniqueConstraint("post_id", "source_revision", name="uq_scheduled_work_post_occurrence"),
        UniqueConstraint("reminder_id", "occurrence_start_at", name="uq_scheduled_work_reminder"),
        UniqueConstraint("run_id", name="uq_scheduled_work_run"),
        Index("ix_scheduled_work_due", "kind", "state", "next_attempt_at", "id"),
        Index("ix_scheduled_work_expired", "kind", "state", "lease_expires_at", "id"),
        Index("ix_scheduled_work_scheduling_actor_id", "scheduling_actor_id"),
        Index("ix_scheduled_work_publication_result_id", "publication_result_id"),
    )

    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    kind: Mapped[WorkKind] = mapped_column(
        String(24), nullable=False, default=WorkKind.REPORT_RUN, server_default=text("'report-run'")
    )
    report_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("reports.id", ondelete="RESTRICT"), nullable=True
    )
    post_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_posts.id", ondelete="RESTRICT"), nullable=True
    )
    reminder_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_event_reminders.id", ondelete="RESTRICT"), nullable=True
    )
    occurrence_start_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    source_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scheduling_actor_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    publication_result_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_post_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    state: Mapped[WorkState] = mapped_column(String(16), nullable=False, default=WorkState.PENDING)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_attempt_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    run_id: Mapped[UUID | None] = mapped_column(ForeignKey("report_runs.id", ondelete="RESTRICT"))
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


class InAppNotification(BaseModel):
    """A recipient-specific source reference without private content."""

    __tablename__ = "in_app_notifications"
    __table_args__ = (
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
            "AND subject_id = recipient_id)",
            name="ck_in_app_notifications_reference",
        ),
        UniqueConstraint("work_id", "recipient_id", name="uq_in_app_notifications_work_recipient"),
        Index("ix_in_app_notifications_recipient_created", "recipient_id", "created_at", "id"),
        Index(
            "ix_in_app_notifications_recipient_unread",
            "recipient_id",
            "created_at",
            "id",
            postgresql_where=text("read_at IS NULL AND is_deleted = false"),
        ),
    )

    kind: Mapped[NotificationKind] = mapped_column(String(32), nullable=False)
    subject_type: Mapped[str] = mapped_column(String(24), nullable=False)
    subject_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    work_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("scheduled_work.id", ondelete="RESTRICT"), nullable=True
    )
    recipient_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
