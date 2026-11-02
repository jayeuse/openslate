"""board calendar sources

Revision ID: c3f8d2e6a1b7
Revises: b7e2c4a9d1f3
Create Date: 2026-10-26 22:00:00.000000

Record-date sources (BE8): one module and one of its date or datetime fields, owned
by a Board calendar or by one person in one organization. The table is
organization-scoped with the standard row policy. The downgrade drops the table
with its rows; only a backup restores them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3f8d2e6a1b7"
down_revision: str | None = "b7e2c4a9d1f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "board_calendar_sources"
SCOPE = "(SELECT nullif(current_setting('openslate.org_id', true), '')::uuid)"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("date_field_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
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
        sa.CheckConstraint(
            "num_nonnulls(board_id, user_id) = 1", name="ck_board_calendar_sources_one_owner"
        ),
        sa.CheckConstraint("position >= 0", name="ck_board_calendar_sources_position"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_board_calendar_sources_created_by_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_calendar_sources_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "date_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_board_calendar_sources_date_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_calendar_sources_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_calendar_sources_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_calendar_sources_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_board_calendar_sources_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_calendar_sources_pkey")),
        sa.UniqueConstraint(
            "org_id", "board_id", "date_field_id", name="uq_board_calendar_sources_board_field"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_board_calendar_sources_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "user_id", "date_field_id", name="uq_board_calendar_sources_user_field"
        ),
    )
    for column in ("board_id", "date_field_id", "module_id", "user_id"):
        op.create_index(f"ix_{TABLE}_{column}", TABLE, [column], unique=False)

    # Deliberate model-derived audit FK and row policy omitted by autogenerate.
    op.create_foreign_key(
        f"fk_{TABLE}_performed_by_users",
        TABLE,
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute(f"ALTER TABLE public.{TABLE} ENABLE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY organization_rows ON public.{TABLE} TO openslate_app "
        f"USING (org_id = {SCOPE}) WITH CHECK (org_id = {SCOPE})"
    )


def downgrade() -> None:
    # The row policy, indexes and FKs go with the table.
    op.drop_table(TABLE)
