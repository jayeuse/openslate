"""Audited Board event series, independent of occurrence expansion and reminders."""

from datetime import date, datetime
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardEvent(BaseModel):
    """A retained series definition; occurrences are derived from its temporal fields."""

    __tablename__ = "board_events"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"title", "details", "location", "links"}
    )
    __table_args__ = (
        CheckConstraint("length(btrim(title)) > 0", name="ck_board_events_title_nonempty"),
        CheckConstraint("length(details) <= 4000", name="ck_board_events_details_length"),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(links) = 'array' "
            "THEN jsonb_array_length(links) <= 20 ELSE false END",
            name="ck_board_events_links_array_limit",
        ),
        CheckConstraint("revision > 0", name="ck_board_events_revision_positive"),
        CheckConstraint(
            "(all_day = true AND start_date IS NOT NULL AND end_date IS NOT NULL "
            "AND start_at IS NULL AND end_at IS NULL AND end_date >= start_date) OR "
            "(all_day = false AND start_date IS NULL AND end_date IS NULL "
            "AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at)",
            name="ck_board_events_temporal_mode",
        ),
        CheckConstraint(
            "length(btrim(timezone_name)) > 0", name="ck_board_events_timezone_nonempty"
        ),
        CheckConstraint(
            "(recurrence = 'none' AND repeat_until IS NULL) OR "
            "(recurrence IN ('daily', 'weekly', 'monthly') AND repeat_until IS NOT NULL)",
            name="ck_board_events_recurrence",
        ),
        CheckConstraint(
            "repeat_until IS NULL OR NOT all_day OR repeat_until >= start_date",
            name="ck_board_events_all_day_repeat_until",
        ),
        Index("ix_board_events_board_id", "board_id"),
        Index("ix_board_events_author_id", "author_id"),
    )

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    author_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    details: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=text("''")
    )
    location: Mapped[str] = mapped_column(
        String(240), nullable=False, default="", server_default=text("''")
    )
    links: Mapped[list[dict[str, str]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    all_day: Mapped[bool] = mapped_column(Boolean, nullable=False)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    timezone_name: Mapped[str] = mapped_column(String(80), nullable=False)
    recurrence: Mapped[str] = mapped_column(
        String(10), nullable=False, default="none", server_default=text("'none'")
    )
    repeat_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
