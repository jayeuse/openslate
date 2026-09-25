"""Audited Board announcements and retained published-content snapshots."""

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
    audience_kind: str,
    audience_role_id: UUID | None = None,
    audience_user_id: UUID | None = None,
    audience_department_id: UUID | None = None,
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
        "audience_kind": audience_kind,
        "audience_role_id": str(audience_role_id) if audience_role_id else None,
        "audience_user_id": str(audience_user_id) if audience_user_id else None,
        "audience_department_id": (str(audience_department_id) if audience_department_id else None),
        "expires_at": expires_at.astimezone(UTC).isoformat() if expires_at else None,
    }
    if links:
        # Preserve legacy empty-link fingerprints for pre-migration idempotent retries.
        content["links"] = links
    if attachment_file_ids:
        content["attachment_file_ids"] = sorted(str(file_id) for file_id in attachment_file_ids)
    if record_links:
        content["record_links"] = sorted(
            (str(record_id), str(module_id), label) for record_id, module_id, label in record_links
        )
    encoded = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _audience_check(table: str) -> CheckConstraint:
    return CheckConstraint(
        "(audience_kind IN ('everyone', 'author') AND audience_role_id IS NULL "
        "AND audience_user_id IS NULL AND audience_department_id IS NULL) OR "
        "(audience_kind = 'role' AND audience_role_id IS NOT NULL "
        "AND audience_user_id IS NULL AND audience_department_id IS NULL) OR "
        "(audience_kind = 'user' AND audience_role_id IS NULL "
        "AND audience_user_id IS NOT NULL AND audience_department_id IS NULL) OR "
        "(audience_kind = 'department' AND audience_role_id IS NULL "
        "AND audience_user_id IS NULL AND audience_department_id IS NOT NULL)",
        name=f"ck_{table}_audience",
    )


class BoardAnnouncement(BaseModel):
    """Mutable working content; publication appends an immutable revision row."""

    __tablename__ = "board_announcements"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"title", "body", "links"})
    __table_args__ = (
        CheckConstraint("length(btrim(title)) > 0", name="ck_board_announcements_title_nonempty"),
        CheckConstraint("length(btrim(body)) > 0", name="ck_board_announcements_body_nonempty"),
        CheckConstraint("length(body) <= 2000", name="ck_board_announcements_body_length"),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(links) = 'array' "
            "THEN jsonb_array_length(links) <= 20 ELSE false END",
            name="ck_board_announcements_links_array_limit",
        ),
        CheckConstraint(
            "status IN ('draft', 'scheduled', 'published', 'archived')",
            name="ck_board_announcements_status",
        ),
        CheckConstraint(
            "status <> 'scheduled' OR publish_at IS NOT NULL",
            name="ck_board_announcements_scheduled_time",
        ),
        CheckConstraint(
            "publish_at IS NULL OR expires_at IS NULL OR expires_at > publish_at",
            name="ck_board_announcements_expiry",
        ),
        CheckConstraint("revision > 0", name="ck_board_announcements_revision_positive"),
        CheckConstraint(
            "displayed_publication_number IS NULL OR displayed_publication_number > 0",
            name="ck_board_announcements_displayed_publication_positive",
        ),
        _audience_check("board_announcements"),
        Index("ix_board_announcements_board_id", "board_id"),
        Index("ix_board_announcements_author_id", "author_id"),
        Index("ix_board_announcements_audience_role_id", "audience_role_id"),
        Index("ix_board_announcements_audience_user_id", "audience_user_id"),
        Index("ix_board_announcements_audience_department_id", "audience_department_id"),
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
    audience_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    audience_role_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=True
    )
    audience_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    audience_department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=True
    )
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )
    displayed_publication_number: Mapped[int | None] = mapped_column(Integer, nullable=True)


class BoardAnnouncementRevision(BaseModel):
    """One displayed publication snapshot; UPDATE is forbidden by the migration trigger."""

    __tablename__ = "board_announcement_revisions"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"title", "body", "links", "content_fingerprint"}
    )
    __table_args__ = (
        UniqueConstraint(
            "announcement_id",
            "publication_number",
            name="uq_board_announcement_revisions_publication",
        ),
        UniqueConstraint(
            "announcement_id",
            "publication_key",
            name="uq_board_announcement_revisions_publication_key",
        ),
        CheckConstraint(
            "publication_number > 0", name="ck_board_announcement_revisions_number_positive"
        ),
        CheckConstraint(
            "content_fingerprint ~ '^[0-9a-f]{64}$'",
            name="ck_board_announcement_revisions_fingerprint_hex",
        ),
        CheckConstraint(
            "length(btrim(title)) > 0", name="ck_board_announcement_revisions_title_nonempty"
        ),
        CheckConstraint(
            "length(btrim(body)) > 0", name="ck_board_announcement_revisions_body_nonempty"
        ),
        CheckConstraint("length(body) <= 2000", name="ck_board_announcement_revisions_body_length"),
        CheckConstraint(
            "CASE WHEN jsonb_typeof(links) = 'array' "
            "THEN jsonb_array_length(links) <= 20 ELSE false END",
            name="ck_board_announcement_revisions_links_array_limit",
        ),
        CheckConstraint(
            "expires_at IS NULL OR expires_at > published_at",
            name="ck_board_announcement_revisions_expiry",
        ),
        _audience_check("board_announcement_revisions"),
        Index("ix_board_announcement_revisions_author_id", "author_id"),
        Index("ix_board_announcement_revisions_audience_role_id", "audience_role_id"),
        Index("ix_board_announcement_revisions_audience_user_id", "audience_user_id"),
        Index("ix_board_announcement_revisions_audience_department_id", "audience_department_id"),
    )

    announcement_id: Mapped[UUID] = mapped_column(
        ForeignKey("board_announcements.id", ondelete="RESTRICT"), nullable=False
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
    audience_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    audience_role_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=True
    )
    audience_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    audience_department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=True
    )
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
