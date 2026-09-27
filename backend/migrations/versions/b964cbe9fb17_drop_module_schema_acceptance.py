"""drop module schema acceptance

Revision ID: b964cbe9fb17
Revises: c4ec36fc30cc
Create Date: 2026-09-27 23:42:33.693684
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b964cbe9fb17"
down_revision: str | None = "c4ec36fc30cc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("modules", "is_schema_accepted")


def downgrade() -> None:
    op.add_column(
        "modules",
        sa.Column(
            "is_schema_accepted",
            sa.BOOLEAN(),
            server_default=sa.text("false"),
            autoincrement=False,
            nullable=False,
        ),
    )
    # The previous revision accepted a module schema on every publish, so active
    # modules return accepted and keep accepting records after a downgrade.
    op.execute("UPDATE modules SET is_schema_accepted = true WHERE is_deleted = false")
