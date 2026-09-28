"""Board post and event Record references and immutable publication snapshots."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardRecordLink(BaseModel):
    __tablename__ = "board_record_links"
    __table_args__ = (
        CheckConstraint("length(btrim(label)) > 0", name="ck_board_record_links_label"),
        CheckConstraint(
            "(event_id IS NOT NULL AND post_id IS NULL) OR "
            "(event_id IS NULL AND post_id IS NOT NULL)",
            name="ck_board_record_links_one_owner",
        ),
        UniqueConstraint("event_id", "record_id", name="uq_board_event_record_link"),
        UniqueConstraint("post_id", "record_id", name="uq_board_post_record_link"),
        Index("ix_board_record_links_board_id", "board_id"),
        Index("ix_board_record_links_record_id", "record_id"),
        Index("ix_board_record_links_module_id", "module_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"label"})

    board_id: Mapped[UUID] = mapped_column(ForeignKey("boards.id", ondelete="RESTRICT"))
    event_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_events.id", ondelete="RESTRICT"), nullable=True
    )
    post_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_posts.id", ondelete="RESTRICT"), nullable=True
    )
    record_id: Mapped[UUID] = mapped_column(ForeignKey("records.id", ondelete="RESTRICT"))
    module_id: Mapped[UUID] = mapped_column(ForeignKey("modules.id", ondelete="RESTRICT"))
    label: Mapped[str] = mapped_column(String(100), nullable=False)


class BoardPostRevisionRecordLink(BaseModel):
    __tablename__ = "board_post_revision_record_links"
    __table_args__ = (
        CheckConstraint("length(btrim(label)) > 0", name="ck_board_revision_record_links_label"),
        UniqueConstraint("revision_id", "record_id", name="uq_board_revision_record_link"),
        Index("ix_board_revision_record_links_record_id", "record_id"),
        Index("ix_board_revision_record_links_module_id", "module_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"label"})

    revision_id: Mapped[UUID] = mapped_column(
        ForeignKey("board_post_revisions.id", ondelete="RESTRICT")
    )
    record_id: Mapped[UUID] = mapped_column(ForeignKey("records.id", ondelete="RESTRICT"))
    module_id: Mapped[UUID] = mapped_column(ForeignKey("modules.id", ondelete="RESTRICT"))
    label: Mapped[str] = mapped_column(String(100), nullable=False)
