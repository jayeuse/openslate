"""Audited saved queries owned by their source module's department."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class Chart(BaseModel):
    """One revisioned chart definition, without materialized record data."""

    __tablename__ = "charts"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"query"})
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_charts_name_nonempty"),
        CheckConstraint("revision > 0", name="ck_charts_revision_positive"),
        CheckConstraint(
            "chart_type IN ('bar', 'line', 'pie', 'summary', 'workload', 'records')",
            name="ck_charts_type",
        ),
        Index("ix_charts_department_id", "department_id"),
        Index("ix_charts_module_id", "module_id"),
    )

    department_id: Mapped[UUID] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    chart_type: Mapped[str] = mapped_column(String(20), nullable=False)
    query: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
