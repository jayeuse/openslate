"""Add saved-view audiences, presentation metadata, and per-user defaults.

Existing workspace-visible views become everyone-visible; private views remain
private. Downgrade narrows role/user audiences to private before removing the
audience columns and discards presentation/default selections.

Revision ID: 20c062857e0d
Revises: d1a731600968
Create Date: 2026-09-23 03:38:17.370269
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20c062857e0d"
down_revision: str | None = "d1a731600968"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "saved_views",
        sa.Column(
            "audience_kind",
            sa.String(length=20),
            server_default=sa.text("'private'"),
            nullable=False,
        ),
    )
    op.add_column("saved_views", sa.Column("audience_role_id", sa.UUID(), nullable=True))
    op.add_column("saved_views", sa.Column("audience_user_id", sa.UUID(), nullable=True))
    op.add_column(
        "saved_views",
        sa.Column(
            "presentation",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{\"version\": 1}'::jsonb"),
            nullable=False,
        ),
    )
    op.execute("UPDATE saved_views SET audience_kind = 'everyone' WHERE visibility = 'workspace'")
    op.create_check_constraint(
        "ck_saved_views_audience_kind",
        "saved_views",
        "audience_kind IN ('private', 'everyone', 'role', 'user')",
    )
    op.create_check_constraint(
        "ck_saved_views_audience_reference",
        "saved_views",
        "(audience_kind = 'private' AND visibility = 'private' "
        "AND audience_role_id IS NULL AND audience_user_id IS NULL) OR "
        "(audience_kind = 'everyone' AND visibility = 'workspace' "
        "AND audience_role_id IS NULL AND audience_user_id IS NULL) OR "
        "(audience_kind = 'role' AND visibility = 'workspace' "
        "AND audience_role_id IS NOT NULL AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND visibility = 'workspace' "
        "AND audience_role_id IS NULL AND audience_user_id IS NOT NULL)",
    )
    op.create_unique_constraint("uq_saved_views_id_module", "saved_views", ["id", "module_id"])
    op.create_table(
        "saved_view_defaults",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("view_id", sa.Uuid(), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_saved_view_defaults_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_saved_view_defaults_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["view_id", "module_id"],
            ["saved_views.id", "saved_views.module_id"],
            name="fk_saved_view_defaults_view_module",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("saved_view_defaults_pkey")),
        sa.UniqueConstraint("user_id", "module_id", name="uq_saved_view_defaults_user_module"),
    )
    op.create_foreign_key(
        op.f("fk_saved_view_defaults_performed_by_users"),
        "saved_view_defaults",
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_saved_view_defaults_user_id"), "saved_view_defaults", ["user_id"], unique=False
    )
    op.create_index(
        "ix_saved_view_defaults_view_module",
        "saved_view_defaults",
        ["view_id", "module_id"],
        unique=False,
    )
    op.drop_index(
        op.f("ix_saved_views_shared_module"),
        table_name="saved_views",
        postgresql_where="((visibility)::text = 'workspace'::text)",
    )
    op.create_index(
        "ix_saved_views_everyone_module_active",
        "saved_views",
        ["module_id"],
        unique=False,
        postgresql_where=sa.text("audience_kind = 'everyone' AND is_deleted = false"),
    )
    op.create_index(
        "ix_saved_views_role_module_active",
        "saved_views",
        ["audience_role_id", "module_id"],
        unique=False,
        postgresql_where=sa.text("audience_kind = 'role' AND is_deleted = false"),
    )
    op.create_index(
        "ix_saved_views_user_module_active",
        "saved_views",
        ["audience_user_id", "module_id"],
        unique=False,
        postgresql_where=sa.text("audience_kind = 'user' AND is_deleted = false"),
    )
    op.create_foreign_key(
        op.f("fk_saved_views_audience_role_id_roles"),
        "saved_views",
        "roles",
        ["audience_role_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        op.f("fk_saved_views_audience_user_id_users"),
        "saved_views",
        "users",
        ["audience_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    op.execute(
        "UPDATE saved_views SET audience_kind = 'private', visibility = 'private', "
        "audience_role_id = NULL, audience_user_id = NULL "
        "WHERE audience_kind IN ('role', 'user')"
    )
    op.drop_index("ix_saved_view_defaults_view_module", table_name="saved_view_defaults")
    op.drop_index(op.f("ix_saved_view_defaults_user_id"), table_name="saved_view_defaults")
    op.drop_table("saved_view_defaults")
    op.drop_constraint(
        op.f("fk_saved_views_audience_user_id_users"), "saved_views", type_="foreignkey"
    )
    op.drop_constraint(
        op.f("fk_saved_views_audience_role_id_roles"), "saved_views", type_="foreignkey"
    )
    op.drop_constraint("ck_saved_views_audience_reference", "saved_views", type_="check")
    op.drop_constraint("ck_saved_views_audience_kind", "saved_views", type_="check")
    op.drop_constraint("uq_saved_views_id_module", "saved_views", type_="unique")
    op.drop_index(
        "ix_saved_views_user_module_active",
        table_name="saved_views",
        postgresql_where=sa.text("audience_kind = 'user' AND is_deleted = false"),
    )
    op.drop_index(
        "ix_saved_views_role_module_active",
        table_name="saved_views",
        postgresql_where=sa.text("audience_kind = 'role' AND is_deleted = false"),
    )
    op.drop_index(
        "ix_saved_views_everyone_module_active",
        table_name="saved_views",
        postgresql_where=sa.text("audience_kind = 'everyone' AND is_deleted = false"),
    )
    op.create_index(
        op.f("ix_saved_views_shared_module"),
        "saved_views",
        ["module_id"],
        unique=False,
        postgresql_where="((visibility)::text = 'workspace'::text)",
    )
    op.drop_column("saved_views", "presentation")
    op.drop_column("saved_views", "audience_user_id")
    op.drop_column("saved_views", "audience_role_id")
    op.drop_column("saved_views", "audience_kind")
