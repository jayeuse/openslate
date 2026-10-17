"""Author-set reminder timings of a Board event; each occurrence notifies every reader."""

from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel

REMINDER_TIMINGS = ("start", "15m", "1d")


class BoardEventReminder(BaseModel):
    """One timing of an event, such as "1 day before"; it applies to every occurrence."""

    __tablename__ = "board_event_reminders"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_event_reminders_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "board_id"], ["boards.org_id", "boards.id"],
            name="fk_board_event_reminders_board_id_boards", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "event_id"], ["board_events.org_id", "board_events.id"],
            name="fk_board_event_reminders_event_id_board_events", ondelete="RESTRICT",
        ),
        CheckConstraint("timing IN ('start', '15m', '1d')", name="ck_board_event_reminders_timing"),
        UniqueConstraint("event_id", "timing", name="uq_board_event_reminders_event_timing"),
        Index("ix_board_event_reminders_board_id", "board_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    event_id: Mapped[UUID] = mapped_column(nullable=False)
    timing: Mapped[str] = mapped_column(String(8), nullable=False)
