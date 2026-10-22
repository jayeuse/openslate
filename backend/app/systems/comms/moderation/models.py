from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class CommsReport(BaseModel):
    __tablename__ = "comms_reports"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"reason"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_reports_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "conversation_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_reports_message", ondelete="RESTRICT",
        ),
        CheckConstraint("status IN ('open','resolved')", name="ck_comms_reports_status"),
        CheckConstraint(
            "char_length(btrim(reason)) BETWEEN 1 AND 2000", name="ck_comms_reports_reason",
        ),
        Index("ix_comms_reports_source", "org_id", "conversation_id", "message_id"),
        Index("ix_comms_reports_queue", "org_id", "created_at", "id"),
        Index("ix_comms_reports_reporter", "reporter_id"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    message_id: Mapped[UUID] = mapped_column(nullable=False)
    reporter_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, default="open", server_default="open", nullable=False)
