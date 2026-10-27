"""A Board's own Kanban: stages, labels, cards, card labels and checklist items.

Every row carries its Board, so audit attribution, live invalidations and purge
work by ``board_id``; composite keys keep a card, its stage, its labels and its
checklist on one Board. Writers lock the Board row before any Kanban row.
"""

from datetime import date, datetime
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel

COLORS = ("chart-1", "chart-2", "chart-3", "chart-4", "chart-5")
_COLOR_LIST = ", ".join(f"'{color}'" for color in COLORS)
ACTIVE = "archived_at IS NULL AND NOT is_deleted"


def _board_key(table: str) -> ForeignKeyConstraint:
    return ForeignKeyConstraint(
        ["org_id", "board_id"], ["boards.org_id", "boards.id"],
        name=f"fk_{table}_board_id_boards", ondelete="RESTRICT",
    )


class BoardStage(BaseModel):
    """One Kanban column; managers own it. Archived stages keep their rows."""

    __tablename__ = "board_stages"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_stages_org_id_id"),
        UniqueConstraint("org_id", "board_id", "id", name="uq_board_stages_board_key"),
        _board_key("board_stages"),
        CheckConstraint("length(btrim(name)) > 0", name="ck_board_stages_name_nonempty"),
        CheckConstraint(
            f"color IS NULL OR color IN ({_COLOR_LIST})", name="ck_board_stages_color"
        ),
        CheckConstraint("wip_limit IS NULL OR wip_limit >= 1", name="ck_board_stages_wip_limit"),
        CheckConstraint(
            "card_sort IN ('manual', 'due', 'newest', 'title')", name="ck_board_stages_card_sort"
        ),
        CheckConstraint("position >= 0", name="ck_board_stages_position"),
        CheckConstraint("revision > 0", name="ck_board_stages_revision_positive"),
        Index(
            "uq_board_stages_board_position_active", "board_id", "position",
            unique=True, postgresql_where=text(ACTIVE),
        ),
        Index("ix_board_stages_board_id", "board_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    color: Mapped[str | None] = mapped_column(String(10), nullable=True)
    wip_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    card_sort: Mapped[str] = mapped_column(
        String(10), nullable=False, default="manual", server_default=text("'manual'")
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )


class BoardLabel(BaseModel):
    """A Board-defined label; managers own it and writers apply it."""

    __tablename__ = "board_labels"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_labels_org_id_id"),
        UniqueConstraint("org_id", "board_id", "id", name="uq_board_labels_board_key"),
        _board_key("board_labels"),
        CheckConstraint("length(btrim(name)) > 0", name="ck_board_labels_name_nonempty"),
        CheckConstraint(f"color IN ({_COLOR_LIST})", name="ck_board_labels_color"),
        CheckConstraint("position >= 0", name="ck_board_labels_position"),
        CheckConstraint("revision > 0", name="ck_board_labels_revision_positive"),
        Index("uq_board_labels_board_name", "board_id", func.lower(text("name")), unique=True),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(String(40), nullable=False)
    color: Mapped[str] = mapped_column(String(10), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )


class BoardCard(BaseModel):
    """An objective (title and description) or a record card (one Record by ID)."""

    __tablename__ = "board_cards"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"title", "description"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_cards_org_id_id"),
        UniqueConstraint("org_id", "board_id", "id", name="uq_board_cards_board_key"),
        _board_key("board_cards"),
        ForeignKeyConstraint(
            ["org_id", "board_id", "stage_id"],
            ["board_stages.org_id", "board_stages.board_id", "board_stages.id"],
            name="fk_board_cards_stage_id_board_stages", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_board_cards_module_id_modules", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "record_id"], ["records.org_id", "records.id"],
            name="fk_board_cards_record_id_records", ondelete="RESTRICT",
        ),
        CheckConstraint("kind IN ('objective', 'record')", name="ck_board_cards_kind"),
        CheckConstraint(
            "(kind = 'objective' AND title IS NOT NULL AND length(btrim(title)) > 0 "
            "AND module_id IS NULL AND record_id IS NULL) OR "
            "(kind = 'record' AND title IS NULL AND description IS NULL "
            "AND module_id IS NOT NULL AND record_id IS NOT NULL)",
            name="ck_board_cards_kind_columns",
        ),
        CheckConstraint(
            "description IS NULL OR length(description) <= 5000",
            name="ck_board_cards_description_length",
        ),
        CheckConstraint(
            "start_on IS NULL OR due_on IS NULL OR start_on <= due_on",
            name="ck_board_cards_dates",
        ),
        CheckConstraint("revision > 0", name="ck_board_cards_revision_positive"),
        Index(
            "uq_board_cards_board_record_active", "board_id", "record_id", unique=True,
            postgresql_where=text(f"record_id IS NOT NULL AND {ACTIVE}"),
        ),
        Index(
            "uq_board_cards_stage_rank_active", "stage_id", "rank",
            unique=True, postgresql_where=text(ACTIVE),
        ),
        Index("ix_board_cards_board_id", "board_id"),
        Index("ix_board_cards_record_id", "record_id"),
        Index("ix_board_cards_module_id", "module_id"),
        Index("ix_board_cards_assignee_id", "assignee_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    stage_id: Mapped[UUID] = mapped_column(nullable=False)
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    module_id: Mapped[UUID | None] = mapped_column(nullable=True)
    record_id: Mapped[UUID | None] = mapped_column(nullable=True)
    assignee_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    start_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )


class BoardCardLabel(BaseModel):
    """One label applied to one card of the same Board."""

    __tablename__ = "board_card_labels"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_card_labels_org_id_id"),
        _board_key("board_card_labels"),
        ForeignKeyConstraint(
            ["org_id", "board_id", "card_id"],
            ["board_cards.org_id", "board_cards.board_id", "board_cards.id"],
            name="fk_board_card_labels_card_id_board_cards", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "board_id", "label_id"],
            ["board_labels.org_id", "board_labels.board_id", "board_labels.id"],
            name="fk_board_card_labels_label_id_board_labels", ondelete="RESTRICT",
        ),
        UniqueConstraint("card_id", "label_id", name="uq_board_card_labels_pair"),
        Index("ix_board_card_labels_label_id", "label_id"),
        Index("ix_board_card_labels_board_id", "board_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    card_id: Mapped[UUID] = mapped_column(nullable=False)
    label_id: Mapped[UUID] = mapped_column(nullable=False)


class BoardCardChecklistItem(BaseModel):
    """One checklist line of an objective card."""

    __tablename__ = "board_card_checklist_items"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"text"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_card_checklist_items_org_id_id"),
        _board_key("board_card_checklist_items"),
        ForeignKeyConstraint(
            ["org_id", "board_id", "card_id"],
            ["board_cards.org_id", "board_cards.board_id", "board_cards.id"],
            name="fk_board_card_checklist_items_card_id_board_cards", ondelete="RESTRICT",
        ),
        CheckConstraint("length(btrim(text)) > 0", name="ck_board_card_checklist_items_text"),
        CheckConstraint("position >= 0", name="ck_board_card_checklist_items_position"),
        CheckConstraint(
            "revision > 0", name="ck_board_card_checklist_items_revision_positive"
        ),
        Index(
            "uq_board_card_checklist_items_card_position", "card_id", "position", unique=True
        ),
        Index("ix_board_card_checklist_items_board_id", "board_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    card_id: Mapped[UUID] = mapped_column(nullable=False)
    done: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    # Last: inside the class body this name shadows ``sqlalchemy.text``.
    text: Mapped[str] = mapped_column(String(200), nullable=False)
