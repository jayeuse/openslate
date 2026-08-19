from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel


class UserRole(StrEnum):
    ADMIN = "admin"
    MEMBER = "member"


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
    __audit_redacted_fields__ = frozenset({"password_hash"})
    __table_args__ = (UniqueConstraint("username", name="uq_users_username"),)

    username: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role_id: Mapped[UUID] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT", use_alter=True),
        nullable=False,
        index=True,
    )
    role: Mapped[Role] = relationship(back_populates="users", foreign_keys=[role_id])
