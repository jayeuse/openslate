"""report run csv sha256

The audited run keeps one hash of its CSV (decision D9), so a saved copy can be proved after
the run is trimmed. The heap is small and `csv_bytes` stays in TOAST, so the backfill and the
`SET NOT NULL` scan run in one step, inside the migration's 5 s lock limit.

Revision ID: cf8cb7605f48
Revises: 65bf3d1eb512
Create Date: 2026-11-07 09:45:17.483518
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "cf8cb7605f48"
down_revision: str | None = "65bf3d1eb512"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("report_runs", sa.Column("csv_sha256", sa.String(length=64), nullable=True))
    op.execute("UPDATE report_runs SET csv_sha256 = encode(sha256(csv_bytes), 'hex')")
    op.alter_column("report_runs", "csv_sha256", nullable=False)


def downgrade() -> None:
    op.drop_column("report_runs", "csv_sha256")
