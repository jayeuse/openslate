"""Audited Board posts and retained published-content snapshots."""

import hashlib
import json
from datetime import UTC, datetime
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


def publication_content_fingerprint(
    *,
    author_id: UUID,
    title: str,
    body: str,
    expires_at: datetime | None = None,
    links: list[dict[str, str]] | None = None,
    attachment_file_ids: list[UUID] | None = None,
    record_links: list[tuple[UUID, UUID, str]] | None = None,
) -> str:
    """Hash only immutable publication content, not the server-assigned publication time."""
    content: dict[str, object] = {
        "author_id": str(author_id),
        "title": title,
        "body": body,
        "expires_at": expires_at.astimezone(UTC).isoformat() if expires_at else None,
        "links": links or [],
        "attachment_file_ids": sorted(str(file_id) for file_id in attachment_file_ids or []),
        "record_links": sorted(
            (str(record_id), str(module_id), label)
            for record_id, module_id, label in record_links or []
        ),
    }
    encoded = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class BoardPost(BaseModel):
    """Mutable working content; publication appends an immutable revision row."""

    __tablename__ = "board_posts"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"title", "body", "links"})
    __table_args__ = (
        CheckConstraint("length(btrim(title)) > 0", name="ck_board_posts_title_nonempty"),
        CheckConstraint("length(btrim(body)) > 0", name="ck_board_posts_body_nonempty"),
        CheckConstraint("length(body) <= 2000", name="ck_board_posts_body_length"),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(links) = 'array' "
            "THEN jsonb_array_length(links) <= 20 ELSE false END",
            name="ck_board_posts_links_array_limit",
        ),
        CheckConstraint(
            "status IN ('draft', 'scheduled', 'published', 'archived')",
            name="ck_board_posts_status",
        ),
        CheckConstraint(
            "status <> 'scheduled' OR publish_at IS NOT NULL",
            name="ck_board_posts_scheduled_time",
        ),
        CheckConstraint(
            "publish_at IS NULL OR expires_at IS NULL OR expires_at > publish_at",
            name="ck_board_posts_expiry",
        ),
        CheckConstraint("revision > 0", name="ck_board_posts_revision_positive"),
        CheckConstraint(
            "displayed_publication_number IS NULL OR displayed_publication_number > 0",
            name="ck_board_posts_displayed_publication_positive",
        ),
        Index("ix_board_posts_board_id", "board_id"),
        Index("ix_board_posts_author_id", "author_id"),
    )

    board_id: Mapped[UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=False
    )
    author_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    links: Mapped[list[dict[str, str]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="draft", server_default=text("'draft'")
    )
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pinned: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    displayed_publication_number: Mapped[int | None] = mapped_column(Integer, nullable=True)


class BoardPostRevision(BaseModel):
    """One published version of a post; UPDATE is forbidden by a database trigger."""

    __tablename__ = "board_post_revisions"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"title", "body", "links", "content_fingerprint"}
    )
    __table_args__ = (
        UniqueConstraint(
            "post_id",
            "publication_number",
            name="uq_board_post_revisions_publication",
        ),
        UniqueConstraint(
            "post_id",
            "publication_key",
            name="uq_board_post_revisions_publication_key",
        ),
        CheckConstraint("publication_number > 0", name="ck_board_post_revisions_number_positive"),
        CheckConstraint(
            "content_fingerprint ~ '^[0-9a-f]{64}$'",
            name="ck_board_post_revisions_fingerprint_hex",
        ),
        CheckConstraint(
            "length(btrim(title)) > 0", name="ck_board_post_revisions_title_nonempty"
        ),
        CheckConstraint("length(btrim(body)) > 0", name="ck_board_post_revisions_body_nonempty"),
        CheckConstraint("length(body) <= 2000", name="ck_board_post_revisions_body_length"),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(links) = 'array' "
            "THEN jsonb_array_length(links) <= 20 ELSE false END",
            name="ck_board_post_revisions_links_array_limit",
        ),
        CheckConstraint(
            "expires_at IS NULL OR expires_at > published_at",
            name="ck_board_post_revisions_expiry",
        ),
        Index("ix_board_post_revisions_author_id", "author_id"),
    )

    post_id: Mapped[UUID] = mapped_column(
        ForeignKey("board_posts.id", ondelete="RESTRICT"), nullable=False
    )
    publication_number: Mapped[int] = mapped_column(Integer, nullable=False)
    publication_key: Mapped[UUID] = mapped_column(nullable=False)
    content_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    author_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    links: Mapped[list[dict[str, str]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
