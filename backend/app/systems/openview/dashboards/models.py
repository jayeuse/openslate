"""Audited persistence for department Dashboards and their widgets."""

from __future__ import annotations

from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel


class Dashboard(BaseModel):
    """A revisioned Dashboard that belongs to one department."""

    __tablename__ = "dashboards"
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_dashboards_name_nonempty"),
        CheckConstraint("revision > 0", name="ck_dashboards_revision_positive"),
        CheckConstraint(
            "refresh_cadence IN ('manual', 'one-minute', 'five-minutes')",
            name="ck_dashboards_refresh_cadence",
        ),
        CheckConstraint("position >= 0", name="ck_dashboards_position_nonnegative"),
        Index("ix_dashboards_department_position", "department_id", "position"),
    )

    department_id: Mapped[UUID] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=False
    )
    position: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    refresh_cadence: Mapped[str] = mapped_column(
        String(20), default="manual", server_default=text("'manual'"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
    widgets: Mapped[list[DashboardWidget]] = relationship(
        back_populates="dashboard",
        cascade="save-update, merge",
        order_by=lambda: (DashboardWidget.position, DashboardWidget.id),
    )


class DashboardWidget(BaseModel):
    """An audited chart configuration at one active Dashboard position."""

    __tablename__ = "dashboard_widgets"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"config"})
    __table_args__ = (
        CheckConstraint(
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_dashboard_widgets_type",
        ),
        CheckConstraint(
            "position >= 0 AND position < 12", name="ck_dashboard_widgets_position"
        ),
        CheckConstraint("size IN ('S', 'M', 'L')", name="ck_dashboard_widgets_size"),
        CheckConstraint(
            "(config IS NOT NULL) <> (chart_id IS NOT NULL)",
            name="ck_dashboard_widgets_query_source",
        ),
        Index("ix_dashboard_widgets_dashboard_id", "dashboard_id"),
        Index("ix_dashboard_widgets_chart_id", "chart_id"),
        Index(
            "uq_dashboard_widgets_active_position",
            "dashboard_id",
            "position",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    dashboard_id: Mapped[UUID] = mapped_column(
        ForeignKey("dashboards.id", ondelete="RESTRICT"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    widget_type: Mapped[str] = mapped_column(
        String(20), default="chart", server_default=text("'chart'"), nullable=False
    )
    size: Mapped[str] = mapped_column(
        String(1), default="M", server_default=text("'M'"), nullable=False
    )
    chart_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("charts.id", ondelete="RESTRICT"), nullable=True
    )
    config: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    dashboard: Mapped[Dashboard] = relationship(back_populates="widgets")
