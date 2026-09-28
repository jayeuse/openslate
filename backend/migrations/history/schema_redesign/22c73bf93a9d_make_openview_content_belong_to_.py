"""make openview content belong to departments

Revision ID: 22c73bf93a9d
Revises: 3515de19214f
Create Date: 2026-09-28 07:20:05.749060

Dashboards belong to a department and get a position; saved views and Reports
lose their owner and audience, and a saved view can be its module's default.
The personal tables ``dashboard_defaults``, ``saved_view_defaults`` and
``openview_chart_preferences`` are dropped.

Existing Dashboards have no department, and existing views and Reports cannot be
mapped back to an owner, so the revision refuses to run in either direction
while any Dashboard, saved view or Report exists; reset the development
application data first. The downgrade recreates the dropped tables empty.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "22c73bf93a9d"
down_revision: str | None = "3515de19214f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


GUARDED_TABLES = ("dashboards", "saved_views", "reports")

SAVED_VIEW_CHECKS = (
    ("ck_saved_views_visibility", "visibility IN ('private', 'workspace')"),
    ("ck_saved_views_audience_kind", "audience_kind IN ('private', 'everyone', 'user')"),
    (
        "ck_saved_views_audience_reference",
        "(audience_kind = 'private' AND visibility = 'private' "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'everyone' AND visibility = 'workspace' "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND visibility = 'workspace' "
        "AND audience_user_id IS NOT NULL)",
    ),
)
REPORT_AUDIENCE_CHECK = (
    "(audience_kind IN ('private', 'everyone') AND audience_user_id IS NULL) OR "
    "(audience_kind = 'user' AND audience_user_id IS NOT NULL)"
)


def _refuse_existing_content() -> None:
    """Refuse to convert rows that cannot be mapped to a department or an owner."""

    checks = " OR ".join(f"EXISTS (SELECT 1 FROM public.{table})" for table in GUARDED_TABLES)
    op.execute(
        f"""
        DO $guard$
        BEGIN
            IF {checks} THEN
                RAISE EXCEPTION 'OpenView has Dashboards, saved views or Reports that '
                                'cannot be moved to the new ownership model.'
                    USING HINT = 'Reset the development application data, then run the '
                                 'migration again. Existing OpenView content is not converted.',
                          ERRCODE = 'object_not_in_prerequisite_state';
            END IF;
        END
        $guard$;
        """
    )


def upgrade() -> None:
    _refuse_existing_content()
    op.drop_index(op.f("ix_saved_view_defaults_user_id"), table_name="saved_view_defaults")
    op.drop_index(op.f("ix_saved_view_defaults_view_module"), table_name="saved_view_defaults")
    op.drop_table("saved_view_defaults")
    op.drop_table("openview_chart_preferences")
    op.drop_index(op.f("ix_dashboard_defaults_dashboard_id"), table_name="dashboard_defaults")
    op.drop_table("dashboard_defaults")
    op.add_column("dashboards", sa.Column("department_id", sa.UUID(), nullable=False))
    op.add_column(
        "dashboards",
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.drop_index(op.f("ix_dashboards_owner_id"), table_name="dashboards")
    op.drop_constraint(op.f("uq_dashboards_id_owner"), "dashboards", type_="unique")
    op.create_index(
        "ix_dashboards_department_position",
        "dashboards",
        ["department_id", "position"],
        unique=False,
    )
    op.drop_constraint(op.f("fk_dashboards_owner_id_users"), "dashboards", type_="foreignkey")
    op.create_foreign_key(
        op.f("fk_dashboards_department_id_departments"),
        "dashboards",
        "departments",
        ["department_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.drop_column("dashboards", "owner_id")
    op.create_check_constraint("ck_dashboards_position_nonnegative", "dashboards", "position >= 0")
    op.drop_index(op.f("ix_reports_audience_user_id"), table_name="reports")
    op.drop_index(op.f("ix_reports_owner_module"), table_name="reports")
    op.drop_constraint(op.f("fk_reports_owner_id_users"), "reports", type_="foreignkey")
    op.drop_constraint(op.f("fk_reports_audience_user_id_users"), "reports", type_="foreignkey")
    op.drop_constraint("ck_reports_audience", "reports", type_="check")
    op.drop_column("reports", "owner_id")
    op.drop_column("reports", "audience_user_id")
    op.drop_column("reports", "audience_kind")
    op.add_column(
        "saved_views",
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.drop_index(
        op.f("ix_saved_views_everyone_module_active"),
        table_name="saved_views",
        postgresql_where="(((audience_kind)::text = 'everyone'::text) AND (is_deleted = false))",
    )
    op.drop_index(op.f("ix_saved_views_owner_module"), table_name="saved_views")
    op.drop_index(
        op.f("ix_saved_views_user_module_active"),
        table_name="saved_views",
        postgresql_where="(((audience_kind)::text = 'user'::text) AND (is_deleted = false))",
    )
    op.create_index(
        "uq_saved_views_module_default",
        "saved_views",
        ["module_id"],
        unique=True,
        postgresql_where=sa.text("is_default AND NOT is_deleted"),
    )
    op.drop_constraint(
        op.f("fk_saved_views_audience_user_id_users"), "saved_views", type_="foreignkey"
    )
    op.drop_constraint(op.f("fk_saved_views_owner_id_users"), "saved_views", type_="foreignkey")
    for name, _ in SAVED_VIEW_CHECKS:
        op.drop_constraint(name, "saved_views", type_="check")
    op.drop_column("saved_views", "owner_id")
    op.drop_column("saved_views", "audience_user_id")
    op.drop_column("saved_views", "audience_kind")
    op.drop_column("saved_views", "visibility")


def downgrade() -> None:
    _refuse_existing_content()
    op.add_column(
        "saved_views",
        sa.Column("visibility", sa.VARCHAR(length=20), autoincrement=False, nullable=False),
    )
    op.add_column(
        "saved_views",
        sa.Column(
            "audience_kind",
            sa.VARCHAR(length=20),
            server_default=sa.text("'private'::character varying"),
            autoincrement=False,
            nullable=False,
        ),
    )
    op.add_column(
        "saved_views", sa.Column("audience_user_id", sa.UUID(), autoincrement=False, nullable=True)
    )
    op.add_column(
        "saved_views", sa.Column("owner_id", sa.UUID(), autoincrement=False, nullable=False)
    )
    op.create_foreign_key(
        op.f("fk_saved_views_owner_id_users"),
        "saved_views",
        "users",
        ["owner_id"],
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
    op.drop_index(
        "uq_saved_views_module_default",
        table_name="saved_views",
        postgresql_where=sa.text("is_default AND NOT is_deleted"),
    )
    op.create_index(
        op.f("ix_saved_views_user_module_active"),
        "saved_views",
        ["audience_user_id", "module_id"],
        unique=False,
        postgresql_where="(((audience_kind)::text = 'user'::text) AND (is_deleted = false))",
    )
    op.create_index(
        op.f("ix_saved_views_owner_module"), "saved_views", ["owner_id", "module_id"], unique=False
    )
    op.create_index(
        op.f("ix_saved_views_everyone_module_active"),
        "saved_views",
        ["module_id"],
        unique=False,
        postgresql_where="(((audience_kind)::text = 'everyone'::text) AND (is_deleted = false))",
    )
    op.drop_column("saved_views", "is_default")
    for name, condition in SAVED_VIEW_CHECKS:
        op.create_check_constraint(name, "saved_views", condition)
    op.add_column(
        "reports",
        sa.Column(
            "audience_kind",
            sa.VARCHAR(length=20),
            server_default=sa.text("'private'::character varying"),
            autoincrement=False,
            nullable=False,
        ),
    )
    op.add_column(
        "reports", sa.Column("audience_user_id", sa.UUID(), autoincrement=False, nullable=True)
    )
    op.add_column("reports", sa.Column("owner_id", sa.UUID(), autoincrement=False, nullable=False))
    op.create_foreign_key(
        op.f("fk_reports_audience_user_id_users"),
        "reports",
        "users",
        ["audience_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        op.f("fk_reports_owner_id_users"),
        "reports",
        "users",
        ["owner_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        op.f("ix_reports_owner_module"), "reports", ["owner_id", "module_id"], unique=False
    )
    op.create_index(
        op.f("ix_reports_audience_user_id"), "reports", ["audience_user_id"], unique=False
    )
    op.create_check_constraint("ck_reports_audience", "reports", REPORT_AUDIENCE_CHECK)
    op.drop_constraint("ck_dashboards_position_nonnegative", "dashboards", type_="check")
    op.add_column(
        "dashboards", sa.Column("owner_id", sa.UUID(), autoincrement=False, nullable=False)
    )
    op.drop_constraint(
        op.f("fk_dashboards_department_id_departments"), "dashboards", type_="foreignkey"
    )
    op.create_foreign_key(
        op.f("fk_dashboards_owner_id_users"),
        "dashboards",
        "users",
        ["owner_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.drop_index("ix_dashboards_department_position", table_name="dashboards")
    op.create_unique_constraint(
        op.f("uq_dashboards_id_owner"),
        "dashboards",
        ["id", "owner_id"],
        postgresql_nulls_not_distinct=False,
    )
    op.create_index(op.f("ix_dashboards_owner_id"), "dashboards", ["owner_id"], unique=False)
    op.drop_column("dashboards", "position")
    op.drop_column("dashboards", "department_id")
    op.create_table(
        "dashboard_defaults",
        sa.Column("user_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("dashboard_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "deleted_at", postgresql.TIMESTAMP(timezone=True), autoincrement=False, nullable=True
        ),
        sa.Column(
            "is_deleted",
            sa.BOOLEAN(),
            server_default=sa.text("false"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), autoincrement=False, nullable=True),
        sa.ForeignKeyConstraint(
            ["dashboard_id", "user_id"],
            ["dashboards.id", "dashboards.owner_id"],
            name=op.f("fk_dashboard_defaults_dashboard_owner"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_dashboard_defaults_performed_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_dashboard_defaults_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("dashboard_defaults_pkey")),
        sa.UniqueConstraint(
            "user_id",
            name=op.f("uq_dashboard_defaults_user_id"),
            postgresql_include=[],
            postgresql_nulls_not_distinct=False,
        ),
    )
    op.create_index(
        op.f("ix_dashboard_defaults_dashboard_id"),
        "dashboard_defaults",
        ["dashboard_id"],
        unique=False,
    )
    op.create_table(
        "openview_chart_preferences",
        sa.Column("user_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column(
            "config", postgresql.JSONB(astext_type=sa.Text()), autoincrement=False, nullable=False
        ),
        sa.Column("id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "deleted_at", postgresql.TIMESTAMP(timezone=True), autoincrement=False, nullable=True
        ),
        sa.Column(
            "is_deleted",
            sa.BOOLEAN(),
            server_default=sa.text("false"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), autoincrement=False, nullable=True),
        sa.CheckConstraint(
            "jsonb_typeof(config) = 'object'::text AND (config ->> 'version'::text) = '1'::text",
            name=op.f("ck_openview_chart_preferences_config_version"),
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_openview_chart_preferences_performed_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_openview_chart_preferences_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("openview_chart_preferences_pkey")),
        sa.UniqueConstraint(
            "user_id",
            name=op.f("uq_openview_chart_preferences_user_id"),
            postgresql_include=[],
            postgresql_nulls_not_distinct=False,
        ),
    )
    op.create_table(
        "saved_view_defaults",
        sa.Column("user_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("module_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("view_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "deleted_at", postgresql.TIMESTAMP(timezone=True), autoincrement=False, nullable=True
        ),
        sa.Column(
            "is_deleted",
            sa.BOOLEAN(),
            server_default=sa.text("false"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), autoincrement=False, nullable=True),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_saved_view_defaults_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_saved_view_defaults_performed_by_users"),
            ondelete="SET NULL",
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
            name=op.f("fk_saved_view_defaults_view_module"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("saved_view_defaults_pkey")),
        sa.UniqueConstraint(
            "user_id",
            "module_id",
            name=op.f("uq_saved_view_defaults_user_module"),
            postgresql_include=[],
            postgresql_nulls_not_distinct=False,
        ),
    )
    op.create_index(
        op.f("ix_saved_view_defaults_view_module"),
        "saved_view_defaults",
        ["view_id", "module_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_saved_view_defaults_user_id"), "saved_view_defaults", ["user_id"], unique=False
    )
