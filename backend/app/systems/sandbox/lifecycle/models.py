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
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.base import Base


class LifecycleOperation(StrEnum):
    CLOSE = "close"
    PURGE = "purge"


class LifecycleChallengeStatus(StrEnum):
    PENDING = "pending"
    VERIFYING = "verifying"
    CONSUMED = "consumed"
    EXPIRED = "expired"
    INVALIDATED = "invalidated"
    EXHAUSTED = "exhausted"


class LifecycleConfirmationChallenge(Base):
    """Short-lived, single-use confirmation state for lifecycle operations."""

    __tablename__ = "lifecycle_confirmation_challenges"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_lifecycle_confirmation_challenges_org_id_id"),
        CheckConstraint(
            "operation IN ('close', 'purge')",
            name="ck_lifecycle_challenges_operation",
        ),
        CheckConstraint(
            "status IN ('pending', 'verifying', 'consumed', 'expired', 'invalidated', 'exhausted')",
            name="ck_lifecycle_challenges_status",
        ),
        CheckConstraint(
            "failed_attempts >= 0 AND failed_attempts <= 5",
            name="ck_lifecycle_challenges_failed_attempts_nonnegative",
        ),
        CheckConstraint(
            "expires_at > created_at AND expires_at <= created_at + interval '5 minutes'",
            name="ck_lifecycle_challenges_five_minute_expiry",
        ),
        CheckConstraint(
            "length(btrim(target_type)) > 0",
            name="ck_lifecycle_challenges_target_type_nonempty",
        ),
        CheckConstraint(
            "length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'",
            name="ck_lifecycle_challenges_token_hash_sha256",
        ),
        CheckConstraint(
            "length(btrim(impact_digest)) > 0",
            name="ck_lifecycle_challenges_impact_digest_nonempty",
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7
    )
    actor_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    operation: Mapped[LifecycleOperation] = mapped_column(String(20), nullable=False)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    impact_digest: Mapped[str] = mapped_column(String(128), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    failed_attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )
    status: Mapped[LifecycleChallengeStatus] = mapped_column(
        String(20),
        default=LifecycleChallengeStatus.PENDING,
        server_default=text("'pending'"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
        server_default=func.now(),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verification_lease_id: Mapped[UUID | None] = mapped_column(
        PostgreSQLUUID(as_uuid=True), nullable=True, unique=True
    )
    verification_lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class LifecycleRateLimitBucket(Base):
    """One mutable rolling fifteen-minute failed-confirmation bucket per actor."""

    __tablename__ = "lifecycle_rate_limit_buckets"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_lifecycle_rate_limit_buckets_org_id_id"),
        UniqueConstraint("org_id", "actor_id", name="uq_lifecycle_rate_limit_buckets_actor_id"),
        CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5",
            name="ck_lifecycle_buckets_attempt_count_nonnegative",
        ),
        CheckConstraint(
            "window_expires_at > window_started_at AND window_expires_at <= "
            "window_started_at + interval '15 minutes'",
            name="ck_lifecycle_buckets_fifteen_minute_window",
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7
    )
    actor_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    attempt_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    window_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    blocked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utc_now,
        onupdate=utc_now,
        server_default=func.now(),
        nullable=False,
    )


class LifecycleRateLimitFailure(Base):
    """An immutable event used to calculate the actor's true rolling window."""

    __tablename__ = "lifecycle_rate_limit_failures"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_lifecycle_rate_limit_failures_org_id_id"),
        Index(
            "ix_lifecycle_rate_limit_failures_actor_occurred",
            "actor_id",
            "occurred_at",
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7
    )
    actor_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, server_default=func.now(), nullable=False
    )


# The longer name is useful to callers that describe these rows as events.
LifecycleRateLimitFailureEvent = LifecycleRateLimitFailure
