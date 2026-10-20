"""Typed Comms work sources and content-free retention/capture metadata."""

from datetime import date, datetime
from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class CommsSchedule(BaseModel):
    __tablename__ = "comms_schedules"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"request"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_schedules_org_id_id"),
        UniqueConstraint("org_id", "author_id", "client_key", name="uq_comms_schedules_client_key"),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_schedules_conversation",
            ondelete="RESTRICT",
        ),
        CheckConstraint("jsonb_typeof(request) = 'object'", name="ck_comms_schedules_request"),
        CheckConstraint("revision BETWEEN 1 AND 2147483647", name="ck_comms_schedules_revision"),
        Index("ix_comms_schedules_author", "org_id", "author_id"),
        Index("ix_comms_schedules_conversation", "org_id", "conversation_id"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    client_key: Mapped[UUID] = mapped_column(nullable=False)
    request: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))


class CommsExport(BaseModel):
    __tablename__ = "comms_exports"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"request", "artifact_key", "artifact_sha256", "authorization_digest"},
    )
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_exports_org_id_id"),
        CheckConstraint("jsonb_typeof(request) = 'object'", name="ck_comms_exports_request"),
        CheckConstraint(
            "artifact_size IS NULL OR artifact_size BETWEEN 0 AND 8388608",
            name="ck_comms_exports_artifact_size",
        ),
        CheckConstraint(
            "artifact_key IS NULL OR artifact_key = 'org/' || org_id::text || '/' "
            "|| replace(id::text, '-', '')",
            name="ck_comms_exports_artifact_key",
        ),
        CheckConstraint(
            "(artifact_key IS NULL AND artifact_size IS NULL AND artifact_sha256 IS NULL) OR "
            "(artifact_key IS NOT NULL AND artifact_size IS NOT NULL "
            "AND artifact_sha256 IS NOT NULL)",
            name="ck_comms_exports_artifact_complete",
        ),
        Index("ix_comms_exports_requester", "org_id", "requested_by"),
        Index("ix_comms_exports_cleanup", "org_id", "cleanup_pending"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    requested_by: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    request: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    private_verified: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    authorization_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    artifact_key: Mapped[str | None] = mapped_column(Text)
    artifact_sha256: Mapped[str | None] = mapped_column(String(64))
    artifact_size: Mapped[int | None] = mapped_column(BigInteger)
    artifact_upload_confirmed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    cleanup_pending: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    cleanup_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CommsExportSource(BaseModel):
    __tablename__ = "comms_export_sources"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_export_sources_org_id_id"),
        UniqueConstraint(
            "org_id", "export_id", "conversation_id", name="uq_comms_export_sources_binding"
        ),
        ForeignKeyConstraint(
            ["org_id", "export_id"],
            ["comms_exports.org_id", "comms_exports.id"],
            name="fk_comms_export_sources_export",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_export_sources_conversation",
            ondelete="RESTRICT",
        ),
        Index("ix_comms_export_sources_conversation", "org_id", "conversation_id"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    export_id: Mapped[UUID] = mapped_column(nullable=False)
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    private_at_capture: Mapped[bool] = mapped_column(Boolean, nullable=False)


class CommsExportEntry(BaseModel):
    __tablename__ = "comms_export_entries"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_export_entries_org_id_id"),
        UniqueConstraint(
            "org_id", "export_id", "message_id", name="uq_comms_export_entries_message"
        ),
        ForeignKeyConstraint(
            ["org_id", "export_id", "conversation_id"],
            [
                "comms_export_sources.org_id",
                "comms_export_sources.export_id",
                "comms_export_sources.conversation_id",
            ],
            name="fk_comms_export_entries_source",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_export_entries_message",
            ondelete="RESTRICT",
        ),
        Index("ix_comms_export_entries_expiry", "org_id", "message_id"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    export_id: Mapped[UUID] = mapped_column(nullable=False)
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    message_id: Mapped[UUID] = mapped_column(nullable=False)


class CommsExpiredSend(BaseModel):
    """Identity fence after content/anchor deletion, never a copy of the message or fingerprint."""

    __tablename__ = "comms_expired_sends"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_expired_sends_org_id_id"),
        UniqueConstraint("org_id", "author_id", "client_key", name="uq_comms_expired_sends_key"),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_expired_sends_conversation",
            ondelete="RESTRICT",
        ),
        Index("ix_comms_expired_sends_conversation", "org_id", "conversation_id"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    client_key: Mapped[UUID] = mapped_column(nullable=False)


class CommsRetentionPolicy(BaseModel):
    __tablename__ = "comms_retention_policies"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_retention_policies_org_id_id"),
        UniqueConstraint(
            "org_id",
            "conversation_id",
            name="uq_comms_retention_policies_scope",
            postgresql_nulls_not_distinct=True,
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_retention_policies_conversation",
            ondelete="RESTRICT",
        ),
        CheckConstraint(
            "conversation_id IS NOT NULL OR (message_days IS NOT NULL AND file_days IS NOT NULL)",
            name="ck_comms_retention_policies_workspace",
        ),
        CheckConstraint(
            "message_days IS NULL OR message_days BETWEEN 0 AND 9007199254740991",
            name="ck_comms_retention_policies_messages",
        ),
        CheckConstraint(
            "file_days IS NULL OR file_days BETWEEN 0 AND 9007199254740991",
            name="ck_comms_retention_policies_files",
        ),
        CheckConstraint(
            "revision BETWEEN 1 AND 2147483647", name="ck_comms_retention_policies_revision"
        ),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    conversation_id: Mapped[UUID | None] = mapped_column()
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    message_days: Mapped[int | None] = mapped_column(BigInteger)
    file_days: Mapped[int | None] = mapped_column(BigInteger)
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))


class CommsRetentionSweep(BaseModel):
    __tablename__ = "comms_retention_sweeps"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_retention_sweeps_org_id_id"),
        UniqueConstraint("org_id", "day", "policy_digest", name="uq_comms_retention_sweeps_run"),
        CheckConstraint(
            "message_count >= 0 AND anchor_count >= 0 AND file_count >= 0",
            name="ck_comms_retention_sweeps_counts",
        ),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    day: Mapped[date] = mapped_column(Date, nullable=False)
    policy_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    message_count: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    anchor_count: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    file_count: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(48))
    cursor_id: Mapped[UUID | None] = mapped_column()
    erasure_done: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    file_cursor_id: Mapped[UUID | None] = mapped_column()
    export_cursor_id: Mapped[UUID | None] = mapped_column()
