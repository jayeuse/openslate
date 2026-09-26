"""index identity rate limit cleanup window

Revision ID: 38f146d6f952
Revises: a1a581d48771
Create Date: 2026-09-26 13:03:56.238810
"""
from collections.abc import Sequence

from alembic import op

revision: str = "38f146d6f952"
down_revision: str | None = "a1a581d48771"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        op.f("ix_identity_rate_limit_buckets_window_started_at"),
        "identity_rate_limit_buckets",
        ["window_started_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_identity_rate_limit_buckets_window_started_at"),
        table_name="identity_rate_limit_buckets",
    )
