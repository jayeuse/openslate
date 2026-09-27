"""Persistent singleton Sandbox design document and immutable history."""

from __future__ import annotations

from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel


class SandboxDocument(BaseModel):
    """The one shared Sandbox design draft for this deployment."""

    __tablename__ = "sandbox_documents"
    __table_args__ = (
        CheckConstraint("singleton_key = true", name="ck_sandbox_documents_singleton_key"),
        CheckConstraint("schema_version = 3", name="ck_sandbox_documents_schema_version"),
        CheckConstraint("revision > 0", name="ck_sandbox_documents_revision_positive"),
        CheckConstraint("byte_count >= 0", name="ck_sandbox_documents_byte_count_nonnegative"),
        CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_sandbox_documents_not_deleted"
        ),
        UniqueConstraint("singleton_key", name="uq_sandbox_documents_singleton_key"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"document"})

    singleton_key: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
    )
    schema_version: Mapped[int] = mapped_column(
        Integer, default=3, server_default=text("3"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
    document: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_count: Mapped[int] = mapped_column(Integer, nullable=False)
    versions: Mapped[list[SandboxVersion]] = relationship(back_populates="document_row")


class SandboxVersion(BaseModel):
    """Immutable Sandbox document snapshot with mutable checkpoint metadata only."""

    __tablename__ = "sandbox_versions"
    __table_args__ = (
        CheckConstraint("sequence > 0", name="ck_sandbox_versions_sequence_positive"),
        CheckConstraint(
            "source_document_revision > 0", name="ck_sandbox_versions_source_revision_positive"
        ),
        CheckConstraint(
            "metadata_revision > 0", name="ck_sandbox_versions_metadata_revision_positive"
        ),
        CheckConstraint("byte_count >= 0", name="ck_sandbox_versions_byte_count_nonnegative"),
        CheckConstraint(
            "kind IN ('checkpoint', 'published', 'imported')",
            name="ck_sandbox_versions_kind",
        ),
        CheckConstraint(
            "snapshot ->> 'schemaVersion' = '3'", name="ck_sandbox_versions_schema_version"
        ),
        UniqueConstraint("document_id", "sequence", name="uq_sandbox_versions_document_sequence"),
        Index("ix_sandbox_versions_source_version", "source_version_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"snapshot", "note"})

    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("sandbox_documents.id", ondelete="RESTRICT"), nullable=False
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str] = mapped_column(String(80), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_document_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    source_version_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("sandbox_versions.id", ondelete="RESTRICT", use_alter=True), nullable=True
    )
    snapshot: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_count: Mapped[int] = mapped_column(Integer, nullable=False)
    metadata_revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
    document_row: Mapped[SandboxDocument] = relationship(back_populates="versions")
