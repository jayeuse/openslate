"""Publication bindings and immutable request evidence for Sandbox draft application."""

from __future__ import annotations

from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class SandboxBinding(BaseModel):
    """One designer entity ID bound to exactly one operational entity."""

    __tablename__ = "sandbox_bindings"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('department', 'module', 'field', 'relationship', 'trigger')",
            name="ck_sandbox_bindings_kind",
        ),
        CheckConstraint(
            "(kind = 'department' AND department_id IS NOT NULL "
            "AND module_id IS NULL AND field_id IS NULL AND trigger_id IS NULL) "
            "OR (kind = 'module' AND department_id IS NULL "
            "AND module_id IS NOT NULL AND field_id IS NULL AND trigger_id IS NULL) "
            "OR (kind IN ('field', 'relationship') AND department_id IS NULL "
            "AND module_id IS NULL AND field_id IS NOT NULL AND trigger_id IS NULL) "
            "OR (kind = 'trigger' AND department_id IS NULL "
            "AND module_id IS NULL AND field_id IS NULL AND trigger_id IS NOT NULL)",
            name="ck_sandbox_bindings_exactly_one_live_target",
        ),
        UniqueConstraint("kind", "sandbox_id", name="uq_sandbox_bindings_kind_sandbox_id"),
        UniqueConstraint("department_id", name="uq_sandbox_bindings_department_id"),
        UniqueConstraint("module_id", name="uq_sandbox_bindings_module_id"),
        UniqueConstraint("field_id", name="uq_sandbox_bindings_field_id"),
        UniqueConstraint("trigger_id", name="uq_sandbox_bindings_trigger_id"),
    )

    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    sandbox_id: Mapped[str] = mapped_column(String(1_000), nullable=False)
    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=True
    )
    module_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=True
    )
    field_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"), nullable=True
    )
    trigger_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("record_triggers.id", ondelete="RESTRICT"), nullable=True
    )


class SandboxPublication(BaseModel):
    """Immutable published application and its idempotent response evidence."""

    __tablename__ = "sandbox_publications"
    __table_args__ = (
        CheckConstraint("document_revision > 0", name="ck_sandbox_publications_document_revision"),
        CheckConstraint("length(document_hash) = 64", name="ck_sandbox_publications_document_hash"),
        CheckConstraint("length(impact_digest) = 64", name="ck_sandbox_publications_impact_digest"),
        CheckConstraint(
            "length(live_state_digest) = 64", name="ck_sandbox_publications_live_digest"
        ),
        CheckConstraint(
            "length(request_fingerprint) = 64", name="ck_sandbox_publications_request_fingerprint"
        ),
        CheckConstraint(
            "length(preview_token_digest) = 64", name="ck_sandbox_publications_preview_token_digest"
        ),
        UniqueConstraint("actor_id", "idempotency_key", name="uq_sandbox_publications_actor_key"),
        UniqueConstraint(
            "preview_token_digest", name="uq_sandbox_publications_preview_token_digest"
        ),
        UniqueConstraint("version_id", name="uq_sandbox_publications_version"),
        Index("ix_sandbox_publications_document_created", "document_id", "created_at"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"note", "idempotency_key", "request_fingerprint", "preview_token_digest", "response_body"}
    )

    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("sandbox_documents.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    version_id: Mapped[UUID] = mapped_column(
        ForeignKey("sandbox_versions.id", ondelete="RESTRICT"), nullable=False
    )
    actor_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT", use_alter=True), nullable=False, index=True
    )
    document_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    document_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    impact_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    live_state_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    preview_token_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    response_body: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
