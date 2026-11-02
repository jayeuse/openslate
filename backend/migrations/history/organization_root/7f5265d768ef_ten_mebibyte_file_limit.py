"""ten mebibyte file limit

Revision ID: 7f5265d768ef
Revises: a5e2874a7dcc
Create Date: 2026-10-17 00:13:55.733024

Uploads are limited to 10 MiB (D18), in validation, the transfer middleware, the
Storage bucket, and these constraints. No real data exists, so existing rows are
checked against the new limit.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "7f5265d768ef"
down_revision: str | None = "a5e2874a7dcc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _limit(size: int) -> None:
    op.drop_constraint("ck_files_expected_size", "files", type_="check")
    op.drop_constraint("ck_files_actual_size", "files", type_="check")
    op.create_check_constraint(
        "ck_files_expected_size", "files", f"expected_size > 0 AND expected_size <= {size}"
    )
    op.create_check_constraint(
        "ck_files_actual_size", "files",
        f"actual_size IS NULL OR (actual_size > 0 AND actual_size <= {size})",
    )


def upgrade() -> None:
    _limit(10 * 1024 * 1024)


def downgrade() -> None:
    _limit(25 * 1024 * 1024)
