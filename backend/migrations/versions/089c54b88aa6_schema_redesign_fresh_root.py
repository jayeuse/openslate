"""schema redesign fresh root

Revision ID: 089c54b88aa6
Revises:
Create Date: 2026-09-28 16:35:13.849577
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

revision: str = "089c54b88aa6"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


USE_ALTER_FOREIGN_KEYS = (
    (
        "fk_audit_logs_performed_by_users",
        "audit_logs",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_attachments_performed_by_users",
        "board_attachments",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_event_reminders_performed_by_users",
        "board_event_reminders",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_events_performed_by_users",
        "board_events",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_groups_performed_by_users",
        "board_groups",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_post_revision_attachments_performed_by_users",
        "board_post_revision_attachments",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_post_revision_record_links_performed_by_users",
        "board_post_revision_record_links",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_post_revisions_performed_by_users",
        "board_post_revisions",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_posts_performed_by_users",
        "board_posts",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_record_links_performed_by_users",
        "board_record_links",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_board_widgets_performed_by_users",
        "board_widgets",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    ("fk_boards_performed_by_users", "boards", "users", ("performed_by",), ("id",), "SET NULL"),
    (
        "fk_dashboard_widgets_performed_by_users",
        "dashboard_widgets",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_dashboards_performed_by_users",
        "dashboards",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_departments_performed_by_users",
        "departments",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    ("fk_fields_performed_by_users", "fields", "users", ("performed_by",), ("id",), "SET NULL"),
    ("fk_files_performed_by_users", "files", "users", ("performed_by",), ("id",), "SET NULL"),
    (
        "fk_group_access_performed_by_users",
        "group_access",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_group_members_performed_by_users",
        "group_members",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    ("fk_groups_performed_by_users", "groups", "users", ("performed_by",), ("id",), "SET NULL"),
    (
        "fk_in_app_notifications_performed_by_users",
        "in_app_notifications",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    ("fk_modules_performed_by_users", "modules", "users", ("performed_by",), ("id",), "SET NULL"),
    (
        "fk_modules_title_field_id_fields",
        "modules",
        "fields",
        ("title_field_id",),
        ("id",),
        "RESTRICT",
    ),
    (
        "fk_record_trigger_actions_performed_by_users",
        "record_trigger_actions",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_record_trigger_conditions_performed_by_users",
        "record_trigger_conditions",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_record_trigger_events_performed_by_users",
        "record_trigger_events",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_record_trigger_events_root_event_id_record_trigger_events",
        "record_trigger_events",
        "record_trigger_events",
        ("root_event_id",),
        ("id",),
        "RESTRICT",
    ),
    (
        "fk_record_trigger_runs_performed_by_users",
        "record_trigger_runs",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_record_triggers_performed_by_users",
        "record_triggers",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_record_triggers_publisher_id_users",
        "record_triggers",
        "users",
        ("publisher_id",),
        ("id",),
        "RESTRICT",
    ),
    ("fk_records_performed_by_users", "records", "users", ("performed_by",), ("id",), "SET NULL"),
    (
        "fk_relationship_edges_performed_by_users",
        "relationship_edges",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_report_run_rows_performed_by_users",
        "report_run_rows",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_report_runs_performed_by_users",
        "report_runs",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_report_schedules_performed_by_users",
        "report_schedules",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    ("fk_reports_performed_by_users", "reports", "users", ("performed_by",), ("id",), "SET NULL"),
    (
        "fk_sandbox_bindings_performed_by_users",
        "sandbox_bindings",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_sandbox_documents_performed_by_users",
        "sandbox_documents",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_sandbox_publications_actor_id_users",
        "sandbox_publications",
        "users",
        ("actor_id",),
        ("id",),
        "RESTRICT",
    ),
    (
        "fk_sandbox_publications_performed_by_users",
        "sandbox_publications",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_sandbox_test_runs_performed_by_users",
        "sandbox_test_runs",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_sandbox_versions_performed_by_users",
        "sandbox_versions",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    (
        "fk_sandbox_versions_source_version_id_sandbox_versions",
        "sandbox_versions",
        "sandbox_versions",
        ("source_version_id",),
        ("id",),
        "RESTRICT",
    ),
    (
        "fk_saved_views_performed_by_users",
        "saved_views",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
    ("fk_users_performed_by_users", "users", "users", ("performed_by",), ("id",), "SET NULL"),
    ("fk_users_sponsor_user_id_users", "users", "users", ("sponsor_user_id",), ("id",), "RESTRICT"),
    (
        "fk_workspace_profiles_logo_file_id_files",
        "workspace_profiles",
        "files",
        ("logo_file_id",),
        ("id",),
        "RESTRICT",
    ),
    (
        "fk_workspace_profiles_performed_by_users",
        "workspace_profiles",
        "users",
        ("performed_by",),
        ("id",),
        "SET NULL",
    ),
)


def upgrade() -> None:
    # Preserve the old fresh-application-schema admission guard from c4ec36fc30cc.
    op.execute(
        sa.text("""
        DO $fresh$
        BEGIN
            IF current_user <> 'openslate_owner' THEN
                RAISE EXCEPTION 'baseline requires openslate_owner';
            END IF;
            IF EXISTS (
                SELECT 1 FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relowner = current_user::regrole::oid
                  AND c.relkind IN ('r','p','v','m','f') AND c.relname <> 'alembic_version'
            ) THEN
                RAISE EXCEPTION 'baseline requires a fresh application schema';
            END IF;
        END $fresh$;
    """)
    )
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(length=50), nullable=False),
        sa.Column("entity_type", sa.String(length=50), nullable=False),
        sa.Column("entity_id", sa.UUID(), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("request_method", sa.String(length=10), nullable=True),
        sa.Column("request_path", sa.Text(), nullable=True),
        sa.Column("actor_label", sa.String(length=100), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("department_id", sa.UUID(), nullable=True),
        sa.CheckConstraint("action IN ('create', 'update', 'delete')", name="ck_audit_logs_action"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_audit_logs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("audit_logs_pkey")),
    )
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"], unique=False)
    op.create_index(
        "ix_audit_logs_actor", "audit_logs", ["performed_by", "created_at"], unique=False
    )
    op.create_index("ix_audit_logs_created_at_id", "audit_logs", ["created_at", "id"], unique=False)
    op.create_index(
        "ix_audit_logs_department_created_at_id",
        "audit_logs",
        ["department_id", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_audit_logs_entity",
        "audit_logs",
        ["entity_type", "entity_id", "created_at"],
        unique=False,
    )
    op.create_index("ix_audit_logs_request", "audit_logs", ["request_id"], unique=False)
    op.create_table(
        "departments",
        sa.Column("department_name", sa.String(length=150), nullable=False),
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
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_departments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("departments_pkey")),
    )
    op.create_index(
        "uq_departments_name_active",
        "departments",
        ["department_name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "groups",
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
        sa.CheckConstraint("btrim(name) <> ''", name="ck_groups_name_not_blank"),
        sa.CheckConstraint("revision > 0", name="ck_groups_revision_positive"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_groups_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("groups_pkey")),
    )
    op.create_index(
        "uq_groups_name_active_ci",
        "groups",
        [sa.literal_column("lower(name)")],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "identity_rate_limit_buckets",
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("blocked_until", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("fingerprint", name=op.f("identity_rate_limit_buckets_pkey")),
    )
    op.create_index(
        op.f("ix_identity_rate_limit_buckets_window_started_at"),
        "identity_rate_limit_buckets",
        ["window_started_at"],
        unique=False,
    )
    op.create_table(
        "sandbox_documents",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("schema_version", sa.Integer(), server_default=sa.text("4"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("document", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("byte_count", sa.Integer(), nullable=False),
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
        sa.CheckConstraint("byte_count >= 0", name="ck_sandbox_documents_byte_count_nonnegative"),
        sa.CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_sandbox_documents_not_deleted"
        ),
        sa.CheckConstraint("revision > 0", name="ck_sandbox_documents_revision_positive"),
        sa.CheckConstraint("schema_version = 4", name="ck_sandbox_documents_schema_version"),
        sa.CheckConstraint("singleton_key = true", name="ck_sandbox_documents_singleton_key"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_documents_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_documents_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_sandbox_documents_singleton_key"),
    )
    op.create_table(
        "security_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_type", sa.String(length=100), nullable=False),
        sa.Column("outcome", sa.String(length=20), nullable=False),
        sa.Column("source", sa.String(length=100), nullable=False),
        sa.Column("operation_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=True),
        sa.Column("subject_id", sa.UUID(), nullable=True),
        sa.Column(
            "labels",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("fingerprint", sa.String(length=128), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("request_method", sa.String(length=10), nullable=True),
        sa.Column("request_path", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "outcome IN ('attempt', 'success', 'denied', 'failure', 'partial')",
            name="ck_security_events_outcome",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("security_events_pkey")),
    )
    op.create_index(
        "ix_security_events_occurred_at_id", "security_events", ["occurred_at", "id"], unique=False
    )
    op.create_index(
        "ix_security_events_operation_id", "security_events", ["operation_id"], unique=False
    )
    op.create_table(
        "users",
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("supabase_user_id", sa.Uuid(), nullable=True),
        sa.Column("provider_invitation_operation_id", sa.Uuid(), nullable=True),
        sa.Column("username", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column("job_title", sa.String(length=200), nullable=True),
        sa.Column("sponsor_user_id", sa.UUID(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("invitation_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invitation_accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tokens_valid_after", sa.DateTime(timezone=True), nullable=True),
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
        sa.Column("role", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "(role = 'guest') = (sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL)",
            name="ck_users_guest",
        ),
        sa.CheckConstraint("role IN ('admin', 'member', 'guest')", name="ck_users_role"),
        sa.CheckConstraint("status IN ('pending', 'active', 'disabled')", name="ck_users_status"),
        sa.CheckConstraint(
            "email = lower(btrim(email)) AND length(email) > 0", name="ck_users_email_normalized"
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_users_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["sponsor_user_id"],
            ["users.id"],
            name=op.f("fk_users_sponsor_user_id_users"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("users_pkey")),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=False)
    op.create_index(op.f("ix_users_sponsor_user_id"), "users", ["sponsor_user_id"], unique=False)
    op.create_index(op.f("ix_users_supabase_user_id"), "users", ["supabase_user_id"], unique=True)
    op.create_index(op.f("ix_users_username"), "users", ["username"], unique=False)
    op.create_table(
        "workspace_profiles",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("legal_name", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("contact_email", sa.String(length=254), nullable=True),
        sa.Column("contact_phone", sa.String(length=50), nullable=True),
        sa.Column("postal_address", sa.Text(), nullable=True),
        sa.Column("logo_file_id", sa.UUID(), nullable=True),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("locale", sa.String(length=35), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
        sa.Column(
            "invitation_expiry_days", sa.Integer(), server_default=sa.text("7"), nullable=False
        ),
        sa.Column(
            "guest_duration_days", sa.Integer(), server_default=sa.text("30"), nullable=False
        ),
        sa.CheckConstraint(
            "guest_duration_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_guest_duration_days_range",
        ),
        sa.CheckConstraint(
            "invitation_expiry_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_invitation_expiry_days_range",
        ),
        sa.CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_workspace_profiles_not_deleted"
        ),
        sa.CheckConstraint("singleton_key = true", name="ck_workspace_profiles_singleton_key"),
        sa.ForeignKeyConstraint(
            ["logo_file_id"],
            ["files.id"],
            name=op.f("fk_workspace_profiles_logo_file_id_files"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_workspace_profiles_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("workspace_profiles_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_workspace_profiles_singleton_key"),
    )
    op.create_table(
        "boards",
        sa.Column("department_id", sa.UUID(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'active'"), nullable=False
        ),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
        sa.Column("scope", sa.String(length=20), nullable=False),
        sa.CheckConstraint(
            "(scope = 'department') = (department_id IS NOT NULL)",
            name="ck_boards_department_scope",
        ),
        sa.CheckConstraint("scope IN ('company', 'department', 'project')", name="ck_boards_scope"),
        sa.CheckConstraint("status IN ('active', 'archived')", name="ck_boards_status"),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_boards_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_boards_revision_positive"),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_boards_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_boards_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("boards_pkey")),
    )
    op.create_index(op.f("ix_boards_department_id"), "boards", ["department_id"], unique=False)
    op.create_index(
        "uq_boards_company",
        "boards",
        ["scope"],
        unique=True,
        postgresql_where=sa.text("scope = 'company' AND NOT is_deleted"),
    )
    op.create_index(
        "uq_boards_department",
        "boards",
        ["department_id"],
        unique=True,
        postgresql_where=sa.text("scope = 'department' AND NOT is_deleted"),
    )
    op.create_table(
        "dashboards",
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "refresh_cadence",
            sa.String(length=20),
            server_default=sa.text("'manual'"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
        sa.Column("department_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint(
            "refresh_cadence IN ('manual', 'one-minute', 'five-minutes')",
            name="ck_dashboards_refresh_cadence",
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_dashboards_name_nonempty"),
        sa.CheckConstraint("position >= 0", name="ck_dashboards_position_nonnegative"),
        sa.CheckConstraint("revision > 0", name="ck_dashboards_revision_positive"),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_dashboards_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_dashboards_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("dashboards_pkey")),
    )
    op.create_index(
        "ix_dashboards_department_position",
        "dashboards",
        ["department_id", "position"],
        unique=False,
    )
    op.create_table(
        "group_members",
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
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
            ["group_id"],
            ["groups.id"],
            name=op.f("fk_group_members_group_id_groups"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_group_members_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_group_members_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("group_members_pkey")),
        sa.UniqueConstraint("group_id", "user_id", name="uq_group_members_group_user"),
    )
    op.create_index(op.f("ix_group_members_user_id"), "group_members", ["user_id"], unique=False)
    op.create_table(
        "identity_sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("provider_user_id", sa.UUID(), nullable=True),
        sa.Column("provider_session_id", sa.UUID(), nullable=True),
        sa.Column("provider_access_token_encrypted", sa.Text(), nullable=True),
        sa.Column("provider_refresh_token_encrypted", sa.Text(), nullable=True),
        sa.Column("provider_signout_pending_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "provider_signout_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("provider_signout_next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("provider_signout_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refresh_token_digest", sa.String(length=64), nullable=False),
        sa.Column("csrf_token_digest", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("refreshed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_identity_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("identity_sessions_pkey")),
        sa.UniqueConstraint(
            "provider_session_id", name=op.f("uq_identity_sessions_provider_session_id")
        ),
        sa.UniqueConstraint(
            "refresh_token_digest", name="uq_identity_sessions_refresh_token_digest"
        ),
    )
    op.create_index(
        "ix_identity_sessions_user_active",
        "identity_sessions",
        ["user_id", "revoked_at", "expires_at"],
        unique=False,
    )
    op.create_table(
        "lifecycle_confirmation_challenges",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("operation", sa.String(length=20), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=False),
        sa.Column("target_id", sa.UUID(), nullable=False),
        sa.Column("impact_digest", sa.String(length=128), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("failed_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("verification_lease_id", sa.UUID(), nullable=True),
        sa.Column("verification_lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "expires_at > created_at AND expires_at <= created_at + interval '5 minutes'",
            name="ck_lifecycle_challenges_five_minute_expiry",
        ),
        sa.CheckConstraint(
            "length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'",
            name="ck_lifecycle_challenges_token_hash_sha256",
        ),
        sa.CheckConstraint(
            "operation IN ('close', 'purge')", name="ck_lifecycle_challenges_operation"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'verifying', 'consumed', 'expired', 'invalidated', 'exhausted')",
            name="ck_lifecycle_challenges_status",
        ),
        sa.CheckConstraint(
            "failed_attempts >= 0 AND failed_attempts <= 5",
            name="ck_lifecycle_challenges_failed_attempts_nonnegative",
        ),
        sa.CheckConstraint(
            "length(btrim(impact_digest)) > 0",
            name="ck_lifecycle_challenges_impact_digest_nonempty",
        ),
        sa.CheckConstraint(
            "length(btrim(target_type)) > 0", name="ck_lifecycle_challenges_target_type_nonempty"
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_lifecycle_confirmation_challenges_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_confirmation_challenges_pkey")),
        sa.UniqueConstraint(
            "token_hash", name=op.f("uq_lifecycle_confirmation_challenges_token_hash")
        ),
        sa.UniqueConstraint(
            "verification_lease_id",
            name=op.f("uq_lifecycle_confirmation_challenges_verification_lease_id"),
        ),
    )
    op.create_table(
        "lifecycle_rate_limit_buckets",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("blocked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            (
                "window_expires_at > window_started_at AND wi"
                "ndow_expires_at <= window_started_at + inter"
                "val '15 minutes'"
            ),
            name="ck_lifecycle_buckets_fifteen_minute_window",
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5",
            name="ck_lifecycle_buckets_attempt_count_nonnegative",
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_lifecycle_rate_limit_buckets_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_rate_limit_buckets_pkey")),
        sa.UniqueConstraint("actor_id", name=op.f("uq_lifecycle_rate_limit_buckets_actor_id")),
    )
    op.create_table(
        "lifecycle_rate_limit_failures",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_lifecycle_rate_limit_failures_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_rate_limit_failures_pkey")),
    )
    op.create_index(
        "ix_lifecycle_rate_limit_failures_actor_occurred",
        "lifecycle_rate_limit_failures",
        ["actor_id", "occurred_at"],
        unique=False,
    )
    op.create_table(
        "modules",
        sa.Column("department_id", sa.UUID(), nullable=False),
        sa.Column("module_name", sa.String(length=150), nullable=False),
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
        sa.Column("title_field_id", sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_modules_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_modules_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["title_field_id"],
            ["fields.id"],
            name=op.f("fk_modules_title_field_id_fields"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("modules_pkey")),
    )
    op.create_index(op.f("ix_modules_department_id"), "modules", ["department_id"], unique=False)
    op.create_index(op.f("ix_modules_title_field_id"), "modules", ["title_field_id"], unique=False)
    op.create_index(
        "uq_modules_department_name_active",
        "modules",
        ["department_id", "module_name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "sandbox_test_runs",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("document_revision", sa.Integer(), nullable=False),
        sa.Column("document_hash", sa.String(length=64), nullable=False),
        sa.Column("module_id", sa.String(length=1000), nullable=False),
        sa.Column("input_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("event", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("trigger_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("result_byte_count", sa.Integer(), nullable=False),
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
            "document_revision > 0", name="ck_sandbox_test_runs_document_revision_positive"
        ),
        sa.CheckConstraint(
            "result_byte_count >= 0", name="ck_sandbox_test_runs_result_byte_count_nonnegative"
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["sandbox_documents.id"],
            name=op.f("fk_sandbox_test_runs_document_id_sandbox_documents"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_test_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_test_runs_pkey")),
    )
    op.create_index(
        "ix_sandbox_test_runs_document_created",
        "sandbox_test_runs",
        ["document_id", "created_at", "id"],
        unique=False,
    )
    op.create_table(
        "sandbox_versions",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("source_document_revision", sa.Integer(), nullable=False),
        sa.Column("source_version_id", sa.UUID(), nullable=True),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("byte_count", sa.Integer(), nullable=False),
        sa.Column("metadata_revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
            "kind IN ('checkpoint', 'published', 'imported')", name="ck_sandbox_versions_kind"
        ),
        sa.CheckConstraint(
            "snapshot ->> 'schemaVersion' = '4'", name="ck_sandbox_versions_schema_version"
        ),
        sa.CheckConstraint("byte_count >= 0", name="ck_sandbox_versions_byte_count_nonnegative"),
        sa.CheckConstraint(
            "metadata_revision > 0", name="ck_sandbox_versions_metadata_revision_positive"
        ),
        sa.CheckConstraint("sequence > 0", name="ck_sandbox_versions_sequence_positive"),
        sa.CheckConstraint(
            "source_document_revision > 0", name="ck_sandbox_versions_source_revision_positive"
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["sandbox_documents.id"],
            name=op.f("fk_sandbox_versions_document_id_sandbox_documents"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_versions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["source_version_id"],
            ["sandbox_versions.id"],
            name=op.f("fk_sandbox_versions_source_version_id_sandbox_versions"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_versions_pkey")),
        sa.UniqueConstraint(
            "document_id", "sequence", name="uq_sandbox_versions_document_sequence"
        ),
    )
    op.create_index(
        "ix_sandbox_versions_source_version",
        "sandbox_versions",
        ["source_version_id"],
        unique=False,
    )
    op.create_table(
        "board_events",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("details", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("location", sa.String(length=240), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "links",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("all_day", sa.Boolean(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("timezone_name", sa.String(length=80), nullable=False),
        sa.Column(
            "recurrence", sa.String(length=10), server_default=sa.text("'none'"), nullable=False
        ),
        sa.Column("repeat_until", sa.Date(), nullable=True),
        sa.Column("archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
            (
                "(recurrence = 'none' AND repeat_until IS NUL"
                "L) OR (recurrence IN ('daily', 'weekly', 'mo"
                "nthly') AND repeat_until IS NOT NULL)"
            ),
            name="ck_board_events_recurrence",
        ),
        sa.CheckConstraint(
            (
                "CASE WHEN jsonb_typeof(links) = 'array' THEN"
                " jsonb_array_length(links) <= 20 ELSE false "
                "END"
            ),
            name="ck_board_events_links_array_limit",
        ),
        sa.CheckConstraint(
            (
                "(all_day = true AND start_date IS NOT NULL A"
                "ND end_date IS NOT NULL AND start_at IS NULL"
                " AND end_at IS NULL AND end_date >= start_da"
                "te) OR (all_day = false AND start_date IS NU"
                "LL AND end_date IS NULL AND start_at IS NOT "
                "NULL AND end_at IS NOT NULL AND end_at > sta"
                "rt_at)"
            ),
            name="ck_board_events_temporal_mode",
        ),
        sa.CheckConstraint(
            "length(btrim(timezone_name)) > 0", name="ck_board_events_timezone_nonempty"
        ),
        sa.CheckConstraint("length(btrim(title)) > 0", name="ck_board_events_title_nonempty"),
        sa.CheckConstraint("length(details) <= 4000", name="ck_board_events_details_length"),
        sa.CheckConstraint(
            "repeat_until IS NULL OR NOT all_day OR repeat_until >= start_date",
            name="ck_board_events_all_day_repeat_until",
        ),
        sa.CheckConstraint("revision > 0", name="ck_board_events_revision_positive"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_board_events_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name=op.f("fk_board_events_board_id_boards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_events_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_events_pkey")),
    )
    op.create_index("ix_board_events_author_id", "board_events", ["author_id"], unique=False)
    op.create_index("ix_board_events_board_id", "board_events", ["board_id"], unique=False)
    op.create_table(
        "board_groups",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("level", sa.String(length=10), nullable=False),
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
        sa.CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_board_groups_level"),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name=op.f("fk_board_groups_board_id_boards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["groups.id"],
            name=op.f("fk_board_groups_group_id_groups"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_groups_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_groups_pkey")),
    )
    op.create_index("ix_board_groups_group_id", "board_groups", ["group_id"], unique=False)
    op.create_index(
        "uq_board_groups_board_group_active",
        "board_groups",
        ["board_id", "group_id"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "board_posts",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "links",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False
        ),
        sa.Column("publish_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("displayed_publication_number", sa.Integer(), nullable=True),
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
            (
                "CASE WHEN jsonb_typeof(links) = 'array' THEN"
                " jsonb_array_length(links) <= 20 ELSE false "
                "END"
            ),
            name="ck_board_posts_links_array_limit",
        ),
        sa.CheckConstraint(
            "status <> 'scheduled' OR publish_at IS NOT NULL", name="ck_board_posts_scheduled_time"
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'scheduled', 'published', 'archived')",
            name="ck_board_posts_status",
        ),
        sa.CheckConstraint(
            "displayed_publication_number IS NULL OR displayed_publication_number > 0",
            name="ck_board_posts_displayed_publication_positive",
        ),
        sa.CheckConstraint("length(body) <= 2000", name="ck_board_posts_body_length"),
        sa.CheckConstraint("length(btrim(body)) > 0", name="ck_board_posts_body_nonempty"),
        sa.CheckConstraint("length(btrim(title)) > 0", name="ck_board_posts_title_nonempty"),
        sa.CheckConstraint(
            "publish_at IS NULL OR expires_at IS NULL OR expires_at > publish_at",
            name="ck_board_posts_expiry",
        ),
        sa.CheckConstraint("revision > 0", name="ck_board_posts_revision_positive"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_board_posts_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name=op.f("fk_board_posts_board_id_boards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_posts_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_posts_pkey")),
    )
    op.create_index("ix_board_posts_author_id", "board_posts", ["author_id"], unique=False)
    op.create_index("ix_board_posts_board_id", "board_posts", ["board_id"], unique=False)
    op.create_table(
        "board_widgets",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("widget_type", sa.String(length=20), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_board_widgets_type",
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_board_widgets_name_nonempty"),
        sa.CheckConstraint("position >= 0 AND position < 12", name="ck_board_widgets_position"),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name=op.f("fk_board_widgets_board_id_boards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_board_widgets_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_widgets_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_widgets_pkey")),
        sa.UniqueConstraint(
            "board_id",
            "position",
            deferrable=True,
            initially="DEFERRED",
            name="uq_board_widgets_board_position",
        ),
    )
    op.create_index("ix_board_widgets_module_id", "board_widgets", ["module_id"], unique=False)
    op.create_table(
        "dashboard_widgets",
        sa.Column("dashboard_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "widget_type", sa.String(length=20), server_default=sa.text("'chart'"), nullable=False
        ),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_dashboard_widgets_type",
        ),
        sa.CheckConstraint("position >= 0 AND position < 12", name="ck_dashboard_widgets_position"),
        sa.ForeignKeyConstraint(
            ["dashboard_id"],
            ["dashboards.id"],
            name=op.f("fk_dashboard_widgets_dashboard_id_dashboards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_dashboard_widgets_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("dashboard_widgets_pkey")),
    )
    op.create_index(
        "ix_dashboard_widgets_dashboard_id", "dashboard_widgets", ["dashboard_id"], unique=False
    )
    op.create_index(
        "uq_dashboard_widgets_active_position",
        "dashboard_widgets",
        ["dashboard_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "fields",
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("required", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("audit_redacted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("relationship_target_module_id", sa.UUID(), nullable=True),
        sa.Column("relationship_multiple_targets", sa.Boolean(), nullable=True),
        sa.Column("relationship_multiple_sources", sa.Boolean(), nullable=True),
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
            (
                "(type = 'relationship' AND relationship_targ"
                "et_module_id IS NOT NULL AND relationship_mu"
                "ltiple_targets IS NOT NULL AND relationship_"
                "multiple_sources IS NOT NULL AND required = "
                "false AND config = '{}'::jsonb) OR (type <> "
                "'relationship' AND relationship_target_modul"
                "e_id IS NULL AND relationship_multiple_targe"
                "ts IS NULL AND relationship_multiple_sources"
                " IS NULL)"
            ),
            name="ck_fields_relationship_metadata",
        ),
        sa.CheckConstraint(
            (
                "type IN ('text', 'long_text', 'email', 'url'"
                ", 'number', 'decimal', 'int', 'boolean', 'da"
                "te', 'datetime', 'select', 'user', 'relation"
                "ship')"
            ),
            name="ck_fields_type",
        ),
        sa.CheckConstraint("position >= 0", name="ck_fields_position_nonnegative"),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_fields_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_fields_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["relationship_target_module_id"],
            ["modules.id"],
            name=op.f("fk_fields_relationship_target_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("fields_pkey")),
    )
    op.create_index(op.f("ix_fields_module_id"), "fields", ["module_id"], unique=False)
    op.create_index(
        "ix_fields_relationship_target_module_id",
        "fields",
        ["relationship_target_module_id"],
        unique=False,
    )
    op.create_index(
        "uq_fields_module_name_active",
        "fields",
        ["module_id", "name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "uq_fields_module_position_active",
        "fields",
        ["module_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "group_access",
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=True),
        sa.Column("level", sa.Text(), nullable=False),
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
        sa.CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_group_access_level"),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_group_access_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["groups.id"],
            name=op.f("fk_group_access_group_id_groups"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_group_access_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_group_access_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("group_access_pkey")),
    )
    op.create_index(
        "ix_group_access_department_module_active",
        "group_access",
        ["department_id", "module_id"],
        unique=False,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index("ix_group_access_module_id", "group_access", ["module_id"], unique=False)
    op.create_index(
        "uq_group_access_target_active",
        "group_access",
        ["group_id", "department_id", "module_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "records",
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column(
            "data",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
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
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_records_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_records_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("records_pkey")),
    )
    op.create_index(op.f("ix_records_module_id"), "records", ["module_id"], unique=False)
    op.create_table(
        "reports",
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("subtitle", sa.String(length=160), nullable=True),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("recipe", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_reports_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_reports_revision_positive"),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_reports_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_reports_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("reports_pkey")),
    )
    op.create_index("ix_reports_module", "reports", ["module_id"], unique=False)
    op.create_table(
        "sandbox_publications",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("version_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("document_revision", sa.Integer(), nullable=False),
        sa.Column("document_hash", sa.String(length=64), nullable=False),
        sa.Column("impact_digest", sa.String(length=64), nullable=False),
        sa.Column("live_state_digest", sa.String(length=64), nullable=False),
        sa.Column("preview_token_digest", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("response_body", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "document_revision > 0", name="ck_sandbox_publications_document_revision"
        ),
        sa.CheckConstraint(
            "length(document_hash) = 64", name="ck_sandbox_publications_document_hash"
        ),
        sa.CheckConstraint(
            "length(impact_digest) = 64", name="ck_sandbox_publications_impact_digest"
        ),
        sa.CheckConstraint(
            "length(live_state_digest) = 64", name="ck_sandbox_publications_live_digest"
        ),
        sa.CheckConstraint(
            "length(preview_token_digest) = 64", name="ck_sandbox_publications_preview_token_digest"
        ),
        sa.CheckConstraint(
            "length(request_fingerprint) = 64", name="ck_sandbox_publications_request_fingerprint"
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_sandbox_publications_actor_id_users"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["sandbox_documents.id"],
            name=op.f("fk_sandbox_publications_document_id_sandbox_documents"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_publications_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["sandbox_versions.id"],
            name=op.f("fk_sandbox_publications_version_id_sandbox_versions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_publications_pkey")),
        sa.UniqueConstraint(
            "actor_id", "idempotency_key", name="uq_sandbox_publications_actor_key"
        ),
        sa.UniqueConstraint(
            "preview_token_digest", name="uq_sandbox_publications_preview_token_digest"
        ),
        sa.UniqueConstraint("version_id", name="uq_sandbox_publications_version"),
    )
    op.create_index(
        op.f("ix_sandbox_publications_actor_id"), "sandbox_publications", ["actor_id"], unique=False
    )
    op.create_index(
        "ix_sandbox_publications_document_created",
        "sandbox_publications",
        ["document_id", "created_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_sandbox_publications_document_id"),
        "sandbox_publications",
        ["document_id"],
        unique=False,
    )
    op.create_table(
        "saved_views",
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "presentation",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{\"version\": 1}'::jsonb"),
            nullable=False,
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
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.CheckConstraint("revision > 0", name="ck_saved_views_revision"),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_saved_views_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_saved_views_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("saved_views_pkey")),
        sa.UniqueConstraint("id", "module_id", name="uq_saved_views_id_module"),
    )
    op.create_index(op.f("ix_saved_views_module_id"), "saved_views", ["module_id"], unique=False)
    op.create_index(
        "uq_saved_views_module_default",
        "saved_views",
        ["module_id"],
        unique=True,
        postgresql_where=sa.text("is_default AND NOT is_deleted"),
    )
    op.create_table(
        "board_event_reminders",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("timing", sa.String(length=8), nullable=False),
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
            "timing IN ('start', '15m', '1d')", name="ck_board_event_reminders_timing"
        ),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name=op.f("fk_board_event_reminders_board_id_boards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["board_events.id"],
            name=op.f("fk_board_event_reminders_event_id_board_events"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_event_reminders_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_event_reminders_pkey")),
        sa.UniqueConstraint("event_id", "timing", name="uq_board_event_reminders_event_timing"),
    )
    op.create_index(
        "ix_board_event_reminders_board_id", "board_event_reminders", ["board_id"], unique=False
    )
    op.create_table(
        "board_post_revisions",
        sa.Column("post_id", sa.UUID(), nullable=False),
        sa.Column("publication_number", sa.Integer(), nullable=False),
        sa.Column("publication_key", sa.Uuid(), nullable=False),
        sa.Column("content_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "links",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
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
            (
                "CASE WHEN jsonb_typeof(links) = 'array' THEN"
                " jsonb_array_length(links) <= 20 ELSE false "
                "END"
            ),
            name="ck_board_post_revisions_links_array_limit",
        ),
        sa.CheckConstraint(
            "content_fingerprint ~ '^[0-9a-f]{64}$'", name="ck_board_post_revisions_fingerprint_hex"
        ),
        sa.CheckConstraint(
            "expires_at IS NULL OR expires_at > published_at", name="ck_board_post_revisions_expiry"
        ),
        sa.CheckConstraint("length(body) <= 2000", name="ck_board_post_revisions_body_length"),
        sa.CheckConstraint("length(btrim(body)) > 0", name="ck_board_post_revisions_body_nonempty"),
        sa.CheckConstraint(
            "length(btrim(title)) > 0", name="ck_board_post_revisions_title_nonempty"
        ),
        sa.CheckConstraint(
            "publication_number > 0", name="ck_board_post_revisions_number_positive"
        ),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_board_post_revisions_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revisions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["post_id"],
            ["board_posts.id"],
            name=op.f("fk_board_post_revisions_post_id_board_posts"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revisions_pkey")),
        sa.UniqueConstraint(
            "post_id", "publication_key", name="uq_board_post_revisions_publication_key"
        ),
        sa.UniqueConstraint(
            "post_id", "publication_number", name="uq_board_post_revisions_publication"
        ),
    )
    op.create_index(
        "ix_board_post_revisions_author_id", "board_post_revisions", ["author_id"], unique=False
    )
    op.create_table(
        "board_record_links",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=True),
        sa.Column("post_id", sa.UUID(), nullable=True),
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=False),
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
            (
                "(event_id IS NOT NULL AND post_id IS NULL) O"
                "R (event_id IS NULL AND post_id IS NOT NULL)"
            ),
            name="ck_board_record_links_one_owner",
        ),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name=op.f("fk_board_record_links_board_id_boards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["board_events.id"],
            name=op.f("fk_board_record_links_event_id_board_events"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_board_record_links_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_record_links_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["post_id"],
            ["board_posts.id"],
            name=op.f("fk_board_record_links_post_id_board_posts"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["records.id"],
            name=op.f("fk_board_record_links_record_id_records"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_record_links_pkey")),
        sa.UniqueConstraint("event_id", "record_id", name="uq_board_event_record_link"),
        sa.UniqueConstraint("post_id", "record_id", name="uq_board_post_record_link"),
    )
    op.create_index(
        "ix_board_record_links_board_id", "board_record_links", ["board_id"], unique=False
    )
    op.create_index(
        "ix_board_record_links_module_id", "board_record_links", ["module_id"], unique=False
    )
    op.create_index(
        "ix_board_record_links_record_id", "board_record_links", ["record_id"], unique=False
    )
    op.create_table(
        "files",
        sa.Column("purpose", sa.String(length=30), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=True),
        sa.Column("board_id", sa.UUID(), nullable=True),
        sa.Column("creator_id", sa.UUID(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("media_type", sa.String(length=120), nullable=True),
        sa.Column("expected_size", sa.Integer(), nullable=False),
        sa.Column("actual_size", sa.Integer(), nullable=True),
        sa.Column("digest", sa.String(length=64), nullable=True),
        sa.Column("enc_version", sa.SmallInteger(), nullable=True),
        sa.Column("object_key", sa.String(length=100), nullable=False),
        sa.Column("state", sa.String(length=30), nullable=False),
        sa.Column("operation_id", sa.Uuid(), nullable=True),
        sa.Column("operation_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=60), nullable=True),
        sa.Column("scanner_version", sa.String(length=200), nullable=True),
        sa.Column("signature_version", sa.String(length=200), nullable=True),
        sa.Column("scan_requested_by", sa.UUID(), nullable=True),
        sa.Column("scan_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("scan_next_attempt_at", sa.DateTime(timezone=True), nullable=True),
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
            (
                "(purpose = 'record_attachment' AND record_id"
                " IS NOT NULL AND board_id IS NULL) OR (purpo"
                "se = 'board_attachment' AND board_id IS NOT "
                "NULL AND record_id IS NULL) OR (purpose IN ("
                "'library_document', 'workspace_logo') AND re"
                "cord_id IS NULL AND board_id IS NULL)"
            ),
            name="ck_files_purpose_parent",
        ),
        sa.CheckConstraint(
            "purpose != 'workspace_logo' OR expected_size <= 2097152", name="ck_files_logo_size"
        ),
        sa.CheckConstraint(
            (
                "state != 'ready' OR (digest IS NOT NULL AND "
                "actual_size IS NOT NULL AND scanner_version "
                "IS NOT NULL AND signature_version IS NOT NUL"
                "L)"
            ),
            name="ck_files_ready_verdict",
        ),
        sa.CheckConstraint(
            (
                "state IN ('awaiting_upload','uploading','pen"
                "ding_scan','ready','rejected','deleting','pu"
                "rged')"
            ),
            name="ck_files_state",
        ),
        sa.CheckConstraint(
            "actual_size IS NULL OR (actual_size > 0 AND actual_size <= 26214400)",
            name="ck_files_actual_size",
        ),
        sa.CheckConstraint("enc_version IS NULL OR enc_version > 0", name="ck_files_enc_version"),
        sa.CheckConstraint(
            "expected_size > 0 AND expected_size <= 26214400", name="ck_files_expected_size"
        ),
        sa.CheckConstraint("scan_attempts >= 0", name="ck_files_scan_attempts"),
        sa.ForeignKeyConstraint(
            ["board_id"], ["boards.id"], name=op.f("fk_files_board_id_boards"), ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["creator_id"],
            ["users.id"],
            name=op.f("fk_files_creator_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_files_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["records.id"],
            name=op.f("fk_files_record_id_records"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["scan_requested_by"],
            ["users.id"],
            name=op.f("fk_files_scan_requested_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("files_pkey")),
        sa.UniqueConstraint("object_key", name=op.f("uq_files_object_key")),
    )
    op.create_index(op.f("ix_files_board_id"), "files", ["board_id"], unique=False)
    op.create_index(op.f("ix_files_creator_id"), "files", ["creator_id"], unique=False)
    op.create_index(op.f("ix_files_purpose"), "files", ["purpose"], unique=False)
    op.create_index(op.f("ix_files_record_id"), "files", ["record_id"], unique=False)
    op.create_index(
        "ix_files_scan_due",
        "files",
        ["scan_next_attempt_at", "id"],
        unique=False,
        postgresql_where=sa.text("state = 'pending_scan' AND operation_id IS NULL"),
    )
    op.create_table(
        "record_triggers",
        sa.Column("publication_id", sa.UUID(), nullable=False),
        sa.Column("published_version_id", sa.UUID(), nullable=False),
        sa.Column("publisher_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("priority", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("execution_position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("event_kind", sa.String(length=24), nullable=False),
        sa.Column("trigger_field_id", sa.UUID(), nullable=True),
        sa.Column("trigger_operator", sa.String(length=2), nullable=True),
        sa.Column("trigger_value_kind", sa.String(length=16), nullable=True),
        sa.Column("trigger_literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("trigger_value_field_id", sa.UUID(), nullable=True),
        sa.Column("schedule_frequency", sa.String(length=8), nullable=True),
        sa.Column("schedule_time", sa.String(length=5), nullable=True),
        sa.Column("schedule_weekday", sa.Integer(), nullable=True),
        sa.Column("workspace_timezone", sa.String(length=64), nullable=False),
        sa.Column("condition_operator", sa.String(length=3), nullable=False),
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("suspension_reason", sa.String(length=240), nullable=True),
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
            "condition_operator IN ('all', 'any')", name="ck_record_triggers_condition_operator"
        ),
        sa.CheckConstraint(
            "event_kind IN ('record-created', 'field-changed', 'threshold-crossed', 'schedule')",
            name="ck_record_triggers_event_kind",
        ),
        sa.CheckConstraint(
            "trigger_value_kind IS NULL OR trigger_value_kind IN ('literal', 'field-reference')",
            name="ck_record_triggers_trigger_value_kind",
        ),
        sa.CheckConstraint("execution_position >= 0", name="ck_record_triggers_execution_position"),
        sa.CheckConstraint(
            "priority >= -10000 AND priority <= 10000", name="ck_record_triggers_priority"
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_record_triggers_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_triggers_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["publication_id"],
            ["sandbox_publications.id"],
            name=op.f("fk_record_triggers_publication_id_sandbox_publications"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["published_version_id"],
            ["sandbox_versions.id"],
            name=op.f("fk_record_triggers_published_version_id_sandbox_versions"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["publisher_id"],
            ["users.id"],
            name=op.f("fk_record_triggers_publisher_id_users"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["trigger_field_id"],
            ["fields.id"],
            name=op.f("fk_record_triggers_trigger_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["trigger_value_field_id"],
            ["fields.id"],
            name=op.f("fk_record_triggers_trigger_value_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_triggers_pkey")),
    )
    op.create_index(
        "ix_record_triggers_module", "record_triggers", ["module_id", "is_deleted"], unique=False
    )
    op.create_index(
        op.f("ix_record_triggers_module_id"), "record_triggers", ["module_id"], unique=False
    )
    op.create_index(
        op.f("ix_record_triggers_publication_id"),
        "record_triggers",
        ["publication_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_triggers_published_version_id"),
        "record_triggers",
        ["published_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_triggers_publisher_id"), "record_triggers", ["publisher_id"], unique=False
    )
    op.create_index(
        op.f("ix_record_triggers_trigger_field_id"),
        "record_triggers",
        ["trigger_field_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_triggers_trigger_value_field_id"),
        "record_triggers",
        ["trigger_value_field_id"],
        unique=False,
    )
    op.create_table(
        "relationship_edges",
        sa.Column("field_id", sa.UUID(), nullable=False),
        sa.Column("source_record_id", sa.UUID(), nullable=False),
        sa.Column("target_record_id", sa.UUID(), nullable=False),
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
            "source_record_id <> target_record_id", name="ck_relationship_edges_distinct_records"
        ),
        sa.ForeignKeyConstraint(
            ["field_id"],
            ["fields.id"],
            name=op.f("fk_relationship_edges_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_relationship_edges_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["source_record_id"],
            ["records.id"],
            name=op.f("fk_relationship_edges_source_record_id_records"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["target_record_id"],
            ["records.id"],
            name=op.f("fk_relationship_edges_target_record_id_records"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("relationship_edges_pkey")),
    )
    op.create_index(
        "ix_relationship_edges_active_source",
        "relationship_edges",
        ["field_id", "source_record_id"],
        unique=False,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "ix_relationship_edges_active_target",
        "relationship_edges",
        ["field_id", "target_record_id"],
        unique=False,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "uq_relationship_edges_active",
        "relationship_edges",
        ["field_id", "source_record_id", "target_record_id"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "report_runs",
        sa.Column("report_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(), nullable=False),
        sa.Column("recipe_revision", sa.Integer(), nullable=False),
        sa.Column("recipe", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("headings", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=False),
        sa.Column("csv_bytes", sa.LargeBinary(), nullable=False),
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
        sa.CheckConstraint("recipe_revision > 0", name="ck_report_runs_recipe_revision_positive"),
        sa.CheckConstraint("row_count >= 0", name="ck_report_runs_row_count_nonnegative"),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_report_runs_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["reports.id"],
            name=op.f("fk_report_runs_report_id_reports"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_runs_pkey")),
        sa.UniqueConstraint("report_id", "idempotency_key", name="uq_report_runs_idempotency"),
    )
    op.create_index("ix_report_runs_module", "report_runs", ["module_id"], unique=False)
    op.create_index(
        "ix_report_runs_report_created", "report_runs", ["report_id", "created_at"], unique=False
    )
    op.create_table(
        "report_schedules",
        sa.Column("report_id", sa.UUID(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("cadence", sa.String(length=8), nullable=False),
        sa.Column("timezone_name", sa.String(length=64), nullable=False),
        sa.Column("local_time", sa.Time(), nullable=False),
        sa.Column("weekday", sa.Integer(), nullable=True),
        sa.Column("month_day", sa.Integer(), nullable=True),
        sa.Column("next_due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
            (
                "(cadence = 'daily' AND weekday IS NULL AND m"
                "onth_day IS NULL) OR (cadence = 'weekly' AND"
                " weekday BETWEEN 0 AND 6 AND month_day IS NU"
                "LL) OR (cadence = 'monthly' AND weekday IS N"
                "ULL AND month_day BETWEEN 1 AND 31)"
            ),
            name="ck_report_schedules_anchor",
        ),
        sa.CheckConstraint(
            "cadence IN ('daily', 'weekly', 'monthly')", name="ck_report_schedules_cadence"
        ),
        sa.CheckConstraint(
            "EXTRACT(SECOND FROM local_time) = 0", name="ck_report_schedules_minute_time"
        ),
        sa.CheckConstraint(
            "length(btrim(timezone_name)) > 0", name="ck_report_schedules_timezone_nonempty"
        ),
        sa.CheckConstraint("revision > 0", name="ck_report_schedules_revision_positive"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_schedules_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["reports.id"],
            name=op.f("fk_report_schedules_report_id_reports"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_schedules_pkey")),
        sa.UniqueConstraint("report_id", name="uq_report_schedules_report"),
    )
    op.create_index(
        "ix_report_schedules_due",
        "report_schedules",
        ["enabled", "next_due_at", "id"],
        unique=False,
    )
    op.create_table(
        "board_attachments",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("file_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=True),
        sa.Column("post_id", sa.UUID(), nullable=True),
        sa.Column("is_linked", sa.Boolean(), server_default=sa.text("true"), nullable=False),
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
            (
                "(event_id IS NOT NULL AND post_id IS NULL) O"
                "R (event_id IS NULL AND post_id IS NOT NULL)"
            ),
            name="ck_board_attachments_one_owner",
        ),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name=op.f("fk_board_attachments_board_id_boards"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["board_events.id"],
            name=op.f("fk_board_attachments_event_id_board_events"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["file_id"],
            ["files.id"],
            name=op.f("fk_board_attachments_file_id_files"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_attachments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["post_id"],
            ["board_posts.id"],
            name=op.f("fk_board_attachments_post_id_board_posts"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_attachments_pkey")),
        sa.UniqueConstraint("file_id", name="uq_board_attachments_file"),
    )
    op.create_index(
        "ix_board_attachments_board_id", "board_attachments", ["board_id"], unique=False
    )
    op.create_index(
        "ix_board_attachments_event_id", "board_attachments", ["event_id"], unique=False
    )
    op.create_index("ix_board_attachments_post_id", "board_attachments", ["post_id"], unique=False)
    op.create_table(
        "board_post_revision_attachments",
        sa.Column("revision_id", sa.UUID(), nullable=False),
        sa.Column("file_id", sa.UUID(), nullable=False),
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
            ["file_id"],
            ["files.id"],
            name=op.f("fk_board_post_revision_attachments_file_id_files"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revision_attachments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["board_post_revisions.id"],
            name=op.f("fk_board_post_revision_attachments_revision_id_board_post_revisions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revision_attachments_pkey")),
        sa.UniqueConstraint("revision_id", "file_id", name="uq_board_post_revision_attachments"),
    )
    op.create_index(
        "ix_board_post_revision_attachments_file_id",
        "board_post_revision_attachments",
        ["file_id"],
        unique=False,
    )
    op.create_table(
        "board_post_revision_record_links",
        sa.Column("revision_id", sa.UUID(), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=False),
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
            name=op.f("fk_board_post_revision_record_links_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revision_record_links_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["records.id"],
            name=op.f("fk_board_post_revision_record_links_record_id_records"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["board_post_revisions.id"],
            name=op.f("fk_board_post_revision_record_links_revision_id_board_post_revisions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revision_record_links_pkey")),
        sa.UniqueConstraint("revision_id", "record_id", name="uq_board_revision_record_link"),
    )
    op.create_index(
        "ix_board_revision_record_links_module_id",
        "board_post_revision_record_links",
        ["module_id"],
        unique=False,
    )
    op.create_index(
        "ix_board_revision_record_links_record_id",
        "board_post_revision_record_links",
        ["record_id"],
        unique=False,
    )
    op.create_table(
        "record_trigger_actions",
        sa.Column("trigger_id", sa.UUID(), nullable=False),
        sa.Column("target_field_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("value_kind", sa.String(length=16), nullable=False),
        sa.Column("literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("value_field_id", sa.UUID(), nullable=True),
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
        sa.CheckConstraint("kind = 'set-field'", name="ck_record_trigger_actions_supported_kind"),
        sa.CheckConstraint(
            "value_kind IN ('literal', 'field-reference')",
            name="ck_record_trigger_actions_value_kind",
        ),
        sa.CheckConstraint("position >= 0", name="ck_record_trigger_actions_position"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_actions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["target_field_id"],
            ["fields.id"],
            name=op.f("fk_record_trigger_actions_target_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["trigger_id"],
            ["record_triggers.id"],
            name=op.f("fk_record_trigger_actions_trigger_id_record_triggers"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["value_field_id"],
            ["fields.id"],
            name=op.f("fk_record_trigger_actions_value_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_actions_pkey")),
    )
    op.create_index(
        op.f("ix_record_trigger_actions_target_field_id"),
        "record_trigger_actions",
        ["target_field_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_actions_trigger_id"),
        "record_trigger_actions",
        ["trigger_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_actions_value_field_id"),
        "record_trigger_actions",
        ["value_field_id"],
        unique=False,
    )
    op.create_index(
        "uq_record_trigger_actions_position_active",
        "record_trigger_actions",
        ["trigger_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "record_trigger_conditions",
        sa.Column("trigger_id", sa.UUID(), nullable=False),
        sa.Column("field_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("operator", sa.String(length=2), nullable=False),
        sa.Column("value_kind", sa.String(length=16), nullable=False),
        sa.Column("literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("value_field_id", sa.UUID(), nullable=True),
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
            "operator IN ('>', '>=', '<', '<=', '=', '!=')",
            name="ck_record_trigger_conditions_operator",
        ),
        sa.CheckConstraint(
            "value_kind IN ('literal', 'field-reference')",
            name="ck_record_trigger_conditions_value_kind",
        ),
        sa.CheckConstraint("position >= 0", name="ck_record_trigger_conditions_position"),
        sa.ForeignKeyConstraint(
            ["field_id"],
            ["fields.id"],
            name=op.f("fk_record_trigger_conditions_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_conditions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["trigger_id"],
            ["record_triggers.id"],
            name=op.f("fk_record_trigger_conditions_trigger_id_record_triggers"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["value_field_id"],
            ["fields.id"],
            name=op.f("fk_record_trigger_conditions_value_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_conditions_pkey")),
    )
    op.create_index(
        op.f("ix_record_trigger_conditions_field_id"),
        "record_trigger_conditions",
        ["field_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_conditions_trigger_id"),
        "record_trigger_conditions",
        ["trigger_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_conditions_value_field_id"),
        "record_trigger_conditions",
        ["value_field_id"],
        unique=False,
    )
    op.create_index(
        "uq_record_trigger_conditions_position_active",
        "record_trigger_conditions",
        ["trigger_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "record_trigger_events",
        sa.Column("record_id", sa.UUID(), nullable=True),
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("scheduled_trigger_id", sa.UUID(), nullable=True),
        sa.Column("event_kind", sa.String(length=24), nullable=False),
        sa.Column("changed_field_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("previous_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("root_event_id", sa.UUID(), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("action_budget", sa.Integer(), nullable=False),
        sa.Column("schedule_upper_record_id", sa.UUID(), nullable=True),
        sa.Column("schedule_cursor_record_id", sa.UUID(), nullable=True),
        sa.Column(
            "schedule_matched_count", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "schedule_action_count", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("schedule_key", sa.String(length=120), nullable=True),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
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
            (
                "(event_kind = 'schedule' AND scheduled_trigg"
                "er_id IS NOT NULL) OR (event_kind IN ('recor"
                "d-created', 'field-changed') AND scheduled_t"
                "rigger_id IS NULL AND record_id IS NOT NULL)"
            ),
            name="ck_record_trigger_events_subject",
        ),
        sa.CheckConstraint(
            (
                "(event_kind = 'schedule') OR (schedule_upper"
                "_record_id IS NULL AND schedule_cursor_recor"
                "d_id IS NULL AND schedule_matched_count = 0 "
                "AND schedule_action_count = 0)"
            ),
            name="ck_record_trigger_events_schedule_progress",
        ),
        sa.CheckConstraint(
            (
                "(state = 'running' AND lease_token IS NOT NU"
                "LL AND lease_expires_at IS NOT NULL) OR (sta"
                "te <> 'running' AND lease_token IS NULL AND "
                "lease_expires_at IS NULL)"
            ),
            name="ck_record_trigger_events_lease",
        ),
        sa.CheckConstraint(
            "event_kind IN ('record-created', 'field-changed', 'schedule')",
            name="ck_record_trigger_events_kind",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_record_trigger_events_state",
        ),
        sa.CheckConstraint(
            "(depth = 0 AND root_event_id IS NULL) OR (depth > 0 AND root_event_id IS NOT NULL)",
            name="ck_record_trigger_events_root_depth",
        ),
        sa.CheckConstraint(
            "action_budget >= 0 AND action_budget <= 100", name="ck_record_trigger_events_budget"
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5",
            name="ck_record_trigger_events_attempt_count",
        ),
        sa.CheckConstraint("depth >= 0 AND depth <= 10", name="ck_record_trigger_events_depth"),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_record_trigger_events_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_events_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["records.id"],
            name=op.f("fk_record_trigger_events_record_id_records"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["root_event_id"],
            ["record_trigger_events.id"],
            name=op.f("fk_record_trigger_events_root_event_id_record_trigger_events"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["scheduled_trigger_id"],
            ["record_triggers.id"],
            name=op.f("fk_record_trigger_events_scheduled_trigger_id_record_triggers"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_events_pkey")),
        sa.UniqueConstraint("schedule_key", name=op.f("uq_record_trigger_events_schedule_key")),
    )
    op.create_index(
        "ix_record_trigger_events_due",
        "record_trigger_events",
        ["state", "next_attempt_at", "id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_module_id"),
        "record_trigger_events",
        ["module_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_record_id"),
        "record_trigger_events",
        ["record_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_root_event_id"),
        "record_trigger_events",
        ["root_event_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_scheduled_trigger_id"),
        "record_trigger_events",
        ["scheduled_trigger_id"],
        unique=False,
    )
    op.create_table(
        "report_run_eligible_users",
        sa.Column("run_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["report_runs.id"],
            name=op.f("fk_report_run_eligible_users_run_id_report_runs"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_report_run_eligible_users_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("run_id", "user_id", name=op.f("report_run_eligible_users_pkey")),
    )
    op.create_index(
        "ix_report_run_eligible_users_user_run",
        "report_run_eligible_users",
        ["user_id", "run_id"],
        unique=False,
    )
    op.create_table(
        "report_run_rows",
        sa.Column("run_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("cells", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
        sa.CheckConstraint("position >= 0", name="ck_report_run_rows_position_nonnegative"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_run_rows_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["records.id"],
            name=op.f("fk_report_run_rows_record_id_records"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["report_runs.id"],
            name=op.f("fk_report_run_rows_run_id_report_runs"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_run_rows_pkey")),
        sa.UniqueConstraint("run_id", "position", name="uq_report_run_rows_position"),
        sa.UniqueConstraint("run_id", "record_id", name="uq_report_run_rows_record"),
    )
    op.create_index("ix_report_run_rows_record", "report_run_rows", ["record_id"], unique=False)
    op.create_table(
        "sandbox_bindings",
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("sandbox_id", sa.String(length=1000), nullable=False),
        sa.Column("department_id", sa.UUID(), nullable=True),
        sa.Column("module_id", sa.UUID(), nullable=True),
        sa.Column("field_id", sa.UUID(), nullable=True),
        sa.Column("trigger_id", sa.UUID(), nullable=True),
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
            (
                "(kind = 'department' AND department_id IS NO"
                "T NULL AND module_id IS NULL AND field_id IS"
                " NULL AND trigger_id IS NULL) OR (kind = 'mo"
                "dule' AND department_id IS NULL AND module_i"
                "d IS NOT NULL AND field_id IS NULL AND trigg"
                "er_id IS NULL) OR (kind IN ('field', 'relati"
                "onship') AND department_id IS NULL AND modul"
                "e_id IS NULL AND field_id IS NOT NULL AND tr"
                "igger_id IS NULL) OR (kind = 'trigger' AND d"
                "epartment_id IS NULL AND module_id IS NULL A"
                "ND field_id IS NULL AND trigger_id IS NOT NU"
                "LL)"
            ),
            name="ck_sandbox_bindings_exactly_one_live_target",
        ),
        sa.CheckConstraint(
            "kind IN ('department', 'module', 'field', 'relationship', 'trigger')",
            name="ck_sandbox_bindings_kind",
        ),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_sandbox_bindings_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["field_id"],
            ["fields.id"],
            name=op.f("fk_sandbox_bindings_field_id_fields"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_sandbox_bindings_module_id_modules"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_bindings_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["trigger_id"],
            ["record_triggers.id"],
            name=op.f("fk_sandbox_bindings_trigger_id_record_triggers"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_bindings_pkey")),
        sa.UniqueConstraint("department_id", name="uq_sandbox_bindings_department_id"),
        sa.UniqueConstraint("field_id", name="uq_sandbox_bindings_field_id"),
        sa.UniqueConstraint("kind", "sandbox_id", name="uq_sandbox_bindings_kind_sandbox_id"),
        sa.UniqueConstraint("module_id", name="uq_sandbox_bindings_module_id"),
        sa.UniqueConstraint("trigger_id", name="uq_sandbox_bindings_trigger_id"),
    )
    op.create_table(
        "scheduled_work",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "kind", sa.String(length=24), server_default=sa.text("'report-run'"), nullable=False
        ),
        sa.Column("report_id", sa.UUID(), nullable=True),
        sa.Column("post_id", sa.UUID(), nullable=True),
        sa.Column("reminder_id", sa.UUID(), nullable=True),
        sa.Column("source_revision", sa.Integer(), nullable=True),
        sa.Column("scheduling_actor_id", sa.UUID(), nullable=True),
        sa.Column("publication_result_id", sa.UUID(), nullable=True),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("run_id", sa.UUID(), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("occurrence_start_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            (
                "(kind = 'report-run' AND ((state = 'succeede"
                "d' AND run_id IS NOT NULL) OR (state <> 'suc"
                "ceeded' AND run_id IS NULL))) OR (kind = 'po"
                "st-publish' AND ((state = 'succeeded' AND pu"
                "blication_result_id IS NOT NULL) OR (state <"
                "> 'succeeded' AND publication_result_id IS N"
                "ULL))) OR (kind = 'event-reminder' AND run_i"
                "d IS NULL AND publication_result_id IS NULL)"
            ),
            name="ck_scheduled_work_run",
        ),
        sa.CheckConstraint(
            (
                "(kind = 'report-run' AND report_id IS NOT NU"
                "LL AND post_id IS NULL AND reminder_id IS NU"
                "LL AND occurrence_start_at IS NULL AND sourc"
                "e_revision IS NULL AND scheduling_actor_id I"
                "S NULL AND publication_result_id IS NULL) OR"
                " (kind = 'post-publish' AND report_id IS NUL"
                "L AND reminder_id IS NULL AND occurrence_sta"
                "rt_at IS NULL AND post_id IS NOT NULL AND so"
                "urce_revision IS NOT NULL AND source_revisio"
                "n > 0 AND scheduling_actor_id IS NOT NULL AN"
                "D run_id IS NULL) OR (kind = 'event-reminder"
                "' AND report_id IS NULL AND post_id IS NULL "
                "AND reminder_id IS NOT NULL AND occurrence_s"
                "tart_at IS NOT NULL AND source_revision IS N"
                "ULL AND scheduling_actor_id IS NULL AND publ"
                "ication_result_id IS NULL AND run_id IS NULL"
                ")"
            ),
            name="ck_scheduled_work_source",
        ),
        sa.CheckConstraint(
            (
                "(state = 'running' AND lease_token IS NOT NU"
                "LL AND lease_expires_at IS NOT NULL) OR (sta"
                "te <> 'running' AND lease_token IS NULL AND "
                "lease_expires_at IS NULL)"
            ),
            name="ck_scheduled_work_lease",
        ),
        sa.CheckConstraint(
            "kind IN ('report-run', 'post-publish', 'event-reminder')",
            name="ck_scheduled_work_kind",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'failed', 'canceled')",
            name="ck_scheduled_work_state",
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5", name="ck_scheduled_work_attempt_count"
        ),
        sa.ForeignKeyConstraint(
            ["post_id"],
            ["board_posts.id"],
            name=op.f("fk_scheduled_work_post_id_board_posts"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["publication_result_id"],
            ["board_post_revisions.id"],
            name=op.f("fk_scheduled_work_publication_result_id_board_post_revisions"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["reminder_id"],
            ["board_event_reminders.id"],
            name=op.f("fk_scheduled_work_reminder_id_board_event_reminders"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["reports.id"],
            name=op.f("fk_scheduled_work_report_id_reports"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["report_runs.id"],
            name=op.f("fk_scheduled_work_run_id_report_runs"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["scheduling_actor_id"],
            ["users.id"],
            name=op.f("fk_scheduled_work_scheduling_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("scheduled_work_pkey")),
        sa.UniqueConstraint("post_id", "source_revision", name="uq_scheduled_work_post_occurrence"),
        sa.UniqueConstraint(
            "reminder_id", "occurrence_start_at", name="uq_scheduled_work_reminder"
        ),
        sa.UniqueConstraint(
            "report_id", "scheduled_for", name="uq_scheduled_work_report_occurrence"
        ),
        sa.UniqueConstraint("run_id", name="uq_scheduled_work_run"),
    )
    op.create_index(
        "ix_scheduled_work_due",
        "scheduled_work",
        ["kind", "state", "next_attempt_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_expired",
        "scheduled_work",
        ["kind", "state", "lease_expires_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_publication_result_id",
        "scheduled_work",
        ["publication_result_id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_scheduling_actor_id",
        "scheduled_work",
        ["scheduling_actor_id"],
        unique=False,
    )
    op.create_table(
        "in_app_notifications",
        sa.Column("work_id", sa.UUID(), nullable=False),
        sa.Column("recipient_id", sa.UUID(), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
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
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_in_app_notifications_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["recipient_id"],
            ["users.id"],
            name=op.f("fk_in_app_notifications_recipient_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["work_id"],
            ["scheduled_work.id"],
            name=op.f("fk_in_app_notifications_work_id_scheduled_work"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("in_app_notifications_pkey")),
        sa.UniqueConstraint(
            "work_id", "recipient_id", name="uq_in_app_notifications_work_recipient"
        ),
    )
    op.create_index(
        "ix_in_app_notifications_recipient_created",
        "in_app_notifications",
        ["recipient_id", "created_at", "id"],
        unique=False,
    )
    op.create_table(
        "record_trigger_runs",
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("trigger_id", sa.UUID(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "state IN ('succeeded', 'skipped', 'suspended', 'failed')",
            name="ck_record_trigger_runs_state",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["record_trigger_events.id"],
            name=op.f("fk_record_trigger_runs_event_id_record_trigger_events"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["trigger_id"],
            ["record_triggers.id"],
            name=op.f("fk_record_trigger_runs_trigger_id_record_triggers"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_runs_pkey")),
        sa.UniqueConstraint("event_id", "trigger_id", name="uq_record_trigger_runs_event_trigger"),
    )
    op.create_index(
        "ix_record_trigger_runs_created", "record_trigger_runs", ["created_at", "id"], unique=False
    )
    op.create_index(
        op.f("ix_record_trigger_runs_trigger_id"),
        "record_trigger_runs",
        ["trigger_id"],
        unique=False,
    )
    # Postgres omits use_alter constraints from CREATE TABLE; add them after all tables exist.
    for (
        name,
        table,
        target_table,
        local_columns,
        target_columns,
        ondelete,
    ) in USE_ALTER_FOREIGN_KEYS:
        op.create_foreign_key(
            op.f(name),
            table,
            target_table,
            list(local_columns),
            list(target_columns),
            ondelete=ondelete,
        )

    # Final custom DDL and ACLs are reconciled from the captured a58a6c1f2e72 chain.
    op.execute(
        "CREATE FUNCTION public.board_record_link_guard() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "    DECLARE owner_board uuid; source_module uuid;\n"
        "    BEGIN\n"
        "        IF TG_OP = 'UPDATE' AND (\n"
        "            OLD.board_id IS DISTINCT FROM NEW.board_id OR\n"
        "            OLD.event_id IS DISTINCT FROM NEW.event_id OR\n"
        "            OLD.post_id IS DISTINCT FROM NEW.post_id OR\n"
        "            OLD.record_id IS DISTINCT FROM NEW.record_id OR\n"
        "            OLD.module_id IS DISTINCT FROM NEW.module_id\n"
        "        ) THEN\n"
        "            RAISE EXCEPTION 'Board Record li"
        "nk owner is immutable' USING ERRCODE = '2351"
        "4';\n"
        "        END IF;\n"
        "        IF NEW.event_id IS NOT NULL THEN\n"
        "            SELECT board_id INTO owner_board FROM board_events WHERE id = NEW.event_id;\n"
        "        ELSE\n"
        "            SELECT board_id INTO owner_board FROM board_posts WHERE id = NEW.post_id;\n"
        "        END IF;\n"
        "        SELECT module_id INTO source_module FROM records WHERE id = NEW.record_id;\n"
        "        IF owner_board IS DISTINCT FROM NEW.board_id OR\n"
        "           source_module IS DISTINCT FROM NEW.module_id THEN\n"
        "            RAISE EXCEPTION 'Board Record link parent mismatch' USING ERRCODE = '23514';\n"
        "        END IF;\n"
        "        RETURN NEW;\n"
        "    END;\n"
        "    $$;\n"
    )
    op.execute(
        "CREATE FUNCTION public.board_revision_record_link_guard() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "        DECLARE source_module uuid; current_link uuid;\n"
        "        BEGIN\n"
        "            IF TG_OP = 'UPDATE' THEN\n"
        "                RAISE EXCEPTION 'Published Board Record links are immutable'\n"
        "                    USING ERRCODE = '23514';\n"
        "            END IF;\n"
        "            SELECT module_id INTO source_mod"
        "ule FROM public.records WHERE id = NEW.recor"
        "d_id;\n"
        "            SELECT link.id INTO current_link\n"
        "              FROM public.board_record_links AS link\n"
        "              JOIN public.board_post_revisions AS revision\n"
        "                ON revision.post_id = link.post_id\n"
        "             WHERE revision.id = NEW.revision_id\n"
        "               AND link.record_id = NEW.record_id\n"
        "               AND link.module_id = NEW.module_id;\n"
        "            IF source_module IS DISTINCT FROM NEW.module_id OR current_link IS NULL THEN\n"
        "                RAISE EXCEPTION 'Published Board Record link parent mismatch'\n"
        "                    USING ERRCODE = '23514';\n"
        "            END IF;\n"
        "            RETURN NEW;\n"
        "        END;\n"
        "        $$;\n"
    )
    op.execute(
        "CREATE FUNCTION public.reject_board_attachment_owner_change() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "    BEGIN\n"
        "        IF OLD.board_id IS DISTINCT FROM NEW.board_id\n"
        "            OR OLD.file_id IS DISTINCT FROM NEW.file_id\n"
        "            OR OLD.event_id IS DISTINCT FROM NEW.event_id\n"
        "            OR OLD.post_id IS DISTINCT FROM NEW.post_id THEN\n"
        "            RAISE EXCEPTION 'board file content owner is immutable'\n"
        "                USING ERRCODE = 'check_violation';\n"
        "        END IF;\n"
        "        RETURN NEW;\n"
        "    END;\n"
        "    $$;\n"
    )
    op.execute(
        "CREATE FUNCTION public.reject_board_post_revision_update() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "    BEGIN\n"
        "        RAISE EXCEPTION 'published post revisions are immutable'\n"
        "            USING ERRCODE = 'check_violation';\n"
        "    END;\n"
        "    $$;\n"
    )
    op.execute(
        "CREATE FUNCTION public.reject_file_board_move() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "        BEGIN\n"
        "            IF OLD.board_id IS DISTINCT FROM NEW.board_id THEN\n"
        "                RAISE EXCEPTION 'file board ownership is immutable'\n"
        "                    USING ERRCODE = 'check_violation';\n"
        "            END IF;\n"
        "            RETURN NEW;\n"
        "        END;\n"
        "        $$;\n"
    )
    op.execute(
        "CREATE FUNCTION public.reject_revision_attachment_update() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "        BEGIN\n"
        "            RAISE EXCEPTION 'published attachment snapshots are immutable'\n"
        "                USING ERRCODE = 'check_violation';\n"
        "        END;\n"
        "        $$;\n"
    )
    op.execute(
        "CREATE FUNCTION public.validate_board_attachment() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "    DECLARE content_board uuid;\n"
        "    BEGIN\n"
        "        IF NOT EXISTS (\n"
        "            SELECT 1 FROM files AS f WHERE f.id = NEW.file_id\n"
        "            AND f.board_id = NEW.board_id AND f.purpose = 'board_attachment'\n"
        "        ) THEN\n"
        "            RAISE EXCEPTION 'file does not belong to owning board'\n"
        "                USING ERRCODE = 'check_violation';\n"
        "        END IF;\n"
        "        IF NEW.event_id IS NOT NULL THEN\n"
        "            SELECT board_id INTO content_boa"
        "rd FROM board_events WHERE id = NEW.event_id"
        ";\n"
        "        ELSE\n"
        "            SELECT board_id INTO content_board FROM board_posts WHERE id = NEW.post_id;\n"
        "        END IF;\n"
        "        IF content_board IS DISTINCT FROM NEW.board_id THEN\n"
        "            RAISE EXCEPTION 'content does not belong to owning board'\n"
        "                USING ERRCODE = 'check_violation';\n"
        "        END IF;\n"
        "        RETURN NEW;\n"
        "    END;\n"
        "    $$;\n"
    )
    op.execute(
        "CREATE FUNCTION public.validate_revision_attachment() RETURNS trigger\n"
        "    LANGUAGE plpgsql\n"
        "    AS $$\n"
        "    DECLARE content_id uuid;\n"
        "    BEGIN\n"
        "        SELECT post_id INTO content_id FROM board_post_revisions\n"
        "        WHERE id = NEW.revision_id;\n"
        "        IF NOT EXISTS (\n"
        "            SELECT 1 FROM board_attachments AS a\n"
        "            WHERE a.file_id = NEW.file_id AND a.post_id = content_id\n"
        "        ) THEN\n"
        "            RAISE EXCEPTION 'published file has a different content owner'\n"
        "                USING ERRCODE = 'check_violation';\n"
        "        END IF;\n"
        "        RETURN NEW;\n"
        "    END;\n"
        "    $$;\n"
    )
    for trigger in (
        (
            "board_record_link_guard_trigger BEFORE INSER"
            "T OR UPDATE ON public.board_record_links FOR"
            " EACH ROW EXECUTE FUNCTION public.board_reco"
            "rd_link_guard()"
        ),
        (
            "board_revision_record_link_guard_trigger BEF"
            "ORE INSERT OR UPDATE ON public.board_post_re"
            "vision_record_links FOR EACH ROW EXECUTE FUN"
            "CTION public.board_revision_record_link_guar"
            "d()"
        ),
        (
            "trg_board_attachment_immutable BEFORE UPDATE"
            " ON public.board_attachments FOR EACH ROW EX"
            "ECUTE FUNCTION public.reject_board_attachmen"
            "t_owner_change()"
        ),
        (
            "trg_board_attachment_owner BEFORE INSERT OR "
            "UPDATE ON public.board_attachments FOR EACH "
            "ROW EXECUTE FUNCTION public.validate_board_a"
            "ttachment()"
        ),
        (
            "trg_board_post_revisions_immutable BEFORE UP"
            "DATE ON public.board_post_revisions FOR EACH"
            " ROW EXECUTE FUNCTION public.reject_board_po"
            "st_revision_update()"
        ),
        (
            "trg_board_revision_attachment_immutable BEFO"
            "RE UPDATE ON public.board_post_revision_atta"
            "chments FOR EACH ROW EXECUTE FUNCTION public"
            ".reject_revision_attachment_update()"
        ),
        (
            "trg_board_revision_attachment_owner BEFORE I"
            "NSERT ON public.board_post_revision_attachme"
            "nts FOR EACH ROW EXECUTE FUNCTION public.val"
            "idate_revision_attachment()"
        ),
        (
            "trg_files_board_immutable BEFORE UPDATE ON p"
            "ublic.files FOR EACH ROW EXECUTE FUNCTION pu"
            "blic.reject_file_board_move()"
        ),
    ):
        op.execute(f"CREATE TRIGGER {trigger}")

    # Match the final chain seeds: workspace singleton, empty v4 Sandbox, Company Board.
    op.execute(
        "INSERT INTO public.workspace_profiles "
        "(id, display_name, timezone, locale) "
        "VALUES ('00000000-0000-7000-8000-000000000003', 'OpenSlate', 'UTC', 'en-US')"
    )
    op.execute(
        sa.text(
            "INSERT INTO public.sandbox_documents "
            "(id, singleton_key, schema_version, revision, document, content_hash, byte_count) "
            "VALUES (CAST(:id AS uuid), true, 4, 1, CAST(:document AS jsonb), "
            ":content_hash, :byte_count)"
        ).bindparams(
            id="00000000-0000-7000-8000-000000000005",
            document=(
                '{"design":{"departments":[],"layout":{},"modules":[],"relationships":[]},'
                '"kind":"openslate-sandbox","scenarios":[],"schemaVersion":4,"triggers":[]}'
            ),
            content_hash="04f9b3ef33555fb4855ca982ae27408d5842b936e1b730190c8cb5a472ae57d3",
            byte_count=147,
        )
    )
    op.get_bind().execute(
        sa.text(
            "INSERT INTO public.boards (id, scope, department_id, name, status) "
            "VALUES (:id, :scope, :department_id, :name, :status)"
        ),
        {
            "id": uuid7(),
            "scope": "company",
            "department_id": None,
            "name": "Company",
            "status": "active",
        },
    )

    # Match the final app-role table grants; keep audit and security rows append-only.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "
        + ", ".join(
            f"public.{table}"
            for table in (
                "board_attachments",
                "board_event_reminders",
                "board_events",
                "board_groups",
                "board_post_revision_attachments",
                "board_post_revision_record_links",
                "board_post_revisions",
                "board_posts",
                "board_record_links",
                "board_widgets",
                "boards",
                "dashboard_widgets",
            )
        )
        + " TO openslate_app"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "
        + ", ".join(
            f"public.{table}"
            for table in (
                "dashboards",
                "departments",
                "fields",
                "files",
                "group_access",
                "group_members",
                "groups",
                "identity_rate_limit_buckets",
                "identity_sessions",
                "in_app_notifications",
                "lifecycle_confirmation_challenges",
                "lifecycle_rate_limit_buckets",
            )
        )
        + " TO openslate_app"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "
        + ", ".join(
            f"public.{table}"
            for table in (
                "lifecycle_rate_limit_failures",
                "modules",
                "record_trigger_actions",
                "record_trigger_conditions",
                "record_trigger_events",
                "record_trigger_runs",
                "record_triggers",
                "records",
                "relationship_edges",
                "report_run_eligible_users",
                "report_run_rows",
                "report_runs",
            )
        )
        + " TO openslate_app"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "
        + ", ".join(
            f"public.{table}"
            for table in (
                "report_schedules",
                "reports",
                "sandbox_bindings",
                "sandbox_documents",
                "sandbox_publications",
                "sandbox_test_runs",
                "sandbox_versions",
                "saved_views",
                "scheduled_work",
                "users",
                "workspace_profiles",
            )
        )
        + " TO openslate_app"
    )
    op.execute(
        "GRANT SELECT, INSERT ON TABLE public.audit_logs, public.security_events TO openslate_app"
    )
    op.execute(
        "REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs, public.security_events "
        "FROM openslate_app"
    )
    op.execute(
        "REVOKE ALL ON TABLE public.alembic_version FROM PUBLIC, anon, authenticated, service_role"
    )
    op.execute("GRANT SELECT ON TABLE public.alembic_version TO openslate_app")
    op.execute(
        "REVOKE ALL ON FUNCTION "
        + ", ".join(
            f"public.{name}()"
            for name in (
                "board_record_link_guard",
                "board_revision_record_link_guard",
                "reject_board_attachment_owner_change",
                "reject_board_post_revision_update",
                "reject_file_board_move",
                "reject_revision_attachment_update",
                "validate_board_attachment",
                "validate_revision_attachment",
            )
        )
        + " FROM PUBLIC, anon, authenticated, service_role"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        + ", ".join(
            f"public.{name}()"
            for name in (
                "board_record_link_guard",
                "board_revision_record_link_guard",
                "reject_board_attachment_owner_change",
                "reject_board_post_revision_update",
                "reject_file_board_move",
                "reject_revision_attachment_update",
                "validate_board_attachment",
                "validate_revision_attachment",
            )
        )
        + " TO openslate_app"
    )

    # Keep the documented owner default privileges for future application objects.
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE openslate_owner IN SCHEMA public "
        "REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role"
    )
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE openslate_owner IN SCHEMA public "
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openslate_app"
    )
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE openslate_owner IN SCHEMA public "
        "REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role"
    )
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE openslate_owner IN SCHEMA public "
        "GRANT USAGE, SELECT ON SEQUENCES TO openslate_app"
    )
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE openslate_owner "
        "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role"
    )
    # ### end Alembic commands ###


def downgrade() -> None:
    # Remove deferred links before generated table drops, including modules -> fields.
    for name, table, *_ in USE_ALTER_FOREIGN_KEYS:
        op.drop_constraint(op.f(name), table, type_="foreignkey")
    for trigger_name, table_name in (
        ("board_record_link_guard_trigger", "board_record_links"),
        ("board_revision_record_link_guard_trigger", "board_post_revision_record_links"),
        ("trg_board_attachment_immutable", "board_attachments"),
        ("trg_board_attachment_owner", "board_attachments"),
        ("trg_board_post_revisions_immutable", "board_post_revisions"),
        ("trg_board_revision_attachment_immutable", "board_post_revision_attachments"),
        ("trg_board_revision_attachment_owner", "board_post_revision_attachments"),
        ("trg_files_board_immutable", "files"),
    ):
        op.execute(f"DROP TRIGGER {trigger_name} ON public.{table_name}")
    for function_name in (
        "board_record_link_guard",
        "board_revision_record_link_guard",
        "reject_board_attachment_owner_change",
        "reject_board_post_revision_update",
        "reject_file_board_move",
        "reject_revision_attachment_update",
        "validate_board_attachment",
        "validate_revision_attachment",
    ):
        op.execute(f"DROP FUNCTION public.{function_name}()")
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f("ix_record_trigger_runs_trigger_id"), table_name="record_trigger_runs")
    op.drop_index("ix_record_trigger_runs_created", table_name="record_trigger_runs")
    op.drop_table("record_trigger_runs")
    op.drop_index("ix_in_app_notifications_recipient_created", table_name="in_app_notifications")
    op.drop_table("in_app_notifications")
    op.drop_index("ix_scheduled_work_scheduling_actor_id", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_publication_result_id", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_expired", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_due", table_name="scheduled_work")
    op.drop_table("scheduled_work")
    op.drop_table("sandbox_bindings")
    op.drop_index("ix_report_run_rows_record", table_name="report_run_rows")
    op.drop_table("report_run_rows")
    op.drop_index("ix_report_run_eligible_users_user_run", table_name="report_run_eligible_users")
    op.drop_table("report_run_eligible_users")
    op.drop_index(
        op.f("ix_record_trigger_events_scheduled_trigger_id"), table_name="record_trigger_events"
    )
    op.drop_index(
        op.f("ix_record_trigger_events_root_event_id"), table_name="record_trigger_events"
    )
    op.drop_index(op.f("ix_record_trigger_events_record_id"), table_name="record_trigger_events")
    op.drop_index(op.f("ix_record_trigger_events_module_id"), table_name="record_trigger_events")
    op.drop_index("ix_record_trigger_events_due", table_name="record_trigger_events")
    op.drop_table("record_trigger_events")
    op.drop_index(
        "uq_record_trigger_conditions_position_active",
        table_name="record_trigger_conditions",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        op.f("ix_record_trigger_conditions_value_field_id"), table_name="record_trigger_conditions"
    )
    op.drop_index(
        op.f("ix_record_trigger_conditions_trigger_id"), table_name="record_trigger_conditions"
    )
    op.drop_index(
        op.f("ix_record_trigger_conditions_field_id"), table_name="record_trigger_conditions"
    )
    op.drop_table("record_trigger_conditions")
    op.drop_index(
        "uq_record_trigger_actions_position_active",
        table_name="record_trigger_actions",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        op.f("ix_record_trigger_actions_value_field_id"), table_name="record_trigger_actions"
    )
    op.drop_index(op.f("ix_record_trigger_actions_trigger_id"), table_name="record_trigger_actions")
    op.drop_index(
        op.f("ix_record_trigger_actions_target_field_id"), table_name="record_trigger_actions"
    )
    op.drop_table("record_trigger_actions")
    op.drop_index(
        "ix_board_revision_record_links_record_id", table_name="board_post_revision_record_links"
    )
    op.drop_index(
        "ix_board_revision_record_links_module_id", table_name="board_post_revision_record_links"
    )
    op.drop_table("board_post_revision_record_links")
    op.drop_index(
        "ix_board_post_revision_attachments_file_id", table_name="board_post_revision_attachments"
    )
    op.drop_table("board_post_revision_attachments")
    op.drop_index("ix_board_attachments_post_id", table_name="board_attachments")
    op.drop_index("ix_board_attachments_event_id", table_name="board_attachments")
    op.drop_index("ix_board_attachments_board_id", table_name="board_attachments")
    op.drop_table("board_attachments")
    op.drop_index("ix_report_schedules_due", table_name="report_schedules")
    op.drop_table("report_schedules")
    op.drop_index("ix_report_runs_report_created", table_name="report_runs")
    op.drop_index("ix_report_runs_module", table_name="report_runs")
    op.drop_table("report_runs")
    op.drop_index(
        "uq_relationship_edges_active",
        table_name="relationship_edges",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        "ix_relationship_edges_active_target",
        table_name="relationship_edges",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        "ix_relationship_edges_active_source",
        table_name="relationship_edges",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("relationship_edges")
    op.drop_index(op.f("ix_record_triggers_trigger_value_field_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_trigger_field_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_publisher_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_published_version_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_publication_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_module_id"), table_name="record_triggers")
    op.drop_index("ix_record_triggers_module", table_name="record_triggers")
    op.drop_table("record_triggers")
    op.drop_index(
        "ix_files_scan_due",
        table_name="files",
        postgresql_where=sa.text("state = 'pending_scan' AND operation_id IS NULL"),
    )
    op.drop_index(op.f("ix_files_record_id"), table_name="files")
    op.drop_index(op.f("ix_files_purpose"), table_name="files")
    op.drop_index(op.f("ix_files_creator_id"), table_name="files")
    op.drop_index(op.f("ix_files_board_id"), table_name="files")
    op.drop_table("files")
    op.drop_index("ix_board_record_links_record_id", table_name="board_record_links")
    op.drop_index("ix_board_record_links_module_id", table_name="board_record_links")
    op.drop_index("ix_board_record_links_board_id", table_name="board_record_links")
    op.drop_table("board_record_links")
    op.drop_index("ix_board_post_revisions_author_id", table_name="board_post_revisions")
    op.drop_table("board_post_revisions")
    op.drop_index("ix_board_event_reminders_board_id", table_name="board_event_reminders")
    op.drop_table("board_event_reminders")
    op.drop_index(
        "uq_saved_views_module_default",
        table_name="saved_views",
        postgresql_where=sa.text("is_default AND NOT is_deleted"),
    )
    op.drop_index(op.f("ix_saved_views_module_id"), table_name="saved_views")
    op.drop_table("saved_views")
    op.drop_index(op.f("ix_sandbox_publications_document_id"), table_name="sandbox_publications")
    op.drop_index("ix_sandbox_publications_document_created", table_name="sandbox_publications")
    op.drop_index(op.f("ix_sandbox_publications_actor_id"), table_name="sandbox_publications")
    op.drop_table("sandbox_publications")
    op.drop_index("ix_reports_module", table_name="reports")
    op.drop_table("reports")
    op.drop_index(op.f("ix_records_module_id"), table_name="records")
    op.drop_table("records")
    op.drop_index(
        "uq_group_access_target_active",
        table_name="group_access",
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_group_access_module_id", table_name="group_access")
    op.drop_index(
        "ix_group_access_department_module_active",
        table_name="group_access",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("group_access")
    op.drop_index(
        "uq_fields_module_position_active",
        table_name="fields",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        "uq_fields_module_name_active",
        table_name="fields",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_fields_relationship_target_module_id", table_name="fields")
    op.drop_index(op.f("ix_fields_module_id"), table_name="fields")
    op.drop_table("fields")
    op.drop_index(
        "uq_dashboard_widgets_active_position",
        table_name="dashboard_widgets",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_dashboard_widgets_dashboard_id", table_name="dashboard_widgets")
    op.drop_table("dashboard_widgets")
    op.drop_index("ix_board_widgets_module_id", table_name="board_widgets")
    op.drop_table("board_widgets")
    op.drop_index("ix_board_posts_board_id", table_name="board_posts")
    op.drop_index("ix_board_posts_author_id", table_name="board_posts")
    op.drop_table("board_posts")
    op.drop_index(
        "uq_board_groups_board_group_active",
        table_name="board_groups",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_board_groups_group_id", table_name="board_groups")
    op.drop_table("board_groups")
    op.drop_index("ix_board_events_board_id", table_name="board_events")
    op.drop_index("ix_board_events_author_id", table_name="board_events")
    op.drop_table("board_events")
    op.drop_index("ix_sandbox_versions_source_version", table_name="sandbox_versions")
    op.drop_table("sandbox_versions")
    op.drop_index("ix_sandbox_test_runs_document_created", table_name="sandbox_test_runs")
    op.drop_table("sandbox_test_runs")
    op.drop_index(
        "uq_modules_department_name_active",
        table_name="modules",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(op.f("ix_modules_title_field_id"), table_name="modules")
    op.drop_index(op.f("ix_modules_department_id"), table_name="modules")
    op.drop_table("modules")
    op.drop_index(
        "ix_lifecycle_rate_limit_failures_actor_occurred",
        table_name="lifecycle_rate_limit_failures",
    )
    op.drop_table("lifecycle_rate_limit_failures")
    op.drop_table("lifecycle_rate_limit_buckets")
    op.drop_table("lifecycle_confirmation_challenges")
    op.drop_index("ix_identity_sessions_user_active", table_name="identity_sessions")
    op.drop_table("identity_sessions")
    op.drop_index(op.f("ix_group_members_user_id"), table_name="group_members")
    op.drop_table("group_members")
    op.drop_index("ix_dashboards_department_position", table_name="dashboards")
    op.drop_table("dashboards")
    op.drop_index(
        "uq_boards_department",
        table_name="boards",
        postgresql_where=sa.text("scope = 'department' AND NOT is_deleted"),
    )
    op.drop_index(
        "uq_boards_company",
        table_name="boards",
        postgresql_where=sa.text("scope = 'company' AND NOT is_deleted"),
    )
    op.drop_index(op.f("ix_boards_department_id"), table_name="boards")
    op.drop_table("boards")
    op.drop_table("workspace_profiles")
    op.drop_index(op.f("ix_users_username"), table_name="users")
    op.drop_index(op.f("ix_users_supabase_user_id"), table_name="users")
    op.drop_index(op.f("ix_users_sponsor_user_id"), table_name="users")
    op.drop_index(op.f("ix_users_email"), table_name="users")
    op.drop_table("users")
    op.drop_index("ix_security_events_operation_id", table_name="security_events")
    op.drop_index("ix_security_events_occurred_at_id", table_name="security_events")
    op.drop_table("security_events")
    op.drop_table("sandbox_documents")
    op.drop_index(
        op.f("ix_identity_rate_limit_buckets_window_started_at"),
        table_name="identity_rate_limit_buckets",
    )
    op.drop_table("identity_rate_limit_buckets")
    op.drop_index(
        "uq_groups_name_active_ci",
        table_name="groups",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("groups")
    op.drop_index(
        "uq_departments_name_active",
        table_name="departments",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("departments")
    op.drop_index("ix_audit_logs_request", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity", table_name="audit_logs")
    op.drop_index("ix_audit_logs_department_created_at_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_created_at_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_table("audit_logs")
    # ### end Alembic commands ###
