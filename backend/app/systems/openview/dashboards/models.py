"""Audited persistence for department Dashboards and their widgets."""

from __future__ import annotations

from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel


class Dashboard(BaseModel):
    """A revisioned Dashboard that belongs to one department; one active one is its home."""

    __tablename__ = "dashboards"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_dashboards_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "department_id"], ["departments.org_id", "departments.id"],
            name="fk_dashboards_department_id_departments", ondelete="RESTRICT",
        ),
        CheckConstraint("length(btrim(name)) > 0", name="ck_dashboards_name_nonempty"),
        CheckConstraint("revision > 0", name="ck_dashboards_revision_positive"),
        CheckConstraint(
            "refresh_cadence IN ('manual', 'one-minute', 'five-minutes')",
            name="ck_dashboards_refresh_cadence",
        ),
        CheckConstraint("position >= 0", name="ck_dashboards_position_nonnegative"),
        Index("ix_dashboards_department_position", "department_id", "position"),
        Index(
            "uq_dashboards_department_home",
            "org_id",
            "department_id",
            unique=True,
            postgresql_where=text("is_home AND NOT is_deleted"),
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    department_id: Mapped[UUID] = mapped_column(nullable=False)
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
    is_home: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    widgets: Mapped[list[DashboardWidget]] = relationship(
        back_populates="dashboard",
        cascade="save-update, merge",
        order_by=lambda: (DashboardWidget.position, DashboardWidget.id),
    )


class DashboardWidget(BaseModel):
    """An audited chart configuration covering whole cells of the 4 x 5 Dashboard grid.

    Placement is null only for a widget the grid migration could not place. Overlap and
    each widget kind's size range are checked on save (``placement.py``).
    """

    __tablename__ = "dashboard_widgets"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"config"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_dashboard_widgets_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "dashboard_id"], ["dashboards.org_id", "dashboards.id"],
            name="fk_dashboard_widgets_dashboard_id_dashboards", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "chart_id"], ["charts.org_id", "charts.id"],
            name="fk_dashboard_widgets_chart_id_charts", ondelete="RESTRICT",
        ),
        CheckConstraint(
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_dashboard_widgets_type",
        ),
        CheckConstraint(
            "position >= 0 AND position < 20", name="ck_dashboard_widgets_position"
        ),
        CheckConstraint(
            "(grid_column IS NULL AND grid_row IS NULL AND column_span IS NULL "
            "AND row_span IS NULL) OR (grid_column IS NOT NULL AND grid_row IS NOT NULL "
            "AND column_span IS NOT NULL AND row_span IS NOT NULL "
            "AND grid_column >= 0 AND grid_row >= 0 AND column_span >= 1 AND row_span >= 1 "
            "AND grid_column + column_span <= 4 AND grid_row + row_span <= 5)",
            name="ck_dashboard_widgets_placement",
        ),
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

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    dashboard_id: Mapped[UUID] = mapped_column(nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    widget_type: Mapped[str] = mapped_column(
        String(20), default="chart", server_default=text("'chart'"), nullable=False
    )
    grid_column: Mapped[int | None] = mapped_column(Integer, nullable=True)
    grid_row: Mapped[int | None] = mapped_column(Integer, nullable=True)
    column_span: Mapped[int | None] = mapped_column(Integer, nullable=True)
    row_span: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chart_id: Mapped[UUID | None] = mapped_column(nullable=True)
    config: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    dashboard: Mapped[Dashboard] = relationship(back_populates="widgets")
