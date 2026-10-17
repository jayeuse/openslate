"""One Board content owner per file and retained publication attachment snapshots."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardAttachment(BaseModel):
    """One lifetime content owner per file; only ``is_linked`` may change."""

    __tablename__ = "board_attachments"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_attachments_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "board_id"], ["boards.org_id", "boards.id"],
            name="fk_board_attachments_board_id_boards", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "file_id"], ["files.org_id", "files.id"],
            name="fk_board_attachments_file_id_files", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "event_id"], ["board_events.org_id", "board_events.id"],
            name="fk_board_attachments_event_id_board_events", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "post_id"], ["board_posts.org_id", "board_posts.id"],
            name="fk_board_attachments_post_id_board_posts", ondelete="RESTRICT",
        ),
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

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    board_id: Mapped[UUID] = mapped_column(nullable=False)
    file_id: Mapped[UUID] = mapped_column(nullable=False)
    event_id: Mapped[UUID | None] = mapped_column(nullable=True)
    post_id: Mapped[UUID | None] = mapped_column(nullable=True)
    is_linked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )


class BoardPostRevisionAttachment(BaseModel):
    __tablename__ = "board_post_revision_attachments"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_board_post_revision_attachments_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "revision_id"], ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_board_revision_attachments_revision",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "file_id"], ["files.org_id", "files.id"],
            name="fk_board_post_revision_attachments_file_id_files", ondelete="RESTRICT",
        ),
        UniqueConstraint("revision_id", "file_id", name="uq_board_post_revision_attachments"),
        Index("ix_board_post_revision_attachments_file_id", "file_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset()

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    revision_id: Mapped[UUID] = mapped_column(nullable=False)
    file_id: Mapped[UUID] = mapped_column(nullable=False)
