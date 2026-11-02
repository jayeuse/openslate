"""one pending invitation per person

Revision ID: ed8c9f6d4526
Revises: 071607de0f40
Create Date: 2026-10-17 13:44:13.129285
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ed8c9f6d4526"
down_revision: str | None = "071607de0f40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "uq_memberships_user_pending", "memberships", ["user_id"], unique=True,
        postgresql_where=sa.text("status = 'pending' AND is_deleted = false"),
    )


def downgrade() -> None:
    op.drop_index("uq_memberships_user_pending", table_name="memberships")
