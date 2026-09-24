"""Audited personal reminders for one derived Board Event occurrence."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardEventReminder(BaseModel):
    """One recipient's once-only choice for a canonical occurrence ID."""

    __tablename__ = "board_event_reminders"
    __table_args__ = (
        CheckConstraint(
            "timing IN ('now', 'start', '15m', '1d')", name="ck_board_event_reminders_timing"
        ),
        CheckConstraint(
            "length(btrim(occurrence_id)) > 0", name="ck_board_event_reminders_occurrence_id"
        ),
        UniqueConstraint(
            "event_id", "recipient_id", "occurrence_id", name="uq_board_event_reminders_choice"
        ),
        Index("ix_board_event_reminders_board_recipient", "board_id", "recipient_id"),
        Index("ix_board_event_reminders_event_id", "event_id"),
    )

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="RESTRICT"))
    event_id: Mapped[UUID] = mapped_column(ForeignKey("board_events.id", ondelete="RESTRICT"))
    recipient_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    occurrence_id: Mapped[str] = mapped_column(String(100), nullable=False)
    occurrence_start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    timing: Mapped[str] = mapped_column(String(8), nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
