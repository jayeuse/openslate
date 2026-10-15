"""Audited persistence for saved Report recipes and retained runs."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
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
    """A revisioned recipe of one module. Module readers read it; managers change it."""

    __tablename__ = "reports"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"recipe"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_reports_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_reports_module_id_modules", ondelete="RESTRICT",
        ),
        CheckConstraint("length(btrim(name)) > 0", name="ck_reports_name_nonempty"),
        CheckConstraint("revision > 0", name="ck_reports_revision_positive"),
        Index("ix_reports_module", "module_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    subtitle: Mapped[str | None] = mapped_column(String(160), nullable=True)
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
        UniqueConstraint("org_id", "id", name="uq_report_runs_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "report_id"], ["reports.org_id", "reports.id"],
            name="fk_report_runs_report_id_reports", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_report_runs_module_id_modules", ondelete="RESTRICT",
        ),
        CheckConstraint("recipe_revision > 0", name="ck_report_runs_recipe_revision_positive"),
        CheckConstraint("row_count >= 0", name="ck_report_runs_row_count_nonnegative"),
        UniqueConstraint("report_id", "idempotency_key", name="uq_report_runs_idempotency"),
        Index("ix_report_runs_report_created", "report_id", "created_at"),
        Index("ix_report_runs_module", "module_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    report_id: Mapped[UUID] = mapped_column(nullable=False)
    module_id: Mapped[UUID] = mapped_column(nullable=False)
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
        UniqueConstraint("org_id", "id", name="uq_report_run_rows_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "run_id"], ["report_runs.org_id", "report_runs.id"],
            name="fk_report_run_rows_run_id_report_runs", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "record_id"], ["records.org_id", "records.id"],
            name="fk_report_run_rows_record_id_records", ondelete="RESTRICT",
        ),
        CheckConstraint("position >= 0", name="ck_report_run_rows_position_nonnegative"),
        UniqueConstraint("run_id", "position", name="uq_report_run_rows_position"),
        UniqueConstraint("run_id", "record_id", name="uq_report_run_rows_record"),
        Index("ix_report_run_rows_record", "record_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    run_id: Mapped[UUID] = mapped_column(nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    record_id: Mapped[UUID] = mapped_column(nullable=False)
    cells: Mapped[list[str | None]] = mapped_column(JSONB, nullable=False)


class ReportRunEligibleUser(Base):
    """The module readers at run creation; current module read is checked again on each read."""

    __tablename__ = "report_run_eligible_users"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        ForeignKeyConstraint(
            ["org_id", "run_id"], ["report_runs.org_id", "report_runs.id"],
            name="fk_report_run_eligible_users_run_id_report_runs", ondelete="RESTRICT",
        ),
        Index("ix_report_run_eligible_users_user_run", "user_id", "run_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    run_id: Mapped[UUID] = mapped_column(primary_key=True)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True
    )
