"""Add relationship field metadata and directed record edges."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260819_0011"
down_revision = "20260819_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "fields",
        sa.Column(
            "relationship_target_module_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.add_column(
        "fields",
        sa.Column("relationship_multiple_targets", sa.Boolean(), nullable=True),
    )
    op.add_column(
        "fields",
        sa.Column("relationship_multiple_sources", sa.Boolean(), nullable=True),
    )
    op.create_foreign_key(
        "fk_fields_relationship_target_module_id_modules",
        "fields",
        "modules",
        ["relationship_target_module_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_fields_relationship_target_module_id",
        "fields",
        ["relationship_target_module_id"],
    )
    op.drop_constraint("ck_fields_type", "fields", type_="check")
    op.create_check_constraint(
        "ck_fields_type",
        "fields",
        "type IN ('text', 'number', 'decimal', 'int', 'boolean', 'date', 'datetime', "
        "'select', 'relationship')",
    )
    op.create_check_constraint(
        "ck_fields_relationship_metadata",
        "fields",
        "(type = 'relationship' AND relationship_target_module_id IS NOT NULL "
        "AND relationship_multiple_targets IS NOT NULL "
        "AND relationship_multiple_sources IS NOT NULL AND required = false "
        "AND config = '{}'::jsonb) OR (type <> 'relationship' "
        "AND relationship_target_module_id IS NULL "
        "AND relationship_multiple_targets IS NULL "
        "AND relationship_multiple_sources IS NULL)",
    )

    op.create_table(
        "relationship_edges",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "is_deleted",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "performed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "field_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("fields.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "source_record_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("records.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "target_record_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("records.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source_record_id <> target_record_id",
            name="ck_relationship_edges_distinct_records",
        ),
    )
    op.create_index(
        "uq_relationship_edges_active",
        "relationship_edges",
        ["field_id", "source_record_id", "target_record_id"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "ix_relationship_edges_active_source",
        "relationship_edges",
        ["field_id", "source_record_id"],
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "ix_relationship_edges_active_target",
        "relationship_edges",
        ["field_id", "target_record_id"],
        postgresql_where=sa.text("is_deleted = false"),
    )

    op.execute(
        sa.text(
            """
             REVOKE ALL PRIVILEGES ON TABLE public.relationship_edges
                FROM PUBLIC, anon, authenticated, service_role;
            GRANT SELECT, INSERT, UPDATE ON TABLE public.relationship_edges
                TO openslate_app;
            ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS openslate_app_relationship_edges_select
                ON public.relationship_edges;
            CREATE POLICY openslate_app_relationship_edges_select
                ON public.relationship_edges AS PERMISSIVE FOR SELECT
                TO openslate_app USING (true);
            DROP POLICY IF EXISTS openslate_app_relationship_edges_insert
                ON public.relationship_edges;
            CREATE POLICY openslate_app_relationship_edges_insert
                ON public.relationship_edges AS PERMISSIVE FOR INSERT
                TO openslate_app WITH CHECK (true);
            DROP POLICY IF EXISTS openslate_app_relationship_edges_update
                ON public.relationship_edges;
            CREATE POLICY openslate_app_relationship_edges_update
                ON public.relationship_edges AS PERMISSIVE FOR UPDATE
                TO openslate_app USING (true) WITH CHECK (true);
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DROP POLICY IF EXISTS openslate_app_relationship_edges_select
                ON public.relationship_edges;
            DROP POLICY IF EXISTS openslate_app_relationship_edges_insert
                ON public.relationship_edges;
            DROP POLICY IF EXISTS openslate_app_relationship_edges_update
                ON public.relationship_edges;
            REVOKE ALL PRIVILEGES ON TABLE public.relationship_edges
                FROM PUBLIC, anon, authenticated, service_role, openslate_app;
            """
        )
    )
    op.drop_index("ix_relationship_edges_active_target", table_name="relationship_edges")
    op.drop_index("ix_relationship_edges_active_source", table_name="relationship_edges")
    op.drop_index("uq_relationship_edges_active", table_name="relationship_edges")
    op.drop_table("relationship_edges")
    op.drop_index("ix_fields_relationship_target_module_id", table_name="fields")
    op.drop_constraint("ck_fields_relationship_metadata", "fields", type_="check")
    op.drop_constraint("ck_fields_type", "fields", type_="check")
    op.create_check_constraint(
        "ck_fields_type",
        "fields",
        "type IN ('text', 'number', 'decimal', 'int', 'boolean', 'date', 'datetime', 'select')",
    )
    op.drop_constraint(
        "fk_fields_relationship_target_module_id_modules",
        "fields",
        type_="foreignkey",
    )
    op.drop_column("fields", "relationship_multiple_sources")
    op.drop_column("fields", "relationship_multiple_targets")
    op.drop_column("fields", "relationship_target_module_id")
