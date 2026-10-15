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
        CheckConstraint(
            "theme_preference IN ('light', 'dark', 'system')", name="ck_users_theme_preference"
        ),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(appearance) = 'object' THEN "
            "(appearance ?& ARRAY['motion','keyboard_shortcuts'] AND "
            "appearance - ARRAY['motion','keyboard_shortcuts','timezone','date_format',"
            "'time_format','week_start','start_page'] = '{}'::jsonb AND "
            "appearance ->> 'motion' IN ('system','reduce') AND "
            "jsonb_typeof(appearance -> 'keyboard_shortcuts') = 'boolean' AND "
            "(NOT (appearance ? 'timezone') OR jsonb_typeof(appearance -> 'timezone') "
            "IN ('string','null')) AND "
            "(NOT (appearance ? 'date_format') OR appearance ->> 'date_format' "
            "IN ('organization','dmy','mdy','ymd')) AND "
            "(NOT (appearance ? 'time_format') OR appearance ->> 'time_format' "
            "IN ('organization','12h','24h')) AND "
            "(NOT (appearance ? 'week_start') OR appearance ->> 'week_start' "
            "IN ('organization','monday','sunday')) AND "
            "(NOT (appearance ? 'start_page') OR appearance ->> 'start_page' "
            "IN ('automatic','sandbox','boards','comms','access','openview','manage','platform'))) "
            "IS TRUE "
            "ELSE false END",
            name="ck_users_appearance",
        ),
    )

    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    supabase_user_id: Mapped[UUID | None] = mapped_column(nullable=True, unique=True, index=True)

    username: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
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
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    bio: Mapped[str | None] = mapped_column(String(280), nullable=True)
    avatar_file_id: Mapped[UUID | None] = mapped_column(
        ForeignKey(
            "files.id", name="fk_users_avatar_file_id_files", ondelete="SET NULL", use_alter=True
        ),
        nullable=True,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=UserStatus.PENDING.value,
        server_default=text("'pending'"),
    )
    tokens_valid_after: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    @validates("email", "username")
    def normalize_profile_field(self, key: str, value: Any) -> Any:
        if key == "email":
            return normalize_email(value)
        return normalize_username(value)


class Membership(BaseModel):
    """One account's organization-local role and invitation lifecycle."""

    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_memberships_org_id_id"),
        UniqueConstraint("org_id", "user_id", name="uq_memberships_org_user"),
        CheckConstraint("role IN ('admin', 'member', 'guest')", name="ck_memberships_role"),
        CheckConstraint(
            "status IN ('pending', 'active', 'disabled')", name="ck_memberships_status"
        ),
        CheckConstraint(
            "(role = 'guest') = (sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL)",
            name="ck_memberships_guest",
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), default=UserStatus.PENDING.value, server_default=text("'pending'"),
        nullable=False,
    )
    sponsor_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invitation_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invitation_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_invitation_operation_id: Mapped[UUID | None] = mapped_column(nullable=True)
    mfa_required_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlatformOperator(BaseModel):
    """Installation administration identity, not an organization access grant."""

    __tablename__ = "platform_operators"
    __table_args__ = (UniqueConstraint("user_id", name="uq_platform_operators_user_id"),)

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
