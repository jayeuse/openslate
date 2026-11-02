"""remove board widgets

Revision ID: 4e015d0fb2ab
Revises: a6c970033eaa
Create Date: 2026-10-26 18:28:10.689122

Boards no longer hold widgets; department dashboards own counts and charts. The
upgrade deletes every board widget row with its table; the organization row policy
goes with the table. The downgrade recreates an empty table with the prior shape
and policy. It does not restore the deleted rows: only a backup can.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "4e015d0fb2ab"
down_revision: str | None = "a6c970033eaa"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCOPE = "(SELECT nullif(current_setting('openslate.org_id', true), '')::uuid)"


def upgrade() -> None:
    op.drop_index("ix_board_widgets_chart_id", table_name="board_widgets")
    op.drop_index("ix_board_widgets_module_id", table_name="board_widgets")
    op.drop_table("board_widgets")


def downgrade() -> None:
    op.create_table(
        "board_widgets",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("widget_type", sa.String(length=20), nullable=False),
        sa.Column("size", sa.String(length=1), server_default=sa.text("'M'"), nullable=False),
        sa.Column("pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("chart_id", sa.Uuid(), nullable=True),
        sa.Column(
            "config", postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True
        ),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.CheckConstraint("size IN ('S', 'M', 'L')", name="ck_board_widgets_size"),
        sa.CheckConstraint(
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_board_widgets_type",
        ),
        sa.CheckConstraint(
            "(config IS NOT NULL) <> (chart_id IS NOT NULL)", name="ck_board_widgets_query_source"
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_board_widgets_name_nonempty"),
        sa.CheckConstraint("position >= 0 AND position < 12", name="ck_board_widgets_position"),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_widgets_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "chart_id"],
            ["charts.org_id", "charts.id"],
            name="fk_board_widgets_chart_id_charts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_widgets_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_widgets_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_widgets_performed_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_widgets_pkey")),
        sa.UniqueConstraint(
            "board_id",
            "position",
            deferrable=True,
            initially="DEFERRED",
            name="uq_board_widgets_board_position",
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_board_widgets_org_id_id"),
    )
    op.create_index("ix_board_widgets_chart_id", "board_widgets", ["chart_id"], unique=False)
    op.create_index("ix_board_widgets_module_id", "board_widgets", ["module_id"], unique=False)
    op.execute("ALTER TABLE public.board_widgets ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY organization_rows ON public.board_widgets TO openslate_app "
        f"USING (org_id = {SCOPE}) WITH CHECK (org_id = {SCOPE})"
    )
