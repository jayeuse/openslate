"""Align the audit entity type length after the audit table reshape."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260819_0007"
down_revision: str | None = "20260819_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "audit_logs",
        "entity_type",
        type_=sa.String(length=50),
        existing_type=sa.String(length=255),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "audit_logs",
        "entity_type",
        type_=sa.String(length=255),
        existing_type=sa.String(length=50),
        existing_nullable=False,
    )
