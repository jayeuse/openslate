"""Constrain field types to the supported record-validation types."""

from collections.abc import Sequence

from alembic import op

revision: str = "20260819_0008"
down_revision: str | None = "20260819_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_check_constraint(
        "ck_fields_type",
        "fields",
        "type IN ('text', 'number', 'decimal', 'int', 'boolean', 'date', 'datetime', 'select')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_fields_type", "fields", type_="check")
