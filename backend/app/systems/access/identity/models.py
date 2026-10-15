"""Local identity persistence owned by FastAPI and PostgreSQL."""

from datetime import datetime
from typing import ClassVar
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
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.base import Base


class IdentitySession(Base):
    __tablename__ = "identity_sessions"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("refresh_token_digest", name="uq_identity_sessions_refresh_token_digest"),
        Index("ix_identity_sessions_user_active", "user_id", "revoked_at", "expires_at"),
    )

    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    user_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    active_org_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True
    )
    provider_user_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    provider_session_id: Mapped[UUID | None] = mapped_column(
        PostgreSQLUUID(as_uuid=True), unique=True
    )
    provider_access_token_encrypted: Mapped[str | None] = mapped_column(Text)
    provider_refresh_token_encrypted: Mapped[str | None] = mapped_column(Text)
    provider_signout_pending_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_signout_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    provider_signout_next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    provider_signout_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refresh_token_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    csrf_token_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    refreshed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(String(500))
    ip_address: Mapped[str | None] = mapped_column(INET)


class IdentityMfaObservation(Base):
    """Last complete bound observation, independently of profile audit metadata."""

    __tablename__ = "identity_mfa_observations"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "((observed_provider_user_id IS NULL AND verified_totp IS NULL "
            "AND observed_at IS NULL) OR (observed_provider_user_id IS NOT NULL "
            "AND observed_at IS NOT NULL)) IS TRUE",
            name="ck_identity_mfa_observations_authority",
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    observed_provider_user_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    verified_totp: Mapped[bool | None] = mapped_column(Boolean)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sign_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IdentityRateLimitBucket(Base):
    __tablename__ = "identity_rate_limit_buckets"
    __audit_enabled__: ClassVar[bool] = False

    fingerprint: Mapped[str] = mapped_column(String(64), primary_key=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    window_started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    blocked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
