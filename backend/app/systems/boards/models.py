"""Scoped Boards, the groups of project Boards, and Board widgets."""

from enum import StrEnum
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
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardScope(StrEnum):
    """Who a Board is for: everyone, one department, or the groups of a project."""

    COMPANY = "company"
    DEPARTMENT = "department"
    PROJECT = "project"


class BoardStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class Board(BaseModel):
    """One company Board, one Board for each department, and project Boards."""

    __tablename__ = "boards"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"description"})
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_boards_name_nonempty"),
        CheckConstraint("revision > 0", name="ck_boards_revision_positive"),
        CheckConstraint(
            "status IN ('active', 'archived')",
            name="ck_boards_status",
        ),
        CheckConstraint(
            "scope IN ('company', 'department', 'project')",
            name="ck_boards_scope",
        ),
        CheckConstraint(
            "(scope = 'department') = (department_id IS NOT NULL)",
            name="ck_boards_department_scope",
        ),
        Index(
            "uq_boards_company",
            "scope",
            unique=True,
            postgresql_where=text("scope = 'company' AND NOT is_deleted"),
        ),
        Index(
            "uq_boards_department",
            "department_id",
            unique=True,
            postgresql_where=text("scope = 'department' AND NOT is_deleted"),
        ),
    )

    scope: Mapped[BoardScope] = mapped_column(String(20), nullable=False)
    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[BoardStatus] = mapped_column(
        String(20),
        default=BoardStatus.ACTIVE,
        server_default=text("'active'"),
        nullable=False,
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )


class BoardGroup(BaseModel):
    """One group's level on a project Board. Only project Boards have rows."""

    __tablename__ = "board_groups"
    __table_args__ = (
        CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_board_groups_level"),
        Index(
            "uq_board_groups_board_group_active",
            "board_id",
            "group_id",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
        Index("ix_board_groups_group_id", "group_id"),
    )

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="RESTRICT"), nullable=False
    )
    level: Mapped[str] = mapped_column(String(10), nullable=False)


class BoardWidget(BaseModel):
    """One ordered Board tile; every reader of the Board sees it."""

    __tablename__ = "board_widgets"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"config"})
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_board_widgets_name_nonempty"),
        CheckConstraint(
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_board_widgets_type",
        ),
        CheckConstraint("position >= 0 AND position < 12", name="ck_board_widgets_position"),
        CheckConstraint("size IN ('S', 'M', 'L')", name="ck_board_widgets_size"),
        CheckConstraint(
            "(config IS NOT NULL) <> (chart_id IS NOT NULL)",
            name="ck_board_widgets_query_source",
        ),
        UniqueConstraint(
            "board_id", "position", name="uq_board_widgets_board_position",
            deferrable=True, initially="DEFERRED",
        ),
        Index("ix_board_widgets_module_id", "module_id"),
        Index("ix_board_widgets_chart_id", "chart_id"),
    )

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    widget_type: Mapped[str] = mapped_column(String(20), nullable=False)
    size: Mapped[str] = mapped_column(
        String(1), default="M", server_default=text("'M'"), nullable=False
    )
    pinned: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    chart_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("charts.id", ondelete="RESTRICT"), nullable=True
    )
    config: Mapped[dict[str, object] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
