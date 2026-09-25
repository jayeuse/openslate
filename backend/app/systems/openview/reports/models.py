"""Audited persistence for saved Report recipes and retained runs."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel
from app.core.database.base import Base


class Report(BaseModel):
    """A revisioned recipe scoped to one module; reads remain owner-private for now."""

    __tablename__ = "reports"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"recipe"})
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_reports_name_nonempty"),
        CheckConstraint("revision > 0", name="ck_reports_revision_positive"),
        CheckConstraint(
            "(audience_kind IN ('private', 'everyone') AND audience_role_id IS NULL "
            "AND audience_user_id IS NULL) OR "
            "(audience_kind = 'role' AND audience_role_id IS NOT NULL "
            "AND audience_user_id IS NULL) OR "
            "(audience_kind = 'user' AND audience_role_id IS NULL "
            "AND audience_user_id IS NOT NULL)",
            name="ck_reports_audience",
        ),
        Index("ix_reports_owner_module", "owner_id", "module_id"),
        Index("ix_reports_module", "module_id"),
        Index("ix_reports_audience_role_id", "audience_role_id"),
        Index("ix_reports_audience_user_id", "audience_user_id"),
    )

    owner_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    subtitle: Mapped[str | None] = mapped_column(String(160), nullable=True)
    audience_kind: Mapped[str] = mapped_column(
        String(20), default="private", server_default=text("'private'"), nullable=False
    )
    audience_role_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=True
    )
    audience_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
    recipe: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)


class ReportRun(BaseModel):
    """An immutable, successful output snapshot retained with its Report."""

    __tablename__ = "report_runs"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"recipe", "headings", "csv_bytes"}
    )
    __table_args__ = (
        CheckConstraint("recipe_revision > 0", name="ck_report_runs_recipe_revision_positive"),
        CheckConstraint("row_count >= 0", name="ck_report_runs_row_count_nonnegative"),
        UniqueConstraint("report_id", "idempotency_key", name="uq_report_runs_idempotency"),
        Index("ix_report_runs_report_created", "report_id", "created_at"),
        Index("ix_report_runs_module", "module_id"),
    )

    report_id: Mapped[UUID] = mapped_column(
        ForeignKey("reports.id", ondelete="RESTRICT"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False
    )
    idempotency_key: Mapped[UUID] = mapped_column(nullable=False)
    recipe_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    recipe: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    headings: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False)
    csv_bytes: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)


class ReportRunRow(BaseModel):
    """One ordered, output-ready row with a restrictive source-record reference."""

    __tablename__ = "report_run_rows"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"cells"})
    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_report_run_rows_position_nonnegative"),
        UniqueConstraint("run_id", "position", name="uq_report_run_rows_position"),
        UniqueConstraint("run_id", "record_id", name="uq_report_run_rows_record"),
        Index("ix_report_run_rows_record", "record_id"),
    )

    run_id: Mapped[UUID] = mapped_column(
        ForeignKey("report_runs.id", ondelete="RESTRICT"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    record_id: Mapped[UUID] = mapped_column(
        ForeignKey("records.id", ondelete="RESTRICT"), nullable=False
    )
    cells: Mapped[list[str | None]] = mapped_column(JSONB, nullable=False)


class ReportRunEligibleUser(Base):
    """Immutable eligibility at run creation; current Report access is checked separately."""

    __tablename__ = "report_run_eligible_users"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (Index("ix_report_run_eligible_users_user_run", "user_id", "run_id"),)

    run_id: Mapped[UUID] = mapped_column(
        ForeignKey("report_runs.id", ondelete="RESTRICT"), primary_key=True
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True
    )
