"""add board external content links

Revision ID: fbef83381635
Revises: 56e5accc6972
Create Date: 2026-09-23 23:52:34.365144
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "fbef83381635"
down_revision: str | None = "56e5accc6972"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table in (
        "board_announcement_revisions",
        "board_announcements",
        "board_events",
    ):
        op.add_column(
            table,
            sa.Column(
                "links",
                postgresql.JSONB(astext_type=sa.Text()),
                server_default=sa.text("'[]'::jsonb"),
                nullable=False,
            ),
        )
        # Alembic does not autogenerate CHECK constraints. Limit direct SQL too.
        op.create_check_constraint(
            f"ck_{table}_links_array_limit",
            table,
            "CASE WHEN jsonb_typeof(links) = 'array' "
            "THEN jsonb_array_length(links) <= 20 ELSE false END",
        )


def downgrade() -> None:
    tables = (
        "board_events",
        "board_announcements",
        "board_announcement_revisions",
    )
    bind = op.get_bind()
    for table in tables:
        # The reverse schema cannot represent nonempty links. Refuse silent loss.
        has_links = bind.scalar(
            sa.text(f"SELECT EXISTS (SELECT 1 FROM {table} WHERE links <> '[]'::jsonb)")
        )
        if has_links:
            raise RuntimeError(f"Cannot downgrade while {table} links are retained")
    for table in tables:
        op.drop_constraint(f"ck_{table}_links_array_limit", table, type_="check")
        op.drop_column(table, "links")
