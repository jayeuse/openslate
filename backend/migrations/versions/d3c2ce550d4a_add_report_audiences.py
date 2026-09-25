"""Add Report audience references without exposing shared reads.

The constant server default backfills all existing active and archived Reports
to private. Dropping these columns on downgrade discards any later audience
selection, while preserving existing recipe and run rows.

Revision ID: d3c2ce550d4a
Revises: 18958e485e0c
Create Date: 2026-09-23 21:36:18.488602
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3c2ce550d4a"
down_revision: str | None = "18958e485e0c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column(
            "audience_kind",
            sa.String(length=20),
            server_default=sa.text("'private'"),
            nullable=False,
        ),
    )
    op.add_column("reports", sa.Column("audience_role_id", sa.UUID(), nullable=True))
    op.add_column("reports", sa.Column("audience_user_id", sa.UUID(), nullable=True))
    op.create_check_constraint(
        "ck_reports_audience",
        "reports",
        "(audience_kind IN ('private', 'everyone') AND audience_role_id IS NULL "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'role' AND audience_role_id IS NOT NULL "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND audience_role_id IS NULL "
        "AND audience_user_id IS NOT NULL)",
    )
    op.create_index("ix_reports_audience_role_id", "reports", ["audience_role_id"])
    op.create_index("ix_reports_audience_user_id", "reports", ["audience_user_id"])
    op.create_foreign_key(
        op.f("fk_reports_audience_role_id_roles"),
        "reports",
        "roles",
        ["audience_role_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        op.f("fk_reports_audience_user_id_users"),
        "reports",
        "users",
        ["audience_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_reports_audience_user_id_users"), "reports", type_="foreignkey")
    op.drop_constraint(op.f("fk_reports_audience_role_id_roles"), "reports", type_="foreignkey")
    op.drop_index("ix_reports_audience_user_id", table_name="reports")
    op.drop_index("ix_reports_audience_role_id", table_name="reports")
    op.drop_constraint("ck_reports_audience", "reports", type_="check")
    op.drop_column("reports", "audience_user_id")
    op.drop_column("reports", "audience_role_id")
    op.drop_column("reports", "audience_kind")
