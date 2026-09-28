"""One Board content owner per file and retained publication attachment snapshots."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardAttachment(BaseModel):
    """One lifetime content owner per file; only ``is_linked`` may change."""

    __tablename__ = "board_attachments"
    __table_args__ = (
        CheckConstraint(
            "(event_id IS NOT NULL AND post_id IS NULL) OR "
            "(event_id IS NULL AND post_id IS NOT NULL)",
            name="ck_board_attachments_one_owner",
        ),
        UniqueConstraint("file_id", name="uq_board_attachments_file"),
        Index("ix_board_attachments_board_id", "board_id"),
        Index("ix_board_attachments_event_id", "event_id"),
        Index("ix_board_attachments_post_id", "post_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset()

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    file_id: Mapped[UUID] = mapped_column(
        ForeignKey("files.id", ondelete="RESTRICT"), nullable=False
    )
    event_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_events.id", ondelete="RESTRICT"), nullable=True
    )
    post_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_posts.id", ondelete="RESTRICT"), nullable=True
    )
    is_linked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )


class BoardPostRevisionAttachment(BaseModel):
    __tablename__ = "board_post_revision_attachments"
    __table_args__ = (
        UniqueConstraint("revision_id", "file_id", name="uq_board_post_revision_attachments"),
        Index("ix_board_post_revision_attachments_file_id", "file_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset()

    revision_id: Mapped[UUID] = mapped_column(
        ForeignKey("board_post_revisions.id", ondelete="RESTRICT"), nullable=False
    )
    file_id: Mapped[UUID] = mapped_column(
        ForeignKey("files.id", ondelete="RESTRICT"), nullable=False
    )
