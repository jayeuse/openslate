"""Persistence models for Access groups and their department and module access."""

from enum import StrEnum
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
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class AccessLevel(StrEnum):
    READ = "read"
    WRITE = "write"
    MANAGE = "manage"


class Group(BaseModel):
    __tablename__ = "groups"
    __table_args__ = (
        CheckConstraint("btrim(name) <> ''", name="ck_groups_name_not_blank"),
        CheckConstraint("revision > 0", name="ck_groups_revision_positive"),
        Index(
            "uq_groups_name_active_ci",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(
        Text, default="", server_default=text("''"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )


class GroupMember(BaseModel):
    __tablename__ = "group_members"
    __table_args__ = (UniqueConstraint("group_id", "user_id", name="uq_group_members_group_user"),)

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )


class GroupAccess(BaseModel):
    """One group's level on a whole department (module NULL) or on one of its modules."""

    __tablename__ = "group_access"
    __table_args__ = (
        CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_group_access_level"),
        Index(
            "uq_group_access_target_active",
            "group_id",
            "department_id",
            "module_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
            postgresql_where=text("is_deleted = false"),
        ),
        Index(
            "ix_group_access_department_module_active",
            "department_id",
            "module_id",
            postgresql_where=text("is_deleted = false"),
        ),
        Index("ix_group_access_module_id", "module_id"),
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="RESTRICT"), nullable=False
    )
    department_id: Mapped[UUID] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=False
    )
    module_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=True
    )
    level: Mapped[str] = mapped_column(Text, nullable=False)
