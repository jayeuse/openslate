"""Track explicit acceptance of module schemas."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "20260819_0012"
down_revision = "20260819_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "modules",
        sa.Column(
            "is_schema_accepted",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("modules", "is_schema_accepted")
