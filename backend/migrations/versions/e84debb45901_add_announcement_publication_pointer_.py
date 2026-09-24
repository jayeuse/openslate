"""add announcement publication pointer and idempotency

Revision ID: e84debb45901
Revises: 2398f489358b
Create Date: 2026-09-23 22:43:17.583326
"""

import hashlib
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, UUID, uuid5

import sqlalchemy as sa
from alembic import op

revision: str = "e84debb45901"
down_revision: str | None = "2398f489358b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _legacy_fingerprint(row: sa.Row[tuple[object, ...]]) -> str:
    """Match the published-content hash without depending on mutable application code."""
    values = row._mapping
    expires_at = values["expires_at"]
    content = {
        "author_id": str(values["author_id"]),
        "title": values["title"],
        "body": values["body"],
        "audience_kind": values["audience_kind"],
        "audience_role_id": str(values["audience_role_id"])
        if values["audience_role_id"]
        else None,
        "audience_user_id": str(values["audience_user_id"])
        if values["audience_user_id"]
        else None,
        "audience_department_id": str(values["audience_department_id"])
        if values["audience_department_id"]
        else None,
        "expires_at": expires_at.astimezone(UTC).isoformat()
        if isinstance(expires_at, datetime)
        else None,
    }
    encoded = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def upgrade() -> None:
    # Generated column and uniqueness operations, ordered around the legacy-row backfill.
    op.add_column(
        "board_announcement_revisions", sa.Column("publication_key", sa.Uuid(), nullable=True)
    )
    op.add_column(
        "board_announcement_revisions",
        sa.Column("content_fingerprint", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "board_announcements",
        sa.Column("displayed_publication_number", sa.Integer(), nullable=True),
    )

    bind = op.get_bind()
    # The previous revision rejects all revision UPDATEs. Temporarily remove the
    # trigger inside this migration transaction to backfill the two new columns.
    op.execute(
        "DROP TRIGGER trg_board_announcement_revisions_immutable "
        "ON board_announcement_revisions"
    )
    legacy_rows = bind.execute(
        sa.text(
            "SELECT id, author_id, title, body, audience_kind, audience_role_id, "
            "audience_user_id, audience_department_id, expires_at "
            "FROM board_announcement_revisions ORDER BY id"
        )
    ).all()
    for row in legacy_rows:
        legacy_id = row._mapping["id"]
        assert isinstance(legacy_id, UUID)
        bind.execute(
            sa.text(
                "UPDATE board_announcement_revisions "
                "SET publication_key = :publication_key, "
                "content_fingerprint = :content_fingerprint WHERE id = :id"
            ),
            {
                "id": legacy_id,
                "publication_key": uuid5(NAMESPACE_URL, f"openslate:announcement:{legacy_id}"),
                "content_fingerprint": _legacy_fingerprint(row),
            },
        )
    op.execute(
        "CREATE TRIGGER trg_board_announcement_revisions_immutable "
        "BEFORE UPDATE ON board_announcement_revisions "
        "FOR EACH ROW EXECUTE FUNCTION reject_board_announcement_revision_update()"
    )
    # Archived/draft content is not displayed. A scheduled replacement retains
    # the previously published revision until its next publication succeeds.
    op.execute(
        "UPDATE board_announcements AS a SET displayed_publication_number = "
        "(SELECT max(r.publication_number) FROM board_announcement_revisions AS r "
        "WHERE r.announcement_id = a.id AND NOT r.is_deleted) "
        "WHERE a.status IN ('published', 'scheduled') AND NOT a.is_deleted"
    )
    op.alter_column("board_announcement_revisions", "publication_key", nullable=False)
    op.alter_column("board_announcement_revisions", "content_fingerprint", nullable=False)
    op.create_unique_constraint(
        "uq_board_announcement_revisions_publication_key",
        "board_announcement_revisions",
        ["announcement_id", "publication_key"],
    )
    op.create_check_constraint(
        "ck_board_announcement_revisions_fingerprint_hex",
        "board_announcement_revisions",
        "content_fingerprint ~ '^[0-9a-f]{64}$'",
    )
    op.create_check_constraint(
        "ck_board_announcements_displayed_publication_positive",
        "board_announcements",
        "displayed_publication_number IS NULL OR displayed_publication_number > 0",
    )


def downgrade() -> None:
    # Downgrade discards the display pointer and idempotency metadata, not the
    # retained published-content rows. Re-upgrade assigns new legacy keys.
    op.drop_constraint(
        "ck_board_announcements_displayed_publication_positive",
        "board_announcements",
        type_="check",
    )
    op.drop_constraint(
        "ck_board_announcement_revisions_fingerprint_hex",
        "board_announcement_revisions",
        type_="check",
    )
    op.drop_constraint(
        "uq_board_announcement_revisions_publication_key",
        "board_announcement_revisions",
        type_="unique",
    )
    op.drop_column("board_announcements", "displayed_publication_number")
    op.drop_column("board_announcement_revisions", "content_fingerprint")
    op.drop_column("board_announcement_revisions", "publication_key")
