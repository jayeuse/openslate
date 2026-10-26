"""Board post and event Record references and immutable publication snapshots."""

from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, ForeignKeyConstraint, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardRecordLink(BaseModel):
    __tablename__ = "board_record_links"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_record_links_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "board_id"], ["boards.org_id", "boards.id"],
            name="fk_board_record_links_board_id_boards", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "event_id"], ["board_events.org_id", "board_events.id"],
            name="fk_board_record_links_event_id_board_events", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "post_id"], ["board_posts.org_id", "board_posts.id"],
            name="fk_board_record_links_post_id_board_posts", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "record_id"], ["records.org_id", "records.id"],
            name="fk_board_record_links_record_id_records", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_board_record_links_module_id_modules", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "card_id"], ["board_cards.org_id", "board_cards.id"],
            name="fk_board_record_links_card_id_board_cards", ondelete="RESTRICT",
        ),
        CheckConstraint(
            "num_nonnulls(event_id, post_id, card_id) = 1",
            name="ck_board_record_links_one_owner",
        ),
        UniqueConstraint("event_id", "record_id", name="uq_board_event_record_link"),
        UniqueConstraint("post_id", "record_id", name="uq_board_post_record_link"),
        UniqueConstraint("card_id", "record_id", name="uq_board_card_record_link"),
        Index("ix_board_record_links_board_id", "board_id"),
        Index("ix_board_record_links_record_id", "record_id"),
        Index("ix_board_record_links_module_id", "module_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    event_id: Mapped[UUID | None] = mapped_column(nullable=True)
    post_id: Mapped[UUID | None] = mapped_column(nullable=True)
    card_id: Mapped[UUID | None] = mapped_column(nullable=True)
    record_id: Mapped[UUID] = mapped_column(nullable=False)
    module_id: Mapped[UUID] = mapped_column(nullable=False)


class BoardPostRevisionRecordLink(BaseModel):
    __tablename__ = "board_post_revision_record_links"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_post_revision_record_links_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "revision_id"], ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_board_revision_record_links_revision",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "record_id"], ["records.org_id", "records.id"],
            name="fk_board_post_revision_record_links_record_id_records", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_board_post_revision_record_links_module_id_modules", ondelete="RESTRICT",
        ),
        UniqueConstraint("revision_id", "record_id", name="uq_board_revision_record_link"),
        Index("ix_board_revision_record_links_record_id", "record_id"),
        Index("ix_board_revision_record_links_module_id", "module_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    revision_id: Mapped[UUID] = mapped_column(nullable=False)
    record_id: Mapped[UUID] = mapped_column(nullable=False)
    module_id: Mapped[UUID] = mapped_column(nullable=False)
