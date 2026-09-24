from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
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


class Role(BaseModel):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("role", name="uq_roles_role"),)

    role: Mapped[str] = mapped_column(String(100), nullable=False)
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
    )

    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)

    username: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
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

    @validates("email", "username")
    def normalize_profile_field(self, key: str, value: Any) -> Any:
        if key == "email":
            return normalize_email(value)
        return normalize_username(value)


class UserDepartmentMembership(BaseModel):
    """One auditable association between a User and a Department."""

    __tablename__ = "user_department_memberships"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "department_id",
            name="uq_user_department_memberships_user_department",
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    department_id: Mapped[UUID] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=False, index=True
    )
