"""Persistence models for Access groups and their department and module access."""

from enum import StrEnum
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
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
        UniqueConstraint("org_id", "id", name="uq_groups_org_id_id"),
        CheckConstraint("btrim(name) <> ''", name="ck_groups_name_not_blank"),
        CheckConstraint("revision > 0", name="ck_groups_revision_positive"),
        Index(
            "uq_groups_name_active_ci",
            "org_id",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
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
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_group_members_org_id_id"),
        UniqueConstraint("group_id", "user_id", name="uq_group_members_group_user"),
        ForeignKeyConstraint(
            ["org_id", "group_id"], ["groups.org_id", "groups.id"],
            name="fk_group_members_group_id_groups", ondelete="RESTRICT",
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    group_id: Mapped[UUID] = mapped_column(nullable=False)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )


class GroupAccess(BaseModel):
    """One group's level on a whole department (module NULL) or on one of its modules."""

    __tablename__ = "group_access"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_group_access_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "group_id"], ["groups.org_id", "groups.id"],
            name="fk_group_access_group_id_groups", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "department_id"], ["departments.org_id", "departments.id"],
            name="fk_group_access_department_id_departments", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_group_access_module_id_modules", ondelete="RESTRICT",
        ),
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

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    group_id: Mapped[UUID] = mapped_column(nullable=False)
    department_id: Mapped[UUID] = mapped_column(nullable=False)
    module_id: Mapped[UUID | None] = mapped_column(nullable=True)
    level: Mapped[str] = mapped_column(Text, nullable=False)
