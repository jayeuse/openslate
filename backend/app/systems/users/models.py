from enum import StrEnum

from sqlalchemy import Boolean, Index, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class UserRole(StrEnum):
    ADMIN = "admin"
    MEMBER = "member"


class User(BaseModel):
    __tablename__ = "users"
    __audit_redacted_fields__ = frozenset({"password_hash"})
    __table_args__ = (
        UniqueConstraint("username"),
        Index("ix_users_preferences_gin", "preferences", postgresql_using="gin"),
    )

    username: Mapped[str] = mapped_column(String(50), index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(
        String(32),
        default=UserRole.MEMBER,
        server_default="member",
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    preferences: Mapped[dict[str, object]] = mapped_column(
        MutableDict.as_mutable(JSONB),
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
