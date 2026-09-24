"""Durable Board metadata and per-Board access grants."""

from enum import StrEnum
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
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


class BoardPrincipalType(StrEnum):
    USER = "user"
    ROLE = "role"
    EVERYONE = "everyone"


class BoardPermission(StrEnum):
    VIEW = "view"
    EDIT = "edit"
    MANAGE = "manage"


class BoardGrantEffect(StrEnum):
    ALLOW = "allow"
    DENY = "deny"


class BoardStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"


class BoardSection(StrEnum):
    OVERVIEW = "overview"
    CALENDAR = "calendar"
    ANNOUNCEMENTS = "announcements"


class Board(BaseModel):
    """A private-by-default workspace board."""

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
            "default_section IN ('overview', 'calendar', 'announcements')",
            name="ck_boards_default_section",
        ),
        Index("ix_boards_owner_id", "owner_id"),
    )

    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    owner_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[BoardStatus] = mapped_column(
        String(20),
        default=BoardStatus.ACTIVE,
        server_default=text("'active'"),
        nullable=False,
    )
    default_section: Mapped[BoardSection] = mapped_column(
        String(30),
        default=BoardSection.OVERVIEW,
        server_default=text("'overview'"),
        nullable=False,
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )


class BoardGrant(BaseModel):
    """One explicit allow or deny for a Board principal and access level."""

    __tablename__ = "board_grants"
    __table_args__ = (
        CheckConstraint(
            "principal_type IN ('user', 'role', 'everyone')",
            name="ck_board_grants_principal_type",
        ),
        CheckConstraint(
            "(principal_type = 'user' AND principal_user_id IS NOT NULL "
            "AND principal_role_id IS NULL) OR "
            "(principal_type = 'role' AND principal_user_id IS NULL "
            "AND principal_role_id IS NOT NULL) OR "
            "(principal_type = 'everyone' AND principal_user_id IS NULL "
            "AND principal_role_id IS NULL)",
            name="ck_board_grants_principal_reference",
        ),
        CheckConstraint(
            "permission IN ('view', 'edit', 'manage')",
            name="ck_board_grants_permission",
        ),
        CheckConstraint("effect IN ('allow', 'deny')", name="ck_board_grants_effect"),
        Index("ix_board_grants_board_id", "board_id"),
        Index("ix_board_grants_principal_user_id", "principal_user_id"),
        Index("ix_board_grants_principal_role_id", "principal_role_id"),
        Index(
            "uq_board_grants_active_user_decision",
            "board_id",
            "principal_user_id",
            "permission",
            "effect",
            unique=True,
            postgresql_where=text("principal_type = 'user' AND is_deleted = false"),
        ),
        Index(
            "uq_board_grants_active_role_decision",
            "board_id",
            "principal_role_id",
            "permission",
            "effect",
            unique=True,
            postgresql_where=text("principal_type = 'role' AND is_deleted = false"),
        ),
        Index(
            "uq_board_grants_active_everyone_decision",
            "board_id",
            "permission",
            "effect",
            unique=True,
            postgresql_where=text("principal_type = 'everyone' AND is_deleted = false"),
        ),
    )

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    principal_type: Mapped[str] = mapped_column(String(20), nullable=False)
    principal_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    principal_role_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=True
    )
    permission: Mapped[str] = mapped_column(String(20), nullable=False)
    effect: Mapped[str] = mapped_column(String(10), nullable=False)


class BoardRecordPlacement(BaseModel):
    """A unique Board shortcut to a source record, independent of Board status."""

    __tablename__ = "board_record_placements"
    __table_args__ = (
        UniqueConstraint(
            "board_id", "record_id", name="uq_board_record_placements_board_record"
        ),
        Index("ix_board_record_placements_record_id", "record_id"),
    )

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    record_id: Mapped[UUID] = mapped_column(
        ForeignKey("records.id", ondelete="RESTRICT"), nullable=False
    )


class BoardWidget(BaseModel):
    """One ordered Board widget; source references remain retained until deletion."""

    __tablename__ = "board_widgets"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"config"})
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_board_widgets_name_nonempty"),
        CheckConstraint(
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_board_widgets_type",
        ),
        CheckConstraint("position >= 0 AND position < 12", name="ck_board_widgets_position"),
        CheckConstraint(
            "(audience_kind IN ('private', 'everyone') AND audience_role_id IS NULL "
            "AND audience_user_id IS NULL) OR "
            "(audience_kind = 'role' AND audience_role_id IS NOT NULL "
            "AND audience_user_id IS NULL) OR "
            "(audience_kind = 'user' AND audience_role_id IS NULL "
            "AND audience_user_id IS NOT NULL)",
            name="ck_board_widgets_audience",
        ),
        UniqueConstraint(
            "board_id", "position", name="uq_board_widgets_board_position",
            deferrable=True, initially="DEFERRED",
        ),
        Index("ix_board_widgets_module_id", "module_id"),
        Index("ix_board_widgets_creator_id", "creator_id"),
    )

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False
    )
    creator_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    widget_type: Mapped[str] = mapped_column(String(20), nullable=False)
    config: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    audience_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    audience_role_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=True
    )
    audience_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
