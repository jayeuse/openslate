from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.common.normalization import normalize_email, normalize_username
from app.core.base_model import BaseModel


class UserRole(StrEnum):
    ADMIN = "admin"
    MEMBER = "member"


class UserStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    DISABLED = "disabled"


class IdentityKind(StrEnum):
    INTERNAL = "internal"
    GUEST = "guest"


class Role(BaseModel):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("role", name="uq_roles_role"),)

    role: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    permissions: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB),
        default=dict,
        server_default=text("'{}'::jsonb"),
        nullable=False,
    )
    users: Mapped[list["User"]] = relationship(
        back_populates="role",
        foreign_keys=lambda: [User.role_id],
    )


class User(BaseModel):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("email", name="uq_users_email"),
        UniqueConstraint("username", name="uq_users_username"),
        CheckConstraint(
            "email = lower(btrim(email)) AND length(email) > 0",
            name="ck_users_email_normalized",
        ),
        CheckConstraint(
            "status IN ('pending', 'active', 'disabled')",
            name="ck_users_status",
        ),
        CheckConstraint(
            "identity_kind IN ('internal', 'guest')",
            name="ck_users_identity_kind",
        ),
        CheckConstraint(
            "(identity_kind = 'guest' AND sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL) "
            "OR (identity_kind = 'internal' AND sponsor_user_id IS NULL)",
            name="ck_users_identity_kind_subject",
        ),
    )

    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    supabase_user_id: Mapped[UUID | None] = mapped_column(nullable=True, unique=True, index=True)
    provider_invitation_operation_id: Mapped[UUID | None] = mapped_column(nullable=True)

    username: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    identity_kind: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=IdentityKind.INTERNAL.value,
        server_default=text("'internal'"),
    )
    job_title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    sponsor_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT", use_alter=True),
        nullable=True,
        index=True,
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=UserStatus.PENDING.value,
        server_default=text("'pending'"),
    )
    invitation_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    invitation_accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    tokens_valid_after: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    role_id: Mapped[UUID] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT", use_alter=True),
        nullable=False,
        index=True,
    )
    role: Mapped[Role] = relationship(back_populates="users", foreign_keys=[role_id])
    department_memberships: Mapped[list["UserDepartment"]] = relationship(
        back_populates="user",
        foreign_keys=lambda: [UserDepartment.user_id],
        lazy="raise",
    )

    @validates("email", "username")
    def normalize_profile_field(self, key: str, value: Any) -> Any:
        if key == "email":
            return normalize_email(value)
        return normalize_username(value)


class UserDepartment(BaseModel):
    """An audited membership link removed physically by its future application service.

    User and Department soft-deletion is application-owned and never cascades through
    this table. Their physical purge is restricted until memberships are removed.
    """

    __tablename__ = "user_departments"
    __table_args__ = (
        UniqueConstraint("user_id", "department_id", name="uq_user_departments_user_department"),
        Index(
            "uq_user_departments_primary_user",
            "user_id",
            unique=True,
            postgresql_where=text("is_primary = true"),
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    department_id: Mapped[UUID] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    is_primary: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default=text("false"),
        nullable=False,
    )

    user: Mapped[User] = relationship(
        back_populates="department_memberships",
        foreign_keys=[user_id],
    )
