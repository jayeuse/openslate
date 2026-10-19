"""Unaudited organization-bound projections and bounded durable token admissions."""

from datetime import datetime
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column
from uuid6 import uuid7

from app.core.database.base import Base


class CommsRealtimeGrant(Base):
    __tablename__ = "comms_realtime_grants"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_realtime_grants_org_id_id"),
        UniqueConstraint(
            "org_id", "user_id", "conversation_id", name="uq_comms_realtime_grants_subject"
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_realtime_grants_conversation",
            ondelete="CASCADE",
        ),
        Index("ix_comms_realtime_grants_expiry", "org_id", "expires_at"),
        Index("ix_comms_realtime_grants_conversation", "org_id", "conversation_id"),
        Index("ix_comms_realtime_grants_user", "user_id"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid7)
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    conversation_id: Mapped[UUID]
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CommsRealtimeAdmission(Base):
    __tablename__ = "comms_realtime_admissions"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_realtime_admissions_org_id_id"),
        UniqueConstraint("org_id", "user_id", name="uq_comms_realtime_admissions_subject"),
        CheckConstraint(
            "cardinality(issued_at) BETWEEN 1 AND 6 AND array_position(issued_at, NULL) IS NULL",
            name="ck_comms_realtime_admissions_bound",
        ),
        Index("ix_comms_realtime_admissions_user", "user_id"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid7)
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    issued_at: Mapped[list[datetime]] = mapped_column(ARRAY(DateTime(timezone=True)))
