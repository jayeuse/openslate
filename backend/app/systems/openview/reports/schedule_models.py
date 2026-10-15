"""Audited per-Report policy for local wall-clock scheduled runs."""

from datetime import datetime, time
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Time,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class ReportSchedule(BaseModel):
    """One revisioned policy and durable UTC due cursor for a Report."""

    __tablename__ = "report_schedules"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_report_schedules_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "report_id"], ["reports.org_id", "reports.id"],
            name="fk_report_schedules_report_id_reports", ondelete="RESTRICT",
        ),
        CheckConstraint("revision > 0", name="ck_report_schedules_revision_positive"),
        CheckConstraint(
            "cadence IN ('daily', 'weekly', 'monthly')",
            name="ck_report_schedules_cadence",
        ),
        CheckConstraint(
            "(cadence = 'daily' AND weekday IS NULL AND month_day IS NULL) OR "
            "(cadence = 'weekly' AND weekday BETWEEN 0 AND 6 AND month_day IS NULL) OR "
            "(cadence = 'monthly' AND weekday IS NULL AND month_day BETWEEN 1 AND 31)",
            name="ck_report_schedules_anchor",
        ),
        CheckConstraint(
            "EXTRACT(SECOND FROM local_time) = 0",
            name="ck_report_schedules_minute_time",
        ),
        CheckConstraint(
            "length(btrim(timezone_name)) > 0",
            name="ck_report_schedules_timezone_nonempty",
        ),
        UniqueConstraint("report_id", name="uq_report_schedules_report"),
        Index("ix_report_schedules_due", "enabled", "next_due_at", "id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    report_id: Mapped[UUID] = mapped_column(nullable=False)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    cadence: Mapped[str] = mapped_column(String(8), nullable=False)
    timezone_name: Mapped[str] = mapped_column(String(64), nullable=False)
    local_time: Mapped[time] = mapped_column(Time(timezone=False), nullable=False)
    weekday: Mapped[int | None] = mapped_column(Integer)
    month_day: Mapped[int | None] = mapped_column(Integer)
    next_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
