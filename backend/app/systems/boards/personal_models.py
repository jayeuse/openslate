"""Audited, per-user Board favorites and home placement."""

from uuid import UUID

from sqlalchemy import ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardFavorite(BaseModel):
    """One user's favorite association with a retained Board."""

    __tablename__ = "board_favorites"
    __table_args__ = (
        UniqueConstraint("user_id", "board_id", name="uq_board_favorites_user_board"),
        Index("ix_board_favorites_board_id", "board_id"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )


class BoardHome(BaseModel):
    """At most one preferred home Board per user; archive leaves it retained."""

    __tablename__ = "board_homes"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_board_homes_user_id"),
        Index("ix_board_homes_board_id", "board_id"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
