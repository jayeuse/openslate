"""Record-date sources of a Board calendar or of one person's My calendar (BR57, BE8).

A source is one module and one of its ``date`` or ``datetime`` fields. It belongs to
exactly one owner: a Board (managers add and remove it) or a person in one
organization. Records come from the window read; a source stores no Record data.
"""

from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel

MAX_SOURCES = 5


class BoardCalendarSource(BaseModel):
    __tablename__ = "board_calendar_sources"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_calendar_sources_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "board_id"], ["boards.org_id", "boards.id"],
            name="fk_board_calendar_sources_board_id_boards", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_board_calendar_sources_module_id_modules", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "date_field_id"], ["fields.org_id", "fields.id"],
            name="fk_board_calendar_sources_date_field_id_fields", ondelete="RESTRICT",
        ),
        CheckConstraint(
            "num_nonnulls(board_id, user_id) = 1", name="ck_board_calendar_sources_one_owner"
        ),
        CheckConstraint("position >= 0", name="ck_board_calendar_sources_position"),
        UniqueConstraint(
            "org_id", "board_id", "date_field_id", name="uq_board_calendar_sources_board_field"
        ),
        UniqueConstraint(
            "org_id", "user_id", "date_field_id", name="uq_board_calendar_sources_user_field"
        ),
        Index("ix_board_calendar_sources_board_id", "board_id"),
        Index("ix_board_calendar_sources_user_id", "user_id"),
        Index("ix_board_calendar_sources_module_id", "module_id"),
        Index("ix_board_calendar_sources_date_field_id", "date_field_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID | None] = mapped_column(nullable=True)
    user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    module_id: Mapped[UUID] = mapped_column(nullable=False)
    date_field_id: Mapped[UUID] = mapped_column(nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
