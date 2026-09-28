"""Author-set reminder timings of a Board event; each occurrence notifies every reader."""

from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel

REMINDER_TIMINGS = ("start", "15m", "1d")


class BoardEventReminder(BaseModel):
    """One timing of an event, such as "1 day before"; it applies to every occurrence."""

    __tablename__ = "board_event_reminders"
    __table_args__ = (
        CheckConstraint("timing IN ('start', '15m', '1d')", name="ck_board_event_reminders_timing"),
        UniqueConstraint("event_id", "timing", name="uq_board_event_reminders_event_timing"),
        Index("ix_board_event_reminders_board_id", "board_id"),
    )

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="RESTRICT"))
    event_id: Mapped[UUID] = mapped_column(ForeignKey("board_events.id", ondelete="RESTRICT"))
    timing: Mapped[str] = mapped_column(String(8), nullable=False)
