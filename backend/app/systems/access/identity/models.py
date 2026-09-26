"""Local identity persistence owned by FastAPI and PostgreSQL."""

from datetime import datetime
from enum import StrEnum
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
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
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.base import Base


class ActionTokenPurpose(StrEnum):
    INVITATION = "invitation"
    RECOVERY = "recovery"


class IdentityCredential(Base):
    __tablename__ = "identity_credentials"
    __audit_enabled__: ClassVar[bool] = False

    user_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    password_digest: Mapped[str] = mapped_column(Text, nullable=False)
    must_change_password: Mapped[bool] = mapped_column(nullable=False, default=False)
    temporary_password_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )


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


class IdentityActionToken(Base):
    __tablename__ = "identity_action_tokens"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "purpose IN ('invitation', 'recovery')", name="ck_identity_action_tokens_purpose"
        ),
        UniqueConstraint("token_digest", name="uq_identity_action_tokens_token_digest"),
        Index(
            "uq_identity_action_tokens_active_user_purpose",
            "user_id",
            "purpose",
            unique=True,
            postgresql_where=text("consumed_at IS NULL"),
        ),
        Index("ix_identity_action_tokens_user_purpose", "user_id", "purpose", "consumed_at"),
    )

    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    user_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    purpose: Mapped[ActionTokenPurpose] = mapped_column(String(20), nullable=False)
    token_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))


class IdentityRateLimitBucket(Base):
    __tablename__ = "identity_rate_limit_buckets"
    __audit_enabled__: ClassVar[bool] = False

    fingerprint: Mapped[str] = mapped_column(String(64), primary_key=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    window_started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    blocked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
