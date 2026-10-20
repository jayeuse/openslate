from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class CommsAdmission(BaseModel):
    __tablename__ = "comms_admissions"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_admissions_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_admissions_conversation",
            ondelete="RESTRICT",
        ),
        CheckConstraint("kind IN ('request','invitation')", name="ck_comms_admissions_kind"),
        CheckConstraint(
            "status IN ('pending','accepted','declined')", name="ck_comms_admissions_status"
        ),
        CheckConstraint(
            "(status = 'pending') = (resolved_at IS NULL)", name="ck_comms_admissions_resolution"
        ),
        Index(
            "uq_comms_admissions_pending",
            "org_id",
            "conversation_id",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'pending' AND is_deleted = false"),
        ),
        Index("ix_comms_admissions_conversation", "org_id", "conversation_id", "created_at", "id"),
        Index("ix_comms_admissions_user", "user_id", "org_id"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, default="pending", server_default=text("'pending'"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
