"""Audited per-user read and bookmark state for Board announcements."""

from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardAnnouncementPersonalState(BaseModel):
    """One user's state for an announcement; an absent row means both flags are false."""

    __tablename__ = "board_announcement_personal_states"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "announcement_id",
            name="uq_board_announcement_personal_states_user_announcement",
        ),
        Index("ix_board_announcement_personal_states_announcement_id", "announcement_id"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    announcement_id: Mapped[UUID] = mapped_column(
        ForeignKey("board_announcements.id", ondelete="RESTRICT"), nullable=False
    )
    read: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    bookmarked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
