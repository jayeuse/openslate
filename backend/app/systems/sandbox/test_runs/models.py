"""Persisted evidence from evaluating temporary Sandbox input values."""

from __future__ import annotations

from typing import ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class SandboxTestRun(BaseModel):
    """One immutable result from a temporary input evaluation."""

    __tablename__ = "sandbox_test_runs"
    __table_args__ = (
        CheckConstraint(
            "document_revision > 0", name="ck_sandbox_test_runs_document_revision_positive"
        ),
        CheckConstraint(
            "result_byte_count >= 0", name="ck_sandbox_test_runs_result_byte_count_nonnegative"
        ),
        Index("ix_sandbox_test_runs_document_created", "document_id", "created_at", "id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"input_values", "event", "result"}
    )

    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("sandbox_documents.id", ondelete="RESTRICT"), nullable=False
    )
    document_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    document_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    module_id: Mapped[str] = mapped_column(String(1_000), nullable=False)
    input_values: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    event: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    automation_ids: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    result: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    result_byte_count: Mapped[int] = mapped_column(Integer, nullable=False)
