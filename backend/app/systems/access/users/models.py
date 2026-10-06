from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.common.normalization import normalize_email, normalize_username
from app.core.base_model import BaseModel


class UserRole(StrEnum):
    ADMIN = "admin"
    MEMBER = "member"
    GUEST = "guest"


class UserStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    DISABLED = "disabled"


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
        CheckConstraint("role IN ('admin', 'member', 'guest')", name="ck_users_role"),
        CheckConstraint(
            "theme_preference IN ('light', 'dark', 'system')", name="ck_users_theme_preference"
        ),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(appearance) = 'object' THEN "
            "(appearance ?& ARRAY['motion','keyboard_shortcuts'] AND "
            "appearance - ARRAY['motion','keyboard_shortcuts'] = '{}'::jsonb AND "
            "appearance ->> 'motion' IN ('system','reduce') AND "
            "jsonb_typeof(appearance -> 'keyboard_shortcuts') = 'boolean') IS TRUE "
            "ELSE false END",
            name="ck_users_appearance",
        ),
        CheckConstraint(
            "(role = 'guest') = (sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL)",
            name="ck_users_guest",
        ),
    )

    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    supabase_user_id: Mapped[UUID | None] = mapped_column(nullable=True, unique=True, index=True)
    provider_invitation_operation_id: Mapped[UUID | None] = mapped_column(nullable=True)

    username: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    theme_preference: Mapped[str] = mapped_column(
        Text, nullable=False, default="system", server_default=text("'system'")
    )
    appearance: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=lambda: {"motion": "system", "keyboard_shortcuts": True},
        server_default=text('\'{"motion": "system", "keyboard_shortcuts": true}\'::jsonb'),
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

    @validates("email", "username")
    def normalize_profile_field(self, key: str, value: Any) -> Any:
        if key == "email":
            return normalize_email(value)
        return normalize_username(value)
