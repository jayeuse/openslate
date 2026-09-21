"""remove sandbox placeholder data

Revision ID: a96c2f4e7d31
Revises: ebae60c97134
Create Date: 2026-09-21 00:00:00.000000
"""

import json
from collections.abc import Sequence
from hashlib import sha256

import sqlalchemy as sa
from alembic import op

revision: str = "a96c2f4e7d31"
down_revision: str | None = "ebae60c97134"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PLACEHOLDER_CONTENT_HASH = "131d71b467d26eccebbf6844e1d460d72a393195a88239d7bb77d2be5ddca98a"
_EMPTY_DOCUMENT: dict[str, object] = {
    "kind": "openslate-sandbox",
    "schemaVersion": 2,
    "design": {
        "departments": [],
        "modules": [],
        "relationships": [],
        "layout": {},
    },
    "automations": [],
    "scenarios": [],
}


def upgrade() -> None:
    encoded = json.dumps(
        _EMPTY_DOCUMENT, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    op.execute(
        sa.text(
            """
            DELETE FROM public.sandbox_versions
            WHERE content_hash = :placeholder_hash
              AND kind = 'release'
              AND label = 'Starting structure'
              AND document_id IN (
                  SELECT id
                  FROM public.sandbox_documents
                  WHERE content_hash = :placeholder_hash
              )
            """
        ).bindparams(placeholder_hash=_PLACEHOLDER_CONTENT_HASH)
    )
    op.execute(
        sa.text(
            """
            UPDATE public.sandbox_documents
            SET document = CAST(:document AS jsonb),
                content_hash = :content_hash,
                byte_count = :byte_count,
                revision = revision + 1,
                performed_by = NULL,
                updated_at = now()
            WHERE content_hash = :placeholder_hash
            """
        ).bindparams(
            placeholder_hash=_PLACEHOLDER_CONTENT_HASH,
            document=encoded.decode(),
            content_hash=sha256(encoded).hexdigest(),
            byte_count=len(encoded),
        )
    )


def downgrade() -> None:
    # Removed placeholder data is intentionally not recreated.
    pass
