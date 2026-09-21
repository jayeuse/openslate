"""Published Sandbox automation definitions and durable execution state."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class PublishedAutomationDefinition(BaseModel):
    """A durable executable definition produced by a publication."""

    __tablename__ = "published_automation_definitions"
    __table_args__ = (
        CheckConstraint(
            "trigger_kind IN ('record-created', 'field-changed', 'threshold-crossed', 'schedule')",
            name="ck_published_automation_definitions_trigger_kind",
        ),
        CheckConstraint(
            "priority >= -10000 AND priority <= 10000", name="ck_published_automation_priority"
        ),
        CheckConstraint(
            "execution_position >= 0", name="ck_published_automation_execution_position"
        ),
        CheckConstraint(
            "condition_operator IN ('all', 'any')",
            name="ck_published_automation_condition_operator",
        ),
        CheckConstraint(
            "trigger_value_kind IS NULL OR trigger_value_kind IN ('literal', 'field-reference')",
            name="ck_published_automation_trigger_value_kind",
        ),
        Index("ix_published_automation_definitions_module", "module_id", "is_deleted"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"trigger_literal_value"})

    publication_id: Mapped[UUID] = mapped_column(
        ForeignKey("sandbox_publications.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    published_version_id: Mapped[UUID] = mapped_column(
        ForeignKey("sandbox_versions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    publisher_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT", use_alter=True), nullable=False, index=True
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    priority: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    execution_position: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    trigger_kind: Mapped[str] = mapped_column(String(24), nullable=False)
    trigger_field_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    trigger_operator: Mapped[str | None] = mapped_column(String(2), nullable=True)
    trigger_value_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    trigger_literal_value: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    trigger_value_field_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    schedule_frequency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    schedule_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    schedule_weekday: Mapped[int | None] = mapped_column(Integer, nullable=True)
    workspace_timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    condition_operator: Mapped[str] = mapped_column(String(3), nullable=False, default="all")
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    suspension_reason: Mapped[str | None] = mapped_column(String(240))


class AutomationEventState(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class PublishedAutomationEvent(BaseModel):
    __tablename__ = "published_automation_events"
    __table_args__ = (
        CheckConstraint("depth >= 0 AND depth <= 10", name="ck_published_automation_events_depth"),
        CheckConstraint(
            "action_budget >= 0 AND action_budget <= 100",
            name="ck_published_automation_events_budget",
        ),
        CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5",
            name="ck_published_automation_events_attempt_count",
        ),
        CheckConstraint(
            "event_kind IN ('record-created', 'field-changed', 'schedule')",
            name="ck_published_automation_events_kind",
        ),
        CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_published_automation_events_state",
        ),
        CheckConstraint(
            "(depth = 0 AND root_event_id IS NULL) OR (depth > 0 AND root_event_id IS NOT NULL)",
            name="ck_published_automation_events_root_depth",
        ),
        CheckConstraint(
            "(event_kind = 'schedule' AND scheduled_automation_id IS NOT NULL) OR "
            "(event_kind IN ('record-created', 'field-changed') "
            "AND scheduled_automation_id IS NULL AND record_id IS NOT NULL)",
            name="ck_published_automation_events_subject",
        ),
        CheckConstraint(
            "(state = 'running' AND lease_token IS NOT NULL "
            "AND lease_expires_at IS NOT NULL) OR "
            "(state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)",
            name="ck_published_automation_events_lease",
        ),
        CheckConstraint(
            "(event_kind = 'schedule') OR (schedule_upper_record_id IS NULL "
            "AND schedule_cursor_record_id IS NULL AND schedule_matched_count = 0 "
            "AND schedule_action_count = 0)",
            name="ck_published_automation_events_schedule_progress",
        ),
        Index("ix_published_automation_events_due", "state", "next_attempt_at", "id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"values", "previous_values"})
    record_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("records.id", ondelete="RESTRICT"), index=True
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    scheduled_automation_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("published_automation_definitions.id", ondelete="RESTRICT"), index=True
    )
    event_kind: Mapped[str] = mapped_column(String(24), nullable=False)
    changed_field_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    values: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    previous_values: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    root_event_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("published_automation_events.id", ondelete="RESTRICT", use_alter=True),
        index=True,
    )
    depth: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    action_budget: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    schedule_upper_record_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    schedule_cursor_record_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    schedule_matched_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    schedule_action_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    schedule_key: Mapped[str | None] = mapped_column(String(120), unique=True)
    state: Mapped[AutomationEventState] = mapped_column(
        String(16), nullable=False, default=AutomationEventState.PENDING
    )
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lease_token: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PublishedAutomationRun(BaseModel):
    __tablename__ = "published_automation_runs"
    __table_args__ = (
        CheckConstraint(
            "state IN ('succeeded', 'skipped', 'suspended', 'failed')",
            name="ck_published_automation_runs_state",
        ),
        UniqueConstraint(
            "event_id", "automation_id", name="uq_published_automation_runs_event_automation"
        ),
        Index("ix_published_automation_runs_created", "created_at", "id"),
    )
    event_id: Mapped[UUID] = mapped_column(
        ForeignKey("published_automation_events.id", ondelete="RESTRICT"), nullable=False
    )
    automation_id: Mapped[UUID] = mapped_column(
        ForeignKey("published_automation_definitions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)


class PublishedAutomationCondition(BaseModel):
    """One same-module predicate attached to a published automation."""

    __tablename__ = "published_automation_conditions"
    __table_args__ = (
        CheckConstraint(
            "operator IN ('>', '>=', '<', '<=', '=', '!=')",
            name="ck_published_automation_conditions_operator",
        ),
        CheckConstraint("position >= 0", name="ck_published_automation_conditions_position"),
        CheckConstraint(
            "value_kind IN ('literal', 'field-reference')",
            name="ck_published_automation_conditions_value_kind",
        ),
        Index(
            "uq_published_automation_conditions_position_active",
            "automation_id",
            "position",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"literal_value"})

    automation_id: Mapped[UUID] = mapped_column(
        ForeignKey("published_automation_definitions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    field_id: Mapped[UUID] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    operator: Mapped[str] = mapped_column(String(2), nullable=False)
    value_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    literal_value: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    value_field_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"), nullable=True, index=True
    )


class PublishedAutomationAction(BaseModel):
    """One supported Set field action; other action kinds never publish."""

    __tablename__ = "published_automation_actions"
    __table_args__ = (
        CheckConstraint(
            "kind = 'set-field'", name="ck_published_automation_actions_supported_kind"
        ),
        CheckConstraint("position >= 0", name="ck_published_automation_actions_position"),
        CheckConstraint(
            "value_kind IN ('literal', 'field-reference')",
            name="ck_published_automation_actions_value_kind",
        ),
        Index(
            "uq_published_automation_actions_position_active",
            "automation_id",
            "position",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"literal_value"})

    automation_id: Mapped[UUID] = mapped_column(
        ForeignKey("published_automation_definitions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    target_field_id: Mapped[UUID] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False, default="set-field")
    value_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    literal_value: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    value_field_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"), nullable=True, index=True
    )
