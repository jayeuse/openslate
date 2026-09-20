"""Durable, token-safe outbound notification records."""

from datetime import datetime
from enum import StrEnum
from typing import ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.base import Base
from app.systems.access.identity.models import ActionTokenPurpose


class OutboxState(StrEnum):
    PENDING = "pending"
    SENDING = "sending"
    DELIVERED = "delivered"
    FAILED = "failed"
    CANCELED = "canceled"


class IdentityDeliveryOutbox(Base):
    """One encrypted delivery payload per local action token."""

    __tablename__ = "identity_delivery_outbox"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "purpose IN ('invitation', 'recovery')", name="ck_identity_delivery_outbox_purpose"
        ),
        CheckConstraint(
            "state IN ('pending', 'sending', 'delivered', 'failed', 'canceled')",
            name="ck_identity_delivery_outbox_state",
        ),
        CheckConstraint("attempt_count >= 0", name="ck_identity_delivery_outbox_attempt_count"),
        Index("ix_identity_delivery_outbox_due", "state", "next_attempt_at", "id"),
    )

    id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True, default=uuid7)
    action_token_id: Mapped[UUID] = mapped_column(
        PostgreSQLUUID(as_uuid=True),
        ForeignKey("identity_action_tokens.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    recipient: Mapped[str] = mapped_column(String(320), nullable=False)
    purpose: Mapped[ActionTokenPurpose] = mapped_column(String(20), nullable=False)
    encrypted_token: Mapped[str | None] = mapped_column(Text)
    state: Mapped[OutboxState] = mapped_column(
        String(20), nullable=False, default=OutboxState.PENDING
    )
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    lease_token: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )
