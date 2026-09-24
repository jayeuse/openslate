"""One Board content owner per file and retained publication attachment snapshots."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardContentAttachment(BaseModel):
    """One lifetime content owner per file; only ``is_linked`` may change."""

    __tablename__ = "board_content_attachments"
    __table_args__ = (
        CheckConstraint(
            "(event_id IS NOT NULL AND announcement_id IS NULL) OR "
            "(event_id IS NULL AND announcement_id IS NOT NULL)",
            name="ck_board_content_attachments_one_owner",
        ),
        UniqueConstraint("file_id", name="uq_board_content_attachments_file"),
        Index("ix_board_content_attachments_board_id", "board_id"),
        Index("ix_board_content_attachments_event_id", "event_id"),
        Index("ix_board_content_attachments_announcement_id", "announcement_id"),
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
    announcement_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("board_announcements.id", ondelete="RESTRICT"), nullable=True
    )
    is_linked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )


class BoardAnnouncementRevisionAttachment(BaseModel):
    __tablename__ = "board_announcement_revision_attachments"
    __table_args__ = (
        UniqueConstraint(
            "revision_id", "file_id", name="uq_board_announcement_revision_attachments"
        ),
        Index("ix_board_announcement_revision_attachments_file_id", "file_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset()

    revision_id: Mapped[UUID] = mapped_column(
        ForeignKey("board_announcement_revisions.id", ondelete="RESTRICT"), nullable=False
    )
    file_id: Mapped[UUID] = mapped_column(
        ForeignKey("files.id", ondelete="RESTRICT"), nullable=False
    )
