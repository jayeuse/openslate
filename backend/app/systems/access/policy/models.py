"""Persistence models for Access policy configuration."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
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


class AccessGroup(BaseModel):
    __tablename__ = "access_groups"
    __table_args__ = (
        CheckConstraint("btrim(name) <> ''", name="ck_access_groups_name_not_blank"),
        CheckConstraint("revision > 0", name="ck_access_groups_revision_positive"),
        Index(
            "uq_access_groups_name_active_ci",
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


class AccessGroupMember(BaseModel):
    __tablename__ = "access_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id", name="uq_access_group_members_group_user"),
    )

    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("access_groups.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )


class AccessPolicyDefaults(BaseModel):
    __tablename__ = "access_policy_defaults"
    __table_args__ = (
        CheckConstraint("singleton_key = 'workspace'", name="ck_access_policy_defaults_workspace"),
        CheckConstraint(
            "invitation_expiry_days BETWEEN 1 AND 365",
            name="ck_access_policy_defaults_invitation_expiry_days_range",
        ),
        CheckConstraint(
            "guest_duration_days BETWEEN 1 AND 365",
            name="ck_access_policy_defaults_guest_duration_days_range",
        ),
        CheckConstraint(
            "service_duration_days BETWEEN 1 AND 365",
            name="ck_access_policy_defaults_service_duration_days_range",
        ),
        CheckConstraint(
            "default_deny = true AND require_guest_sponsor = true AND require_service_owner = true",
            name="ck_access_policy_defaults_protected_flags",
        ),
        CheckConstraint("revision > 0", name="ck_access_policy_defaults_revision_positive"),
        UniqueConstraint("singleton_key", name="uq_access_policy_defaults_singleton_key"),
    )

    singleton_key: Mapped[str] = mapped_column(
        String(20), default="workspace", server_default=text("'workspace'"), nullable=False
    )
    default_role_id: Mapped[UUID] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    invitation_expiry_days: Mapped[int] = mapped_column(
        Integer, default=7, server_default=text("7"), nullable=False
    )
    guest_duration_days: Mapped[int] = mapped_column(
        Integer, default=30, server_default=text("30"), nullable=False
    )
    service_duration_days: Mapped[int] = mapped_column(
        Integer, default=90, server_default=text("90"), nullable=False
    )
    default_deny: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
    )
    require_guest_sponsor: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
    )
    require_service_owner: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )


class AccessDefaultGroup(BaseModel):
    __tablename__ = "access_default_groups"
    __table_args__ = (
        UniqueConstraint(
            "policy_defaults_id",
            "group_id",
            name="uq_access_default_groups_defaults_group",
        ),
    )

    policy_defaults_id: Mapped[UUID] = mapped_column(
        ForeignKey("access_policy_defaults.id", ondelete="RESTRICT"), nullable=False
    )
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("access_groups.id", ondelete="RESTRICT"), nullable=False, index=True
    )


class AccessDefaultDepartment(BaseModel):
    __tablename__ = "access_default_departments"
    __table_args__ = (
        UniqueConstraint(
            "policy_defaults_id",
            "department_id",
            name="uq_access_default_departments_defaults_department",
        ),
    )

    policy_defaults_id: Mapped[UUID] = mapped_column(
        ForeignKey("access_policy_defaults.id", ondelete="RESTRICT"), nullable=False
    )
    department_id: Mapped[UUID] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=False, index=True
    )


class AccessRule(BaseModel):
    __tablename__ = "access_rules"
    __table_args__ = (
        CheckConstraint(
            "subject_kind IN ('everyone','role','group','user','service')",
            name="ck_access_rules_subject_kind",
        ),
        CheckConstraint(
            "(subject_kind = 'everyone' AND subject_id IS NULL) OR "
            "(subject_kind <> 'everyone' AND subject_id IS NOT NULL)",
            name="ck_access_rules_subject_shape",
        ),
        CheckConstraint(
            "scope_kind IN ('workspace','department','module','field')",
            name="ck_access_rules_scope_kind",
        ),
        CheckConstraint(
            "(scope_kind = 'workspace' AND scope_id IS NULL) OR "
            "(scope_kind <> 'workspace' AND scope_id IS NOT NULL)",
            name="ck_access_rules_scope_shape",
        ),
        CheckConstraint(
            "permission_id IN ('departments.read','departments.write','modules.read',"
            "'modules.write','fields.read','fields.write','records.read','records.write',"
            "'relationships.read','relationships.write')",
            name="ck_access_rules_permission_id",
        ),
        CheckConstraint("decision IN ('inherit','allow','deny')", name="ck_access_rules_decision"),
        CheckConstraint(
            "starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at",
            name="ck_access_rules_window",
        ),
        CheckConstraint("policy_version > 0", name="ck_access_rules_policy_version_positive"),
        Index(
            "ix_access_rules_permission_scope_active",
            "permission_id",
            "scope_kind",
            "scope_id",
            postgresql_where=text("is_deleted = false"),
        ),
        Index(
            "ix_access_rules_subject_active",
            "subject_kind",
            "subject_id",
            postgresql_where=text("is_deleted = false"),
        ),
        Index(
            "ix_access_rules_scope_active",
            "scope_kind",
            "scope_id",
            postgresql_where=text("is_deleted = false"),
        ),
        Index(
            "uq_access_rules_subject_active",
            "subject_kind",
            "subject_id",
            "scope_kind",
            "scope_id",
            "permission_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
            postgresql_where=text("is_deleted = false AND subject_kind <> 'everyone'"),
        ),
        Index(
            "uq_access_rules_everyone_active",
            "scope_kind",
            "scope_id",
            "permission_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
            postgresql_where=text("is_deleted = false AND subject_kind = 'everyone'"),
        ),
    )
    subject_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    subject_id: Mapped[UUID | None] = mapped_column(nullable=True)
    scope_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    scope_id: Mapped[UUID | None] = mapped_column(nullable=True)
    permission_id: Mapped[str] = mapped_column(String(40), nullable=False)
    decision: Mapped[str] = mapped_column(String(10), nullable=False)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    locked: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    policy_version: Mapped[int] = mapped_column(Integer, nullable=False)


class AccessPolicyVersion(BaseModel):
    __tablename__ = "access_policy_versions"
    __table_args__ = (
        CheckConstraint("singleton_key = 'workspace'", name="ck_access_policy_versions_workspace"),
        CheckConstraint("revision > 0", name="ck_access_policy_versions_revision_positive"),
        UniqueConstraint("singleton_key", name="uq_access_policy_versions_singleton_key"),
    )
    singleton_key: Mapped[str] = mapped_column(
        String(20), default="workspace", server_default=text("'workspace'"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
