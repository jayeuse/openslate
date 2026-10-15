from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class WorkspaceProfile(BaseModel):
    """An organization's identity, appearance and membership policy."""

    __tablename__ = "organizations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["id", "logo_file_id"], ["files.org_id", "files.id"],
            name="fk_organizations_logo_file_id_files", ondelete="RESTRICT", use_alter=True,
        ),
        UniqueConstraint("slug", name="uq_organizations_slug"),
        CheckConstraint(
            "slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'", name="ck_organizations_slug"
        ),
        CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL",
            name="ck_workspace_profiles_not_deleted",
        ),
        CheckConstraint(
            "invitation_expiry_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_invitation_expiry_days_range",
        ),
        CheckConstraint(
            "guest_duration_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_guest_duration_days_range",
        ),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_workspace_profiles_currency"),
        CheckConstraint(
            "week_start IN ('monday', 'sunday')", name="ck_workspace_profiles_week_start"
        ),
        CheckConstraint(
            "business_hours = btrim(business_hours)",
            name="ck_workspace_profiles_business_hours_trimmed",
        ),
        CheckConstraint("mark = btrim(mark)", name="ck_workspace_profiles_mark_trimmed"),
        CheckConstraint(
            "theme IN ('slate', 'whiteboard', 'triplicate', 'stockroom')",
            name="ck_workspace_profiles_theme",
        ),
        CheckConstraint(
            "security_event_retention_days BETWEEN 1 AND 3650",
            name="ck_workspace_profiles_security_event_retention_days_range",
        ),
        CheckConstraint(
            "mfa_grace_days BETWEEN 0 AND 30",
            name="ck_workspace_profiles_mfa_grace_days_range",
        ),
        CheckConstraint(
            "jsonb_typeof(ip_allow_list) = 'array'", name="ck_workspace_profiles_ip_allow_list"
        ),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"contact_email", "contact_phone", "postal_address", "ip_allow_list"}
    )

    slug: Mapped[str] = mapped_column(String(200), nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    legal_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    contact_email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    postal_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    logo_file_id: Mapped[UUID | None] = mapped_column(nullable=True)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    locale: Mapped[str] = mapped_column(String(35), nullable=False)
    currency: Mapped[str] = mapped_column(
        String(3), default="PHP", server_default=text("'PHP'"), nullable=False
    )
    week_start: Mapped[str] = mapped_column(
        String(6), default="monday", server_default=text("'monday'"), nullable=False
    )
    business_hours: Mapped[str] = mapped_column(
        String(200), default="09:00–18:00", server_default=text("'09:00–18:00'"), nullable=False
    )
    mark: Mapped[str] = mapped_column(
        String(32), default="RS", server_default=text("'RS'"), nullable=False
    )
    theme: Mapped[str] = mapped_column(
        String(16), default="slate", server_default=text("'slate'"), nullable=False
    )
    security_event_retention_days: Mapped[int] = mapped_column(
        Integer, default=365, server_default=text("365"), nullable=False
    )
    mfa_require_admin: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    mfa_require_member: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    mfa_require_guest: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    mfa_grace_days: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )
    ip_allow_list: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb"), nullable=False
    )
    invitation_expiry_days: Mapped[int] = mapped_column(
        Integer, default=7, server_default=text("7"), nullable=False
    )
    guest_duration_days: Mapped[int] = mapped_column(
        Integer, default=30, server_default=text("30"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer,
        default=1,
        server_default=text("1"),
        nullable=False,
    )


class PlatformSettings(BaseModel):
    """The installation's pre-organization identity and session policy."""

    __tablename__ = "platform_settings"
    __table_args__ = (
        UniqueConstraint("singleton_key", name="uq_platform_settings_singleton_key"),
        CheckConstraint("singleton_key = true", name="ck_platform_settings_singleton_key"),
        CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_platform_settings_not_deleted"
        ),
        CheckConstraint(
            "session_timeout_minutes IN (15, 30, 60, 480)",
            name="ck_platform_settings_session_timeout_minutes",
        ),
        CheckConstraint(
            "session_retention_days BETWEEN 1 AND 3650",
            name="ck_platform_settings_session_retention_days_range",
        ),
        CheckConstraint(
            "security_event_retention_days BETWEEN 1 AND 3650",
            name="ck_platform_settings_security_event_retention_days_range",
        ),
        CheckConstraint(
            "password_min_length BETWEEN 12 AND 128",
            name="ck_platform_settings_password_min_length",
        ),
        CheckConstraint(
            "session_absolute_lifetime_minutes IS NULL OR "
            "session_absolute_lifetime_minutes BETWEEN 1 AND 43200",
            name="ck_platform_settings_session_absolute_lifetime_minutes_range",
        ),
        CheckConstraint(
            "session_concurrent_limit IS NULL OR session_concurrent_limit BETWEEN 1 AND 100",
            name="ck_platform_settings_session_concurrent_limit_range",
        ),
        CheckConstraint(
            "login_failed_attempt_threshold BETWEEN 1 AND 100",
            name="ck_platform_settings_login_failed_attempt_threshold_range",
        ),
        CheckConstraint(
            "login_window_minutes BETWEEN 1 AND 1440",
            name="ck_platform_settings_login_window_minutes_range",
        ),
        CheckConstraint(
            "login_cooldown_minutes BETWEEN 1 AND 1440",
            name="ck_platform_settings_login_cooldown_minutes_range",
        ),
    )

    singleton_key: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
    )
    session_timeout_minutes: Mapped[int] = mapped_column(
        Integer, default=60, server_default=text("60"), nullable=False
    )
    session_retention_days: Mapped[int] = mapped_column(
        Integer, default=365, server_default=text("365"), nullable=False
    )
    security_event_retention_days: Mapped[int] = mapped_column(
        Integer, default=365, server_default=text("365"), nullable=False
    )
    password_min_length: Mapped[int] = mapped_column(
        Integer, default=12, server_default=text("12"), nullable=False
    )
    password_require_mixed_case: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
    )
    password_require_number: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    session_absolute_lifetime_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    session_concurrent_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    login_failed_attempt_threshold: Mapped[int] = mapped_column(
        Integer, default=5, server_default=text("5"), nullable=False
    )
    login_window_minutes: Mapped[int] = mapped_column(
        Integer, default=15, server_default=text("15"), nullable=False
    )
    login_cooldown_minutes: Mapped[int] = mapped_column(
        Integer, default=15, server_default=text("15"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
