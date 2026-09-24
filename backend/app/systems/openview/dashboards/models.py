"""Audited persistence for owner-private Dashboards, defaults, and widgets."""

from __future__ import annotations

from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
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
    """A revisioned Dashboard owned privately by one user."""

    __tablename__ = "dashboards"
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_dashboards_name_nonempty"),
        CheckConstraint("revision > 0", name="ck_dashboards_revision_positive"),
        UniqueConstraint("id", "owner_id", name="uq_dashboards_id_owner"),
        Index("ix_dashboards_owner_id", "owner_id"),
    )

    owner_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
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
        CheckConstraint("widget_type = 'chart'", name="ck_dashboard_widgets_type"),
        CheckConstraint(
            "position >= 0 AND position < 12", name="ck_dashboard_widgets_position"
        ),
        Index("ix_dashboard_widgets_dashboard_id", "dashboard_id"),
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
    config: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    dashboard: Mapped[Dashboard] = relationship(back_populates="widgets")


class DashboardDefault(BaseModel):
    """One user's default Dashboard, constrained to a Dashboard they own."""

    __tablename__ = "dashboard_defaults"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_dashboard_defaults_user_id"),
        ForeignKeyConstraint(
            ["dashboard_id", "user_id"],
            ["dashboards.id", "dashboards.owner_id"],
            ondelete="CASCADE",
            name="fk_dashboard_defaults_dashboard_owner",
        ),
        Index("ix_dashboard_defaults_dashboard_id", "dashboard_id"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    dashboard_id: Mapped[UUID] = mapped_column(nullable=False)
