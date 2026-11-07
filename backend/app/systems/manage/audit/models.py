from datetime import datetime
from enum import StrEnum
from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.base import Base


class AuditAction(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"


class SecurityEventOutcome(StrEnum):
    ATTEMPT = "attempt"
    SUCCESS = "success"
    DENIED = "denied"
    FAILURE = "failure"
    PARTIAL = "partial"


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "action IN ('create', 'update', 'delete')",
            name="ck_audit_logs_action",
        ),
        CheckConstraint(
            "org_id IS NOT NULL OR entity_type IN ('users','platform_settings',"
            "'platform_operators','backup_policies','backup_runs','backup_export_operations',"
            "'update_statuses') OR COALESCE(("
            "COALESCE(NULLIF(\"after\", 'null'::jsonb), \"before\") -> 'org_id' = 'null'::jsonb "
            "AND ((entity_type = 'files' AND COALESCE(NULLIF(\"after\", 'null'::jsonb), "
            "\"before\") ->> 'purpose' = 'user_avatar') OR "
            "(entity_type = 'in_app_notifications' AND COALESCE(NULLIF(\"after\", 'null'::jsonb), "
            "\"before\") ->> 'kind' = 'backup-failed'))), false)",
            name="ck_audit_logs_organization",
        ),
        # Row-level security reads this one: it is the only index that leads with org_id.
        Index("ix_audit_logs_org_created_at_id", "org_id", "created_at", "id"),
        Index("ix_audit_logs_created_at_id", "created_at", "id"),
        Index(
            "ix_audit_logs_department_created_at_id",
            "department_id",
            "created_at",
            "id",
            postgresql_where=text("department_id IS NOT NULL"),
        ),
        Index("ix_audit_logs_entity", "entity_type", "entity_id", "created_at"),
        Index(
            "ix_audit_logs_actor",
            "performed_by",
            "created_at",
            postgresql_where=text("performed_by IS NOT NULL"),
        ),
        Index(
            "ix_audit_logs_request",
            "request_id",
            postgresql_where=text("request_id IS NOT NULL"),
        ),
        Index("ix_audit_logs_action", "action"),
        {"postgresql_partition_by": "RANGE (created_at)"},
    )

    org_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True
    )
    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    # In the key because a partitioned table's key must hold its partition column.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), primary_key=True, default=utc_now
    )
    # No foreign key (D21): removing a person must never rewrite a sealed audit row, so a
    # removed person's id stays with no name, as `security_events.actor_id` does.
    performed_by: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=True)
    action: Mapped[AuditAction] = mapped_column(String(50), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=True)
    department_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=True)
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    request_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=True)
    request_method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    request_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor_label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)



class AuditSeal(Base):
    """One hour of one chain: an organization's audit rows, or the installation's (NULL).

    The runtime may only add a seal; `audit_seals` grants and policies are in the revision.
    """

    __tablename__ = "audit_seals"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint(
            "org_id", "hour_start", name="uq_audit_seals_org_hour",
            postgresql_nulls_not_distinct=True,
        ),
        CheckConstraint("row_count >= 0", name="ck_audit_seals_row_count"),
        CheckConstraint("octet_length(rows_hash) = 32", name="ck_audit_seals_rows_hash"),
        CheckConstraint("octet_length(chain_hash) = 32", name="ck_audit_seals_chain_hash"),
        # The chain hash holds whole seconds and the job keys hours by their start (F1).
        CheckConstraint(
            "(extract(epoch FROM hour_start) % 3600) = 0", name="ck_audit_seals_whole_hour"
        ),
    )

    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    org_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True
    )
    hour_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    row_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    rows_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    chain_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    form: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    sealed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )

class SecurityEvent(Base):
    __tablename__ = "security_events"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_security_events_org_id_id"),
        CheckConstraint(
            "outcome IN ('attempt', 'success', 'denied', 'failure', 'partial')",
            name="ck_security_events_outcome",
        ),
        Index("ix_security_events_occurred_at_id", "occurred_at", "id"),
        Index("ix_security_events_operation_id", "operation_id"),
    )

    org_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True
    )
    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    outcome: Mapped[SecurityEventOutcome] = mapped_column(String(20), nullable=False)
    source: Mapped[str] = mapped_column(String(100), nullable=False)
    operation_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), nullable=False
    )
    actor_id: Mapped[UUID | None] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        nullable=True,
    )
    subject_id: Mapped[UUID | None] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        nullable=True,
    )
    labels: Mapped[dict[str, object]] = mapped_column(
        JSONB,
        default=dict,
        server_default=text("'{}'::jsonb"),
        nullable=False,
    )
    fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)
    reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    request_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=True)
    request_method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    request_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ``metadata`` is reserved by SQLAlchemy's declarative base, so the Python
    # attribute uses a more specific name while the database column keeps the
    # public schema name.
    event_metadata: Mapped[dict[str, object]] = mapped_column(
        "metadata",
        JSONB,
        default=dict,
        server_default=text("'{}'::jsonb"),
        nullable=False,
    )
