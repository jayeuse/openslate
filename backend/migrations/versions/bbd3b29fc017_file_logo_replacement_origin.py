"""file_logo_replacement_origin

Revision ID: bbd3b29fc017
Revises: 37e161cacb06
Create Date: 2026-10-06 23:29:11.395956
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "bbd3b29fc017"
down_revision: str | None = "37e161cacb06"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("files", sa.Column("deletion_origin", sa.String(length=30), nullable=True))
    op.create_check_constraint(
        "ck_files_deletion_origin",
        "files",
        "deletion_origin IS NULL OR (deletion_origin = 'logo_replacement' "
        "AND purpose = 'workspace_logo' AND is_deleted = true "
        "AND state = 'deleting' AND operation_id IS NOT NULL)",
    )


def downgrade() -> None:
    if op.get_bind().scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM files WHERE deletion_origin IS NOT NULL)")
    ):
        raise RuntimeError("Reconcile pending logo cleanup before downgrading")
    op.drop_constraint("ck_files_deletion_origin", "files", type_="check")
    op.drop_column("files", "deletion_origin")
