"""organization schema fresh root

Revision ID: 8db89b6c6c35
Revises:
Create Date: 2026-10-15 17:52:56.796218
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "8db89b6c6c35"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


APPLICATION_TABLES = (
    "audit_logs backup_export_operations backup_policies backup_runs board_attachments "
    "board_event_reminders board_events board_groups board_post_revision_attachments "
    "board_post_revision_record_links board_post_revisions board_posts board_record_links "
    "board_widgets boards charts dashboard_widgets dashboards departments fields files "
    "group_access group_members groups identity_mfa_observations identity_rate_limit_buckets "
    "identity_sessions in_app_notifications lifecycle_confirmation_challenges "
    "lifecycle_rate_limit_buckets lifecycle_rate_limit_failures memberships modules organizations "
    "platform_operators platform_settings record_trigger_actions record_trigger_conditions "
    "record_trigger_events record_trigger_runs record_triggers records relationship_edges "
    "report_run_eligible_users report_run_rows report_runs report_schedules reports "
    "sandbox_bindings sandbox_documents sandbox_publications sandbox_test_runs sandbox_versions "
    "saved_views scheduled_work security_events update_statuses users"
).split()
ATTRIBUTION_TABLES = (
    "audit_logs backup_export_operations backup_policies backup_runs board_attachments "
    "board_event_reminders board_events board_groups board_post_revision_attachments "
    "board_post_revision_record_links board_post_revisions board_posts board_record_links "
    "board_widgets boards charts dashboard_widgets dashboards departments fields files "
    "group_access group_members groups in_app_notifications memberships modules organizations "
    "platform_operators platform_settings record_trigger_actions record_trigger_conditions "
    "record_trigger_events record_trigger_runs record_triggers records relationship_edges "
    "report_run_rows report_runs report_schedules reports sandbox_bindings sandbox_documents "
    "sandbox_publications sandbox_test_runs sandbox_versions saved_views update_statuses users"
).split()
# Alembic renders use_alter declarations but does not emit their later CREATEs.
# This frozen inventory comes from the registered models used for autogeneration.
DEFERRED_FOREIGN_KEYS = tuple(
    (f"fk_{table}_performed_by_users", table, "users", ["performed_by"], ["id"], "SET NULL")
    for table in ATTRIBUTION_TABLES
) + (
    (
        "fk_modules_title_field_id_fields",
        "modules",
        "fields",
        ["org_id", "title_field_id"],
        ["org_id", "id"],
        "RESTRICT",
    ),
    (
        "fk_organizations_logo_file_id_files",
        "organizations",
        "files",
        ["id", "logo_file_id"],
        ["org_id", "id"],
        "RESTRICT",
    ),
    (
        "fk_record_trigger_events_root_event_id_record_trigger_events",
        "record_trigger_events",
        "record_trigger_events",
        ["org_id", "root_event_id"],
        ["org_id", "id"],
        "RESTRICT",
    ),
    (
        "fk_record_triggers_publisher_id_users",
        "record_triggers",
        "users",
        ["publisher_id"],
        ["id"],
        "RESTRICT",
    ),
    (
        "fk_sandbox_publications_actor_id_users",
        "sandbox_publications",
        "users",
        ["actor_id"],
        ["id"],
        "RESTRICT",
    ),
    (
        "fk_sandbox_versions_source_version_id_sandbox_versions",
        "sandbox_versions",
        "sandbox_versions",
        ["org_id", "source_version_id"],
        ["org_id", "id"],
        "RESTRICT",
    ),
    (
        "fk_users_avatar_file_id_files",
        "users",
        "files",
        ["avatar_file_id"],
        ["id"],
        "SET NULL",
    ),
)
BOARD_TRIGGERS = (
    (
        "board_record_link_guard_trigger",
        "board_record_links",
        "INSERT OR UPDATE",
        "board_record_link_guard",
    ),
    (
        "board_revision_record_link_guard_trigger",
        "board_post_revision_record_links",
        "INSERT OR UPDATE",
        "board_revision_record_link_guard",
    ),
    (
        "trg_board_attachment_immutable",
        "board_attachments",
        "UPDATE",
        "reject_board_attachment_owner_change",
    ),
    (
        "trg_board_attachment_owner",
        "board_attachments",
        "INSERT OR UPDATE",
        "validate_board_attachment",
    ),
    (
        "trg_board_post_revisions_immutable",
        "board_post_revisions",
        "UPDATE",
        "reject_board_post_revision_update",
    ),
    (
        "trg_board_revision_attachment_immutable",
        "board_post_revision_attachments",
        "UPDATE",
        "reject_revision_attachment_update",
    ),
    (
        "trg_board_revision_attachment_owner",
        "board_post_revision_attachments",
        "INSERT",
        "validate_revision_attachment",
    ),
    ("trg_files_board_immutable", "files", "UPDATE", "reject_file_board_move"),
)


def upgrade() -> None:
    op.execute("""
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
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "backup_policies",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("installation_id", sa.String(length=63), nullable=False),
        sa.Column("schedule", sa.String(length=8), server_default="disabled", nullable=False),
        sa.Column("retention_days", sa.Integer(), server_default=sa.text("30"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("next_due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("runner_last_seen_at", sa.DateTime(timezone=True), nullable=True),
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
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_policies_identity"
        ),
        sa.CheckConstraint(
            "schedule <> 'disabled' OR next_due_at IS NULL", name="ck_backup_policies_disabled_due"
        ),
        sa.CheckConstraint(
            "schedule IN ('disabled','daily','weekly')", name="ck_backup_policies_schedule"
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_policies_live"),
        sa.CheckConstraint("retention_days IN (7,30,90)", name="ck_backup_policies_retention"),
        sa.CheckConstraint("revision >= 1", name="ck_backup_policies_revision"),
        sa.CheckConstraint("singleton_key = true", name="ck_backup_policies_singleton"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_backup_policies_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("backup_policies_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_backup_policies_singleton"),
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
        "organizations",
        sa.Column("slug", sa.String(length=200), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("legal_name", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("contact_email", sa.String(length=254), nullable=True),
        sa.Column("contact_phone", sa.String(length=50), nullable=True),
        sa.Column("postal_address", sa.Text(), nullable=True),
        sa.Column("logo_file_id", sa.Uuid(), nullable=True),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("locale", sa.String(length=35), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default=sa.text("'PHP'"), nullable=False),
        sa.Column(
            "week_start", sa.String(length=6), server_default=sa.text("'monday'"), nullable=False
        ),
        sa.Column(
            "business_hours",
            sa.String(length=200),
            server_default=sa.text("'09:00–18:00'"),
            nullable=False,
        ),
        sa.Column("mark", sa.String(length=32), server_default=sa.text("'RS'"), nullable=False),
        sa.Column("theme", sa.String(length=16), server_default=sa.text("'slate'"), nullable=False),
        sa.Column(
            "security_event_retention_days",
            sa.Integer(),
            server_default=sa.text("365"),
            nullable=False,
        ),
        sa.Column(
            "mfa_require_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "mfa_require_member", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "mfa_require_guest", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("mfa_grace_days", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "ip_allow_list",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "invitation_expiry_days", sa.Integer(), server_default=sa.text("7"), nullable=False
        ),
        sa.Column(
            "guest_duration_days", sa.Integer(), server_default=sa.text("30"), nullable=False
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
        sa.CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_workspace_profiles_currency"),
        sa.CheckConstraint(
            "jsonb_typeof(ip_allow_list) = 'array'", name="ck_workspace_profiles_ip_allow_list"
        ),
        sa.CheckConstraint("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'", name="ck_organizations_slug"),
        sa.CheckConstraint(
            "theme IN ('slate', 'whiteboard', 'triplicate', 'stockroom')",
            name="ck_workspace_profiles_theme",
        ),
        sa.CheckConstraint(
            "week_start IN ('monday', 'sunday')", name="ck_workspace_profiles_week_start"
        ),
        sa.CheckConstraint(
            "business_hours = btrim(business_hours)",
            name="ck_workspace_profiles_business_hours_trimmed",
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
        sa.CheckConstraint("mark = btrim(mark)", name="ck_workspace_profiles_mark_trimmed"),
        sa.CheckConstraint(
            "mfa_grace_days BETWEEN 0 AND 30", name="ck_workspace_profiles_mfa_grace_days_range"
        ),
        sa.CheckConstraint(
            "security_event_retention_days BETWEEN 1 AND 3650",
            name="ck_workspace_profiles_security_event_retention_days_range",
        ),
        sa.ForeignKeyConstraint(
            ["id", "logo_file_id"],
            ["files.org_id", "files.id"],
            name="fk_organizations_logo_file_id_files",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_organizations_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("organizations_pkey")),
        sa.UniqueConstraint("slug", name="uq_organizations_slug"),
    )
    op.create_table(
        "platform_settings",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "session_timeout_minutes", sa.Integer(), server_default=sa.text("60"), nullable=False
        ),
        sa.Column(
            "session_retention_days", sa.Integer(), server_default=sa.text("365"), nullable=False
        ),
        sa.Column(
            "security_event_retention_days",
            sa.Integer(),
            server_default=sa.text("365"),
            nullable=False,
        ),
        sa.Column(
            "password_min_length", sa.Integer(), server_default=sa.text("12"), nullable=False
        ),
        sa.Column(
            "password_require_mixed_case",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "password_require_number", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("session_absolute_lifetime_minutes", sa.Integer(), nullable=True),
        sa.Column("session_concurrent_limit", sa.Integer(), nullable=True),
        sa.Column(
            "login_failed_attempt_threshold",
            sa.Integer(),
            server_default=sa.text("5"),
            nullable=False,
        ),
        sa.Column(
            "login_window_minutes", sa.Integer(), server_default=sa.text("15"), nullable=False
        ),
        sa.Column(
            "login_cooldown_minutes", sa.Integer(), server_default=sa.text("15"), nullable=False
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
        sa.CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_platform_settings_not_deleted"
        ),
        sa.CheckConstraint(
            "login_cooldown_minutes BETWEEN 1 AND 1440",
            name="ck_platform_settings_login_cooldown_minutes_range",
        ),
        sa.CheckConstraint(
            "login_failed_attempt_threshold BETWEEN 1 AND 100",
            name="ck_platform_settings_login_failed_attempt_threshold_range",
        ),
        sa.CheckConstraint(
            "login_window_minutes BETWEEN 1 AND 1440",
            name="ck_platform_settings_login_window_minutes_range",
        ),
        sa.CheckConstraint(
            "password_min_length BETWEEN 12 AND 128",
            name="ck_platform_settings_password_min_length",
        ),
        sa.CheckConstraint(
            "security_event_retention_days BETWEEN 1 AND 3650",
            name="ck_platform_settings_security_event_retention_days_range",
        ),
        sa.CheckConstraint(
            "session_absolute_lifetime_minutes IS NULL OR "
            "session_absolute_lifetime_minutes BETWEEN 1 AND 43200",
            name="ck_platform_settings_session_absolute_lifetime_minutes_range",
        ),
        sa.CheckConstraint(
            "session_concurrent_limit IS NULL OR session_concurrent_limit BETWEEN 1 AND 100",
            name="ck_platform_settings_session_concurrent_limit_range",
        ),
        sa.CheckConstraint(
            "session_retention_days BETWEEN 1 AND 3650",
            name="ck_platform_settings_session_retention_days_range",
        ),
        sa.CheckConstraint(
            "session_timeout_minutes IN (15, 30, 60, 480)",
            name="ck_platform_settings_session_timeout_minutes",
        ),
        sa.CheckConstraint("singleton_key = true", name="ck_platform_settings_singleton_key"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_platform_settings_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("platform_settings_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_platform_settings_singleton_key"),
    )
    op.create_table(
        "update_statuses",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("latest_version", sa.String(length=40), nullable=True),
        sa.Column("release_url", sa.String(length=160), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
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
            "failure_code IS NULL OR failure_code IN "
            "('release_unavailable','release_invalid','release_timeout')",
            name="ck_update_statuses_failure_code",
        ),
        sa.CheckConstraint(
            "(latest_version IS NULL AND release_url IS NULL AND observed_at IS NULL) OR "
            "(latest_version IS NOT NULL AND release_url IS NOT NULL AND observed_at IS NOT NULL)",
            name="ck_update_statuses_observation",
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_update_statuses_live"),
        sa.CheckConstraint(
            "observed_at IS NULL OR (checked_at IS NOT NULL AND checked_at >= observed_at)",
            name="ck_update_statuses_times",
        ),
        sa.CheckConstraint("singleton_key = true", name="ck_update_statuses_singleton"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_update_statuses_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("update_statuses_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_update_statuses_singleton"),
    )
    op.create_table(
        "users",
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("supabase_user_id", sa.Uuid(), nullable=True),
        sa.Column("username", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column(
            "theme_preference", sa.Text(), server_default=sa.text("'system'"), nullable=False
        ),
        sa.Column(
            "appearance",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text('\'{"motion": "system", "keyboard_shortcuts": true}\'::jsonb'),
            nullable=False,
        ),
        sa.Column("job_title", sa.String(length=200), nullable=True),
        sa.Column("phone", sa.String(length=32), nullable=True),
        sa.Column("bio", sa.String(length=280), nullable=True),
        sa.Column("avatar_file_id", sa.UUID(), nullable=True),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
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
        sa.CheckConstraint(
            "CASE WHEN jsonb_typeof(appearance) = 'object' THEN (appearance ?& "
            "ARRAY['motion','keyboard_shortcuts'] AND appearance - ARRAY['motion',"
            "'keyboard_shortcuts','timezone','date_format','time_format','week_start',"
            "'start_page'] = '{}'::jsonb AND appearance ->> 'motion' IN ('system','reduce') "
            "AND jsonb_typeof(appearance -> 'keyboard_shortcuts') = 'boolean' AND (NOT "
            "(appearance ? 'timezone') OR jsonb_typeof(appearance -> 'timezone') IN "
            "('string','null')) AND (NOT (appearance ? 'date_format') OR appearance ->> "
            "'date_format' IN ('organization','dmy','mdy','ymd')) AND (NOT (appearance ? "
            "'time_format') OR appearance ->> 'time_format' IN ('organization','12h','24h')) "
            "AND (NOT (appearance ? 'week_start') OR appearance ->> 'week_start' IN "
            "('organization','monday','sunday')) AND (NOT (appearance ? 'start_page') OR "
            "appearance ->> 'start_page' IN ('automatic','sandbox','boards','comms',"
            "'access','openview','manage','platform'))) IS TRUE ELSE false END",
            name="ck_users_appearance",
        ),
        sa.CheckConstraint("status IN ('pending', 'active', 'disabled')", name="ck_users_status"),
        sa.CheckConstraint(
            "theme_preference IN ('light', 'dark', 'system')", name="ck_users_theme_preference"
        ),
        sa.CheckConstraint(
            "email = lower(btrim(email)) AND length(email) > 0", name="ck_users_email_normalized"
        ),
        sa.ForeignKeyConstraint(
            ["avatar_file_id"],
            ["files.id"],
            name="fk_users_avatar_file_id_files",
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_users_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("users_pkey")),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )
    op.create_index(op.f("ix_users_avatar_file_id"), "users", ["avatar_file_id"], unique=False)
    op.create_index(op.f("ix_users_email"), "users", ["email"], unique=False)
    op.create_index(op.f("ix_users_supabase_user_id"), "users", ["supabase_user_id"], unique=True)
    op.create_index(op.f("ix_users_username"), "users", ["username"], unique=False)
    op.create_table(
        "audit_logs",
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(length=50), nullable=False),
        sa.Column("entity_type", sa.String(length=50), nullable=False),
        sa.Column("entity_id", sa.UUID(), nullable=True),
        sa.Column("department_id", sa.UUID(), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("request_method", sa.String(length=10), nullable=True),
        sa.Column("request_path", sa.Text(), nullable=True),
        sa.Column("actor_label", sa.String(length=100), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint("action IN ('create', 'update', 'delete')", name="ck_audit_logs_action"),
        sa.CheckConstraint(
            "org_id IS NOT NULL OR entity_type IN ('users','platform_settings',"
            "'platform_operators','backup_policies','backup_runs','backup_export_operations',"
            "'update_statuses') OR COALESCE(("
            "COALESCE(NULLIF(\"after\", 'null'::jsonb), \"before\") -> 'org_id' = 'null'::jsonb "
            "AND ((entity_type = 'files' AND COALESCE(NULLIF(\"after\", 'null'::jsonb), "
            "\"before\") ->> 'purpose' = 'user_avatar') OR "
            "(entity_type = 'in_app_notifications' AND COALESCE(NULLIF(\"after\", 'null'::jsonb), "
            "\"before\") ->> 'kind' = 'backup-failed'))), false)",
            name="ck_audit_logs_organization",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_audit_logs_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_audit_logs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("audit_logs_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_audit_logs_org_id_id"),
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
        "backup_runs",
        sa.Column("installation_id", sa.String(length=63), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("provenance", sa.String(length=9), nullable=False),
        sa.Column("requester_id", sa.UUID(), nullable=True),
        sa.Column("idempotency_hash", sa.String(length=64), nullable=True),
        sa.Column("schedule", sa.String(length=8), nullable=False),
        sa.Column("retention_days", sa.Integer(), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state", sa.String(length=11), server_default="queued", nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=True),
        sa.Column("claimed_schedule", sa.String(length=8), nullable=True),
        sa.Column("claimed_retention_days", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reconciled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("snapshot_id", sa.String(length=64), nullable=True),
        sa.Column("manifest_sha256", sa.String(length=64), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
        sa.Column("expired_at", sa.DateTime(timezone=True), nullable=True),
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
            "(provenance = 'manual' AND idempotency_hash IS NOT NULL AND scheduled_for "
            "IS NULL) OR (provenance = 'scheduled' AND idempotency_hash IS NULL AND "
            "requester_id IS NULL AND scheduled_for IS NOT NULL)",
            name="ck_backup_runs_request",
        ),
        sa.CheckConstraint(
            "(snapshot_id IS NULL AND manifest_sha256 IS NULL AND verified_at IS NULL) "
            "OR (snapshot_id IS NOT NULL AND manifest_sha256 IS NOT NULL AND snapshot_id "
            "~ '^[0-9a-f]{64}$' AND manifest_sha256 ~ '^[0-9a-f]{64}$' AND verified_at "
            "IS NOT NULL AND started_at IS NOT NULL)",
            name="ck_backup_runs_verification",
        ),
        sa.CheckConstraint(
            "(started_at IS NULL AND claim_id IS NULL AND claimed_schedule IS NULL AND "
            "claimed_retention_days IS NULL AND state = 'queued' AND finished_at IS NULL "
            "AND reconciled_at IS NULL) OR (started_at IS NOT NULL AND claim_id IS NOT "
            "NULL AND claimed_schedule IS NOT NULL AND claimed_retention_days IS NOT "
            "NULL AND claimed_schedule IN ('disabled','daily','weekly') AND "
            "claimed_retention_days IN (7,30,90) AND state <> 'queued')",
            name="ck_backup_runs_claim",
        ),
        sa.CheckConstraint(
            "(state IN ('queued','running') AND finished_at IS NULL AND failure_code IS "
            "NULL AND reconciled_at IS NULL) OR (state = 'succeeded' AND finished_at IS "
            "NOT NULL AND reconciled_at IS NOT NULL AND verified_at IS NOT NULL AND "
            "failure_code IS NULL) OR (state IN ('failed','interrupted') AND finished_at "
            "IS NOT NULL AND failure_code IS NOT NULL)",
            name="ck_backup_runs_outcome",
        ),
        sa.CheckConstraint(
            "failure_code IS NULL OR failure_code IN ('backup_failed','backup_interrupted',"
            "'verification_failed','restart_failed','readiness_failed','result_unconfirmed',"
            "'retention_failed')",
            name="ck_backup_runs_failure_code",
        ),
        sa.CheckConstraint(
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_runs_identity"
        ),
        sa.CheckConstraint(
            "length(name) BETWEEN 1 AND 120 AND name = btrim(name) AND name !~ '[[:cntrl:]]'",
            name="ck_backup_runs_name",
        ),
        sa.CheckConstraint(
            "provenance IN ('manual','scheduled')", name="ck_backup_runs_provenance"
        ),
        sa.CheckConstraint(
            "schedule IN ('disabled','daily','weekly')", name="ck_backup_runs_schedule"
        ),
        sa.CheckConstraint(
            "state IN ('queued','running','succeeded','failed','interrupted')",
            name="ck_backup_runs_state",
        ),
        sa.CheckConstraint(
            "(started_at IS NULL OR started_at >= requested_at) AND (finished_at IS NULL "
            "OR finished_at >= started_at) AND (verified_at IS NULL OR verified_at "
            "BETWEEN started_at AND finished_at) AND (reconciled_at IS NULL OR "
            "reconciled_at >= finished_at) AND (expired_at IS NULL OR (verified_at IS "
            "NOT NULL AND reconciled_at IS NOT NULL AND expired_at >= verified_at))",
            name="ck_backup_runs_times",
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_runs_live"),
        sa.CheckConstraint("retention_days IN (7,30,90)", name="ck_backup_runs_retention"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_backup_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_backup_runs_requester_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("backup_runs_pkey")),
        sa.UniqueConstraint("claim_id", name="uq_backup_runs_claim_id"),
        sa.UniqueConstraint(
            "installation_id", "requester_id", "idempotency_hash", name="uq_backup_runs_idempotency"
        ),
        sa.UniqueConstraint(
            "installation_id", "scheduled_for", name="uq_backup_runs_scheduled_occurrence"
        ),
    )
    op.create_index(
        "ix_backup_runs_queue",
        "backup_runs",
        ["installation_id", "state", "requested_at"],
        unique=False,
    )
    op.create_index("ix_backup_runs_requester_id", "backup_runs", ["requester_id"], unique=False)
    op.create_index(
        "uq_backup_runs_unresolved",
        "backup_runs",
        ["installation_id"],
        unique=True,
        postgresql_where=sa.text("started_at IS NOT NULL AND reconciled_at IS NULL"),
    )
    op.create_table(
        "departments",
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
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
        sa.CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_departments_lifecycle_close_provenance",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_departments_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_departments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("departments_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_departments_org_id_id"),
    )
    op.create_index(
        "uq_departments_name_active",
        "departments",
        ["org_id", "department_name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "groups",
        sa.Column("org_id", sa.UUID(), nullable=False),
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
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_groups_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_groups_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("groups_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_groups_org_id_id"),
    )
    op.create_index(
        "uq_groups_name_active_ci",
        "groups",
        ["org_id", sa.literal_column("lower(name)")],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "identity_mfa_observations",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("observed_provider_user_id", sa.UUID(), nullable=True),
        sa.Column("verified_totp", sa.Boolean(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sign_in_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_active_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "((observed_provider_user_id IS NULL AND verified_totp IS NULL AND "
            "observed_at IS NULL) OR (observed_provider_user_id IS NOT NULL AND "
            "observed_at IS NOT NULL)) IS TRUE",
            name="ck_identity_mfa_observations_authority",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_identity_mfa_observations_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("identity_mfa_observations_pkey")),
    )
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
        sa.Column("ip_address", postgresql.INET(), nullable=True),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_lifecycle_confirmation_challenges_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_confirmation_challenges_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_lifecycle_confirmation_challenges_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
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
            "window_expires_at > window_started_at AND window_expires_at <= "
            "window_started_at + interval '15 minutes'",
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
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_lifecycle_rate_limit_buckets_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_rate_limit_buckets_pkey")),
        sa.UniqueConstraint("org_id", "actor_id", name="uq_lifecycle_rate_limit_buckets_actor_id"),
        sa.UniqueConstraint("org_id", "id", name="uq_lifecycle_rate_limit_buckets_org_id_id"),
    )
    op.create_table(
        "lifecycle_rate_limit_failures",
        sa.Column("org_id", sa.UUID(), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_lifecycle_rate_limit_failures_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_rate_limit_failures_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_lifecycle_rate_limit_failures_org_id_id"),
    )
    op.create_index(
        "ix_lifecycle_rate_limit_failures_actor_occurred",
        "lifecycle_rate_limit_failures",
        ["actor_id", "occurred_at"],
        unique=False,
    )
    op.create_table(
        "memberships",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("sponsor_user_id", sa.UUID(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invitation_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invitation_accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("provider_invitation_operation_id", sa.Uuid(), nullable=True),
        sa.Column("mfa_required_since", sa.DateTime(timezone=True), nullable=True),
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
            "(role = 'guest') = (sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL)",
            name="ck_memberships_guest",
        ),
        sa.CheckConstraint("role IN ('admin', 'member', 'guest')", name="ck_memberships_role"),
        sa.CheckConstraint(
            "status IN ('pending', 'active', 'disabled')", name="ck_memberships_status"
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_memberships_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_memberships_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["sponsor_user_id"],
            ["users.id"],
            name=op.f("fk_memberships_sponsor_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_memberships_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("memberships_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_memberships_org_id_id"),
        sa.UniqueConstraint("org_id", "user_id", name="uq_memberships_org_user"),
    )
    op.create_index(
        op.f("ix_memberships_sponsor_user_id"), "memberships", ["sponsor_user_id"], unique=False
    )
    op.create_index(op.f("ix_memberships_user_id"), "memberships", ["user_id"], unique=False)
    op.create_table(
        "platform_operators",
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
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_platform_operators_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_platform_operators_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("platform_operators_pkey")),
        sa.UniqueConstraint("user_id", name="uq_platform_operators_user_id"),
    )
    op.create_table(
        "sandbox_documents",
        sa.Column("org_id", sa.UUID(), nullable=False),
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
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_documents_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_documents_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_documents_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_documents_org_id_id"),
        sa.UniqueConstraint("org_id", "singleton_key", name="uq_sandbox_documents_singleton_key"),
    )
    op.create_table(
        "security_events",
        sa.Column("org_id", sa.UUID(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_security_events_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("security_events_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_security_events_org_id_id"),
    )
    op.create_index(
        "ix_security_events_occurred_at_id", "security_events", ["occurred_at", "id"], unique=False
    )
    op.create_index(
        "ix_security_events_operation_id", "security_events", ["operation_id"], unique=False
    )
    op.create_table(
        "backup_export_operations",
        sa.Column("installation_id", sa.String(length=63), nullable=False),
        sa.Column("backup_run_id", sa.UUID(), nullable=False),
        sa.Column("requester_id", sa.UUID(), nullable=True),
        sa.Column("idempotency_hash", sa.String(length=64), nullable=False),
        sa.Column("payload_hmac", sa.String(length=64), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(length=11), server_default="queued", nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("encrypted_passphrase", sa.String(length=2048), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("failure_code", sa.String(length=32), nullable=True),
        sa.Column("artifact_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("admission_digest", sa.String(length=64), nullable=True),
        sa.Column("admission_actor_id", sa.Uuid(), nullable=True),
        sa.Column("admission_session_id", sa.Uuid(), nullable=True),
        sa.Column("admission_expires_at", sa.DateTime(timezone=True), nullable=True),
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
            "(admission_digest IS NULL AND admission_actor_id IS NULL AND "
            "admission_session_id IS NULL AND admission_expires_at IS NULL) OR "
            "(state = 'ready' AND artifact_deleted_at IS NULL AND admission_digest "
            "IS NOT NULL AND admission_digest ~ '^[0-9a-f]{64}$' AND admission_actor_id "
            "IS NOT NULL AND admission_session_id IS NOT NULL AND admission_expires_at "
            "IS NOT NULL AND admission_expires_at <= expires_at)",
            name="ck_backup_exports_admission",
        ),
        sa.CheckConstraint(
            "(state = 'queued' AND claim_id IS NULL AND claimed_at IS NULL AND "
            "encrypted_passphrase IS NOT NULL) OR (state <> 'queued' AND claim_id "
            "IS NOT NULL AND claimed_at IS NOT NULL AND encrypted_passphrase IS NULL)",
            name="ck_backup_exports_claim",
        ),
        sa.CheckConstraint(
            "(state = 'ready' AND ready_at IS NOT NULL AND expires_at IS NOT NULL AND "
            "size_bytes IS NOT NULL AND size_bytes > 0 AND sha256 IS NOT NULL AND "
            "sha256 ~ '^[0-9a-f]{64}$' AND expires_at = ready_at + interval '24 hours') "
            "OR (state <> 'ready' AND ready_at IS NULL AND expires_at IS NULL AND "
            "size_bytes IS NULL AND sha256 IS NULL)",
            name="ck_backup_exports_artifact",
        ),
        sa.CheckConstraint(
            "(state IN ('queued','preparing') AND finished_at IS NULL AND failure_code "
            "IS NULL) OR (state = 'ready' AND finished_at IS NOT NULL AND failure_code "
            "IS NULL) OR (state IN ('failed','interrupted') AND finished_at IS NOT NULL "
            "AND failure_code IS NOT NULL)",
            name="ck_backup_exports_outcome",
        ),
        sa.CheckConstraint(
            "artifact_deleted_at IS NULL OR "
            "(state = 'ready' AND artifact_deleted_at >= expires_at)",
            name="ck_backup_exports_deletion",
        ),
        sa.CheckConstraint(
            "failure_code IS NULL OR failure_code IN ('source_unavailable',"
            "'source_unproven','copy_failed','verification_failed','export_interrupted',"
            "'result_unconfirmed')",
            name="ck_backup_exports_failure_code",
        ),
        sa.CheckConstraint(
            "idempotency_hash ~ '^[0-9a-f]{64}$' AND payload_hmac ~ '^[0-9a-f]{64}$'",
            name="ck_backup_exports_request",
        ),
        sa.CheckConstraint(
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_exports_identity"
        ),
        sa.CheckConstraint(
            "state IN ('queued','preparing','ready','failed','interrupted')",
            name="ck_backup_exports_state",
        ),
        sa.CheckConstraint(
            "(claimed_at IS NULL OR claimed_at >= requested_at) AND "
            "(finished_at IS NULL OR finished_at >= claimed_at) AND "
            "(ready_at IS NULL OR ready_at >= claimed_at)",
            name="ck_backup_exports_times",
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_exports_live"),
        sa.ForeignKeyConstraint(
            ["backup_run_id"],
            ["backup_runs.id"],
            name=op.f("fk_backup_export_operations_backup_run_id_backup_runs"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_backup_export_operations_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_backup_export_operations_requester_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("backup_export_operations_pkey")),
        sa.UniqueConstraint("claim_id", name="uq_backup_exports_claim_id"),
        sa.UniqueConstraint(
            "installation_id",
            "requester_id",
            "idempotency_hash",
            name="uq_backup_exports_idempotency",
        ),
    )
    op.create_index(
        "ix_backup_exports_backup_run_id",
        "backup_export_operations",
        ["backup_run_id"],
        unique=False,
    )
    op.create_index(
        "ix_backup_exports_cleanup",
        "backup_export_operations",
        ["installation_id", "expires_at"],
        unique=False,
        postgresql_where=sa.text("state = 'ready' AND artifact_deleted_at IS NULL"),
    )
    op.create_index(
        "ix_backup_exports_queue",
        "backup_export_operations",
        ["installation_id", "state", "requested_at"],
        unique=False,
    )
    op.create_index(
        "ix_backup_exports_requester_id", "backup_export_operations", ["requester_id"], unique=False
    )
    op.create_index(
        "uq_backup_exports_unresolved",
        "backup_export_operations",
        ["installation_id"],
        unique=True,
        postgresql_where=sa.text("state = 'preparing'"),
    )
    op.create_table(
        "boards",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("scope", sa.String(length=20), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
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
        sa.CheckConstraint(
            "(scope = 'department') = (department_id IS NOT NULL)",
            name="ck_boards_department_scope",
        ),
        sa.CheckConstraint("scope IN ('company', 'department', 'project')", name="ck_boards_scope"),
        sa.CheckConstraint("status IN ('active', 'archived')", name="ck_boards_status"),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_boards_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_boards_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_boards_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_boards_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_boards_org_id_id"),
    )
    op.create_index(op.f("ix_boards_department_id"), "boards", ["department_id"], unique=False)
    op.create_index(
        "uq_boards_company",
        "boards",
        ["org_id", "scope"],
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
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
        sa.CheckConstraint(
            "refresh_cadence IN ('manual', 'one-minute', 'five-minutes')",
            name="ck_dashboards_refresh_cadence",
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_dashboards_name_nonempty"),
        sa.CheckConstraint("position >= 0", name="ck_dashboards_position_nonnegative"),
        sa.CheckConstraint("revision > 0", name="ck_dashboards_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_dashboards_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_dashboards_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_dashboards_org_id_id"),
    )
    op.create_index(
        "ix_dashboards_department_position",
        "dashboards",
        ["department_id", "position"],
        unique=False,
    )
    op.create_table(
        "group_members",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
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
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_group_members_group_id_groups",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_group_members_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_group_members_org_id_id"),
    )
    op.create_index(op.f("ix_group_members_user_id"), "group_members", ["user_id"], unique=False)
    op.create_table(
        "modules",
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("module_name", sa.String(length=150), nullable=False),
        sa.Column("title_field_id", sa.Uuid(), nullable=True),
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
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_modules_lifecycle_close_provenance",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_modules_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "title_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_modules_title_field_id_fields",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_modules_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_modules_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("modules_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_modules_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
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
            ["org_id", "document_id"],
            ["sandbox_documents.org_id", "sandbox_documents.id"],
            name="fk_sandbox_test_runs_document_id_sandbox_documents",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_test_runs_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_test_runs_org_id_id"),
    )
    op.create_index(
        "ix_sandbox_test_runs_document_created",
        "sandbox_test_runs",
        ["document_id", "created_at", "id"],
        unique=False,
    )
    op.create_table(
        "sandbox_versions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("source_document_revision", sa.Integer(), nullable=False),
        sa.Column("source_version_id", sa.Uuid(), nullable=True),
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
            ["org_id", "document_id"],
            ["sandbox_documents.org_id", "sandbox_documents.id"],
            name="fk_sandbox_versions_document_id_sandbox_documents",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "source_version_id"],
            ["sandbox_versions.org_id", "sandbox_versions.id"],
            name="fk_sandbox_versions_source_version_id_sandbox_versions",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_versions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_versions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_versions_pkey")),
        sa.UniqueConstraint(
            "document_id", "sequence", name="uq_sandbox_versions_document_sequence"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_versions_org_id_id"),
    )
    op.create_index(
        "ix_sandbox_versions_source_version",
        "sandbox_versions",
        ["source_version_id"],
        unique=False,
    )
    op.create_table(
        "board_events",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
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
            "(recurrence = 'none' AND repeat_until IS NULL) OR "
            "(recurrence IN ('daily', 'weekly', 'monthly') AND repeat_until IS NOT NULL)",
            name="ck_board_events_recurrence",
        ),
        sa.CheckConstraint(
            "CASE WHEN jsonb_typeof(links) = 'array' THEN "
            "jsonb_array_length(links) <= 20 ELSE false END",
            name="ck_board_events_links_array_limit",
        ),
        sa.CheckConstraint(
            "(all_day = true AND start_date IS NOT NULL AND end_date IS NOT NULL AND "
            "start_at IS NULL AND end_at IS NULL AND end_date >= start_date) OR "
            "(all_day = false AND start_date IS NULL AND end_date IS NULL AND "
            "start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at)",
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
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_events_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_events_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_board_events_org_id_id"),
    )
    op.create_index("ix_board_events_author_id", "board_events", ["author_id"], unique=False)
    op.create_index("ix_board_events_board_id", "board_events", ["board_id"], unique=False)
    op.create_table(
        "board_groups",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
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
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_groups_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_board_groups_group_id_groups",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_groups_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_board_groups_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
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
            "CASE WHEN jsonb_typeof(links) = 'array' THEN "
            "jsonb_array_length(links) <= 20 ELSE false END",
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
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_posts_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_posts_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_board_posts_org_id_id"),
    )
    op.create_index("ix_board_posts_author_id", "board_posts", ["author_id"], unique=False)
    op.create_index("ix_board_posts_board_id", "board_posts", ["board_id"], unique=False)
    op.create_table(
        "charts",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("chart_type", sa.String(length=20), nullable=False),
        sa.Column("query", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "chart_type IN ('bar', 'line', 'pie', 'summary', 'workload', 'records')",
            name="ck_charts_type",
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_charts_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_charts_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_charts_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_charts_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_charts_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_charts_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("charts_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_charts_org_id_id"),
    )
    op.create_index("ix_charts_department_id", "charts", ["department_id"], unique=False)
    op.create_index("ix_charts_module_id", "charts", ["module_id"], unique=False)
    op.create_table(
        "fields",
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
        sa.Column("relationship_target_module_id", sa.Uuid(), nullable=True),
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
            "(type = 'relationship' AND relationship_target_module_id IS NOT NULL AND "
            "relationship_multiple_targets IS NOT NULL AND relationship_multiple_sources "
            "IS NOT NULL AND required = false AND config = '{}'::jsonb) OR "
            "(type <> 'relationship' AND relationship_target_module_id IS NULL AND "
            "relationship_multiple_targets IS NULL AND relationship_multiple_sources IS NULL)",
            name="ck_fields_relationship_metadata",
        ),
        sa.CheckConstraint(
            "type IN ('text', 'long_text', 'email', 'url', 'number', 'decimal', 'int', "
            "'boolean', 'date', 'datetime', 'select', 'user', 'relationship')",
            name="ck_fields_type",
        ),
        sa.CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_fields_lifecycle_close_provenance",
        ),
        sa.CheckConstraint("position >= 0", name="ck_fields_position_nonnegative"),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_fields_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "relationship_target_module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_fields_relationship_target_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_fields_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_fields_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("fields_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_fields_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=True),
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
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_group_access_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_group_access_group_id_groups",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_group_access_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_group_access_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_group_access_org_id_id"),
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
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
        sa.CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_records_lifecycle_close_provenance",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_records_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_records_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_records_org_id_id"),
    )
    op.create_index(op.f("ix_records_module_id"), "records", ["module_id"], unique=False)
    op.create_table(
        "reports",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_reports_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_reports_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_reports_org_id_id"),
    )
    op.create_index("ix_reports_module", "reports", ["module_id"], unique=False)
    op.create_table(
        "sandbox_publications",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=False),
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
            ["org_id", "document_id"],
            ["sandbox_documents.org_id", "sandbox_documents.id"],
            name="fk_sandbox_publications_document_id_sandbox_documents",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "version_id"],
            ["sandbox_versions.org_id", "sandbox_versions.id"],
            name="fk_sandbox_publications_version_id_sandbox_versions",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_publications_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_publications_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_publications_pkey")),
        sa.UniqueConstraint(
            "org_id", "actor_id", "idempotency_key", name="uq_sandbox_publications_actor_key"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_publications_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
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
        sa.CheckConstraint("revision > 0", name="ck_saved_views_revision"),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_saved_views_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_saved_views_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_saved_views_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
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
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_event_reminders_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "event_id"],
            ["board_events.org_id", "board_events.id"],
            name="fk_board_event_reminders_event_id_board_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_event_reminders_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_board_event_reminders_org_id_id"),
    )
    op.create_index(
        "ix_board_event_reminders_board_id", "board_event_reminders", ["board_id"], unique=False
    )
    op.create_table(
        "board_post_revisions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("post_id", sa.Uuid(), nullable=False),
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
            "CASE WHEN jsonb_typeof(links) = 'array' THEN "
            "jsonb_array_length(links) <= 20 ELSE false END",
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
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_board_post_revisions_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_post_revisions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revisions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revisions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_post_revisions_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("post_id", sa.Uuid(), nullable=True),
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
            "(event_id IS NOT NULL AND post_id IS NULL) OR "
            "(event_id IS NULL AND post_id IS NOT NULL)",
            name="ck_board_record_links_one_owner",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_record_links_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "event_id"],
            ["board_events.org_id", "board_events.id"],
            name="fk_board_record_links_event_id_board_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_record_links_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_board_record_links_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_board_record_links_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_record_links_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_record_links_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_record_links_pkey")),
        sa.UniqueConstraint("event_id", "record_id", name="uq_board_event_record_link"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_record_links_org_id_id"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_board_widgets_org_id_id"),
    )
    op.create_index("ix_board_widgets_chart_id", "board_widgets", ["chart_id"], unique=False)
    op.create_index("ix_board_widgets_module_id", "board_widgets", ["module_id"], unique=False)
    op.create_table(
        "dashboard_widgets",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("dashboard_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "widget_type", sa.String(length=20), server_default=sa.text("'chart'"), nullable=False
        ),
        sa.Column("size", sa.String(length=1), server_default=sa.text("'M'"), nullable=False),
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
        sa.CheckConstraint("size IN ('S', 'M', 'L')", name="ck_dashboard_widgets_size"),
        sa.CheckConstraint(
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_dashboard_widgets_type",
        ),
        sa.CheckConstraint(
            "(config IS NOT NULL) <> (chart_id IS NOT NULL)",
            name="ck_dashboard_widgets_query_source",
        ),
        sa.CheckConstraint("position >= 0 AND position < 12", name="ck_dashboard_widgets_position"),
        sa.ForeignKeyConstraint(
            ["org_id", "chart_id"],
            ["charts.org_id", "charts.id"],
            name="fk_dashboard_widgets_chart_id_charts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "dashboard_id"],
            ["dashboards.org_id", "dashboards.id"],
            name="fk_dashboard_widgets_dashboard_id_dashboards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_dashboard_widgets_org_id_organizations"),
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
        sa.UniqueConstraint("org_id", "id", name="uq_dashboard_widgets_org_id_id"),
    )
    op.create_index(
        "ix_dashboard_widgets_chart_id", "dashboard_widgets", ["chart_id"], unique=False
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
        "files",
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("purpose", sa.String(length=30), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=True),
        sa.Column("board_id", sa.Uuid(), nullable=True),
        sa.Column("department_id", sa.Uuid(), nullable=True),
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
        sa.Column("deletion_origin", sa.String(length=30), nullable=True),
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
            "(purpose = 'record_attachment' AND record_id IS NOT NULL AND board_id IS NULL "
            "AND department_id IS NULL) OR (purpose = 'board_attachment' AND board_id "
            "IS NOT NULL AND record_id IS NULL AND department_id IS NULL) OR "
            "(purpose = 'library_document' AND department_id IS NOT NULL AND record_id "
            "IS NULL AND board_id IS NULL) OR (purpose IN ('workspace_logo','user_avatar') "
            "AND record_id IS NULL AND board_id IS NULL AND department_id IS NULL)",
            name="ck_files_purpose_parent",
        ),
        sa.CheckConstraint(
            "(purpose = 'user_avatar') = (org_id IS NULL)", name="ck_files_organization"
        ),
        sa.CheckConstraint(
            "deletion_origin IS NULL OR (((deletion_origin = 'logo_replacement' AND "
            "purpose = 'workspace_logo') OR (deletion_origin = 'avatar_replacement' AND "
            "purpose = 'user_avatar')) AND is_deleted = true AND state = 'deleting' AND "
            "operation_id IS NOT NULL)",
            name="ck_files_deletion_origin",
        ),
        sa.CheckConstraint(
            "purpose != 'user_avatar' OR (expected_size <= 2097152 AND "
            "(actual_size IS NULL OR actual_size <= 2097152))",
            name="ck_files_avatar_size",
        ),
        sa.CheckConstraint(
            "purpose != 'workspace_logo' OR expected_size <= 2097152", name="ck_files_logo_size"
        ),
        sa.CheckConstraint(
            "state != 'ready' OR (digest IS NOT NULL AND actual_size IS NOT NULL)",
            name="ck_files_ready_verdict",
        ),
        sa.CheckConstraint(
            "state IN ('awaiting_upload','uploading','ready','rejected','deleting','purged')",
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
        sa.ForeignKeyConstraint(
            ["creator_id"],
            ["users.id"],
            name=op.f("fk_files_creator_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_files_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_files_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_files_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_files_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_files_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("files_pkey")),
        sa.UniqueConstraint("object_key", name=op.f("uq_files_object_key")),
        sa.UniqueConstraint("org_id", "id", name="uq_files_org_id_id"),
    )
    op.create_index(op.f("ix_files_board_id"), "files", ["board_id"], unique=False)
    op.create_index(op.f("ix_files_creator_id"), "files", ["creator_id"], unique=False)
    op.create_index(op.f("ix_files_department_id"), "files", ["department_id"], unique=False)
    op.create_index(op.f("ix_files_purpose"), "files", ["purpose"], unique=False)
    op.create_index(op.f("ix_files_record_id"), "files", ["record_id"], unique=False)
    op.create_table(
        "record_triggers",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("publication_id", sa.Uuid(), nullable=False),
        sa.Column("published_version_id", sa.Uuid(), nullable=False),
        sa.Column("publisher_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("priority", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("execution_position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("event_kind", sa.String(length=24), nullable=False),
        sa.Column("trigger_field_id", sa.Uuid(), nullable=True),
        sa.Column("trigger_operator", sa.String(length=2), nullable=True),
        sa.Column("trigger_value_kind", sa.String(length=16), nullable=True),
        sa.Column("trigger_literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("trigger_value_field_id", sa.Uuid(), nullable=True),
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
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_record_triggers_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "publication_id"],
            ["sandbox_publications.org_id", "sandbox_publications.id"],
            name="fk_record_triggers_publication_id_sandbox_publications",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "published_version_id"],
            ["sandbox_versions.org_id", "sandbox_versions.id"],
            name="fk_record_triggers_published_version_id_sandbox_versions",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_triggers_trigger_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_value_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_triggers_trigger_value_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_triggers_org_id_organizations"),
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
            ["publisher_id"],
            ["users.id"],
            name=op.f("fk_record_triggers_publisher_id_users"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_triggers_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_triggers_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("field_id", sa.Uuid(), nullable=False),
        sa.Column("source_record_id", sa.Uuid(), nullable=False),
        sa.Column("target_record_id", sa.Uuid(), nullable=False),
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
            ["org_id", "field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_relationship_edges_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "source_record_id"],
            ["records.org_id", "records.id"],
            name="fk_relationship_edges_source_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "target_record_id"],
            ["records.org_id", "records.id"],
            name="fk_relationship_edges_target_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_relationship_edges_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_relationship_edges_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("relationship_edges_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_relationship_edges_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_report_runs_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "report_id"],
            ["reports.org_id", "reports.id"],
            name="fk_report_runs_report_id_reports",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_runs_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_runs_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_report_runs_org_id_id"),
        sa.UniqueConstraint("report_id", "idempotency_key", name="uq_report_runs_idempotency"),
    )
    op.create_index("ix_report_runs_module", "report_runs", ["module_id"], unique=False)
    op.create_index(
        "ix_report_runs_report_created", "report_runs", ["report_id", "created_at"], unique=False
    )
    op.create_table(
        "report_schedules",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
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
            "(cadence = 'daily' AND weekday IS NULL AND month_day IS NULL) OR "
            "(cadence = 'weekly' AND weekday BETWEEN 0 AND 6 AND month_day IS NULL) OR "
            "(cadence = 'monthly' AND weekday IS NULL AND month_day BETWEEN 1 AND 31)",
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
            ["org_id", "report_id"],
            ["reports.org_id", "reports.id"],
            name="fk_report_schedules_report_id_reports",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_schedules_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_schedules_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_schedules_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_report_schedules_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("post_id", sa.Uuid(), nullable=True),
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
            "(event_id IS NOT NULL AND post_id IS NULL) OR "
            "(event_id IS NULL AND post_id IS NOT NULL)",
            name="ck_board_attachments_one_owner",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_attachments_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "event_id"],
            ["board_events.org_id", "board_events.id"],
            name="fk_board_attachments_event_id_board_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "file_id"],
            ["files.org_id", "files.id"],
            name="fk_board_attachments_file_id_files",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_board_attachments_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_attachments_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_attachments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_attachments_pkey")),
        sa.UniqueConstraint("file_id", name="uq_board_attachments_file"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_attachments_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
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
            ["org_id", "file_id"],
            ["files.org_id", "files.id"],
            name="fk_board_post_revision_attachments_file_id_files",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "revision_id"],
            ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_board_revision_attachments_revision",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_post_revision_attachments_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revision_attachments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revision_attachments_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_post_revision_attachments_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_post_revision_record_links_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_board_post_revision_record_links_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "revision_id"],
            ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_board_revision_record_links_revision",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_post_revision_record_links_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revision_record_links_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revision_record_links_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_post_revision_record_links_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("trigger_id", sa.Uuid(), nullable=False),
        sa.Column("target_field_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("value_kind", sa.String(length=16), nullable=False),
        sa.Column("literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("value_field_id", sa.Uuid(), nullable=True),
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
            ["org_id", "target_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_actions_target_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_actions_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "value_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_actions_value_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_actions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_actions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_actions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_actions_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("trigger_id", sa.Uuid(), nullable=False),
        sa.Column("field_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("operator", sa.String(length=2), nullable=False),
        sa.Column("value_kind", sa.String(length=16), nullable=False),
        sa.Column("literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("value_field_id", sa.Uuid(), nullable=True),
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
            ["org_id", "field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_conditions_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_conditions_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "value_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_conditions_value_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_conditions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_conditions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_conditions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_conditions_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=True),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("scheduled_trigger_id", sa.Uuid(), nullable=True),
        sa.Column("event_kind", sa.String(length=24), nullable=False),
        sa.Column("changed_field_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("previous_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("root_event_id", sa.Uuid(), nullable=True),
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
            "(event_kind = 'schedule' AND scheduled_trigger_id IS NOT NULL) OR "
            "(event_kind IN ('record-created', 'field-changed') AND scheduled_trigger_id "
            "IS NULL AND record_id IS NOT NULL)",
            name="ck_record_trigger_events_subject",
        ),
        sa.CheckConstraint(
            "(event_kind = 'schedule') OR (schedule_upper_record_id IS NULL AND "
            "schedule_cursor_record_id IS NULL AND schedule_matched_count = 0 AND "
            "schedule_action_count = 0)",
            name="ck_record_trigger_events_schedule_progress",
        ),
        sa.CheckConstraint(
            "(state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) "
            "OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)",
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
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_record_trigger_events_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_record_trigger_events_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "root_event_id"],
            ["record_trigger_events.org_id", "record_trigger_events.id"],
            name="fk_record_trigger_events_root_event_id_record_trigger_events",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "scheduled_trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_events_scheduled_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_events_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_events_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_events_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_events_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["org_id", "run_id"],
            ["report_runs.org_id", "report_runs.id"],
            name="fk_report_run_eligible_users_run_id_report_runs",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_run_eligible_users_org_id_organizations"),
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
        op.f("ix_report_run_eligible_users_org_id"),
        "report_run_eligible_users",
        ["org_id"],
        unique=False,
    )
    op.create_index(
        "ix_report_run_eligible_users_user_run",
        "report_run_eligible_users",
        ["user_id", "run_id"],
        unique=False,
    )
    op.create_table(
        "report_run_rows",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=False),
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
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_report_run_rows_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "run_id"],
            ["report_runs.org_id", "report_runs.id"],
            name="fk_report_run_rows_run_id_report_runs",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_run_rows_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_run_rows_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_run_rows_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_report_run_rows_org_id_id"),
        sa.UniqueConstraint("run_id", "position", name="uq_report_run_rows_position"),
        sa.UniqueConstraint("run_id", "record_id", name="uq_report_run_rows_record"),
    )
    op.create_index("ix_report_run_rows_record", "report_run_rows", ["record_id"], unique=False)
    op.create_table(
        "sandbox_bindings",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("sandbox_id", sa.String(length=1000), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("module_id", sa.Uuid(), nullable=True),
        sa.Column("field_id", sa.Uuid(), nullable=True),
        sa.Column("trigger_id", sa.Uuid(), nullable=True),
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
            "(kind = 'department' AND department_id IS NOT NULL AND module_id IS NULL "
            "AND field_id IS NULL AND trigger_id IS NULL) OR (kind = 'module' AND "
            "department_id IS NULL AND module_id IS NOT NULL AND field_id IS NULL AND "
            "trigger_id IS NULL) OR (kind IN ('field', 'relationship') AND department_id "
            "IS NULL AND module_id IS NULL AND field_id IS NOT NULL AND trigger_id IS NULL) "
            "OR (kind = 'trigger' AND department_id IS NULL AND module_id IS NULL AND "
            "field_id IS NULL AND trigger_id IS NOT NULL)",
            name="ck_sandbox_bindings_exactly_one_live_target",
        ),
        sa.CheckConstraint(
            "kind IN ('department', 'module', 'field', 'relationship', 'trigger')",
            name="ck_sandbox_bindings_kind",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_sandbox_bindings_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_sandbox_bindings_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_sandbox_bindings_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_sandbox_bindings_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_bindings_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_bindings_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_bindings_pkey")),
        sa.UniqueConstraint("org_id", "department_id", name="uq_sandbox_bindings_department_id"),
        sa.UniqueConstraint("org_id", "field_id", name="uq_sandbox_bindings_field_id"),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_bindings_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "kind", "sandbox_id", name="uq_sandbox_bindings_kind_sandbox_id"
        ),
        sa.UniqueConstraint("org_id", "module_id", name="uq_sandbox_bindings_module_id"),
        sa.UniqueConstraint("org_id", "trigger_id", name="uq_sandbox_bindings_trigger_id"),
    )
    op.create_table(
        "scheduled_work",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "kind", sa.String(length=24), server_default=sa.text("'report-run'"), nullable=False
        ),
        sa.Column("report_id", sa.Uuid(), nullable=True),
        sa.Column("post_id", sa.Uuid(), nullable=True),
        sa.Column("reminder_id", sa.Uuid(), nullable=True),
        sa.Column("occurrence_start_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_revision", sa.Integer(), nullable=True),
        sa.Column("scheduling_actor_id", sa.UUID(), nullable=True),
        sa.Column("publication_result_id", sa.Uuid(), nullable=True),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("last_attempt_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "(kind = 'report-run' AND ((state = 'succeeded' AND run_id IS NOT NULL) OR "
            "(state <> 'succeeded' AND run_id IS NULL))) OR (kind = 'post-publish' AND "
            "((state = 'succeeded' AND publication_result_id IS NOT NULL) OR "
            "(state <> 'succeeded' AND publication_result_id IS NULL))) OR "
            "(kind = 'event-reminder' AND run_id IS NULL AND publication_result_id IS NULL)",
            name="ck_scheduled_work_run",
        ),
        sa.CheckConstraint(
            "(kind = 'report-run' AND report_id IS NOT NULL AND post_id IS NULL AND "
            "reminder_id IS NULL AND occurrence_start_at IS NULL AND source_revision "
            "IS NULL AND scheduling_actor_id IS NULL AND publication_result_id IS NULL) "
            "OR (kind = 'post-publish' AND report_id IS NULL AND reminder_id IS NULL AND "
            "occurrence_start_at IS NULL AND post_id IS NOT NULL AND source_revision "
            "IS NOT NULL AND source_revision > 0 AND scheduling_actor_id IS NOT NULL "
            "AND run_id IS NULL) OR (kind = 'event-reminder' AND report_id IS NULL AND "
            "post_id IS NULL AND reminder_id IS NOT NULL AND occurrence_start_at IS NOT NULL "
            "AND source_revision IS NULL AND scheduling_actor_id IS NULL AND "
            "publication_result_id IS NULL AND run_id IS NULL)",
            name="ck_scheduled_work_source",
        ),
        sa.CheckConstraint(
            "(state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) "
            "OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)",
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
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_scheduled_work_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "publication_result_id"],
            ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_scheduled_work_publication_result_id_board_post_revisions",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "reminder_id"],
            ["board_event_reminders.org_id", "board_event_reminders.id"],
            name="fk_scheduled_work_reminder_id_board_event_reminders",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "report_id"],
            ["reports.org_id", "reports.id"],
            name="fk_scheduled_work_report_id_reports",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "run_id"],
            ["report_runs.org_id", "report_runs.id"],
            name="fk_scheduled_work_run_id_report_runs",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_scheduled_work_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["scheduling_actor_id"],
            ["users.id"],
            name=op.f("fk_scheduled_work_scheduling_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("scheduled_work_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_scheduled_work_org_id_id"),
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
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("subject_type", sa.String(length=24), nullable=False),
        sa.Column("subject_id", sa.UUID(), nullable=False),
        sa.Column("work_id", sa.Uuid(), nullable=True),
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
        sa.CheckConstraint(
            "(kind = 'backup-failed') = (org_id IS NULL)",
            name="ck_in_app_notifications_organization",
        ),
        sa.CheckConstraint(
            "(kind = 'report-run' AND subject_type = 'report_run' AND work_id IS NOT NULL) "
            "OR (kind = 'post-publish' AND subject_type = 'board_post' AND work_id IS NOT NULL) "
            "OR (kind = 'event-reminder' AND subject_type = 'board_event' AND work_id "
            "IS NOT NULL) OR (kind = 'report-run-failed' AND subject_type = 'scheduled_work' "
            "AND work_id IS NOT NULL AND subject_id = work_id) OR (kind = 'backup-failed' "
            "AND subject_type = 'backup_run' AND work_id IS NULL) OR "
            "(kind = 'record-assigned' AND subject_type = 'record' AND work_id IS NULL) "
            "OR (kind = 'invitation-accepted' AND subject_type = 'user' AND work_id IS NULL) "
            "OR (kind = 'sandbox-published' AND subject_type = 'sandbox_version' AND "
            "work_id IS NULL) OR (kind = 'access-changed' AND subject_type = 'user' AND "
            "work_id IS NULL AND subject_id = recipient_id)",
            name="ck_in_app_notifications_reference",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "work_id"],
            ["scheduled_work.org_id", "scheduled_work.id"],
            name="fk_in_app_notifications_work_id_scheduled_work",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_in_app_notifications_org_id_organizations"),
            ondelete="RESTRICT",
        ),
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
        sa.PrimaryKeyConstraint("id", name=op.f("in_app_notifications_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_in_app_notifications_org_id_id"),
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
    op.create_index(
        "ix_in_app_notifications_recipient_unread",
        "in_app_notifications",
        ["recipient_id", "created_at", "id"],
        unique=False,
        postgresql_where=sa.text("read_at IS NULL AND is_deleted = false"),
    )
    op.create_table(
        "record_trigger_runs",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("trigger_id", sa.Uuid(), nullable=False),
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
            ["org_id", "event_id"],
            ["record_trigger_events.org_id", "record_trigger_events.id"],
            name="fk_record_trigger_runs_event_id_record_trigger_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_runs_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_runs_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_runs_pkey")),
        sa.UniqueConstraint("event_id", "trigger_id", name="uq_record_trigger_runs_event_trigger"),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_runs_org_id_id"),
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
    # ### end Alembic commands ###
    for name, table, target, local_columns, target_columns, ondelete in DEFERRED_FOREIGN_KEYS:
        op.create_foreign_key(
            op.f(name), table, target, local_columns, target_columns, ondelete=ondelete
        )
    _create_board_guards()
    # Organization bootstrap belongs to S05/S15; only installation policy is seeded.
    op.execute(
        "INSERT INTO public.platform_settings (id) VALUES ('00000000-0000-7000-8000-000000000003')"
    )
    _create_retention_capability()
    _grant_application_privileges()


def downgrade() -> None:
    # Destructive fresh-root removal, never a data-preserving rollback.
    for name, table, *_ in DEFERRED_FOREIGN_KEYS:
        op.drop_constraint(op.f(name), table, type_="foreignkey")
    for trigger, table, _, _ in BOARD_TRIGGERS:
        op.execute(f"DROP TRIGGER {trigger} ON public.{table}")
    for _, _, _, function in BOARD_TRIGGERS:
        op.execute(f"DROP FUNCTION public.{function}()")
    op.execute("DROP FUNCTION public.retain_security_events()")
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f("ix_record_trigger_runs_trigger_id"), table_name="record_trigger_runs")
    op.drop_index("ix_record_trigger_runs_created", table_name="record_trigger_runs")
    op.drop_table("record_trigger_runs")
    op.drop_index(
        "ix_in_app_notifications_recipient_unread",
        table_name="in_app_notifications",
        postgresql_where=sa.text("read_at IS NULL AND is_deleted = false"),
    )
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
    op.drop_index(
        op.f("ix_report_run_eligible_users_org_id"), table_name="report_run_eligible_users"
    )
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
    op.drop_index(op.f("ix_files_record_id"), table_name="files")
    op.drop_index(op.f("ix_files_purpose"), table_name="files")
    op.drop_index(op.f("ix_files_department_id"), table_name="files")
    op.drop_index(op.f("ix_files_creator_id"), table_name="files")
    op.drop_index(op.f("ix_files_board_id"), table_name="files")
    op.drop_table("files")
    op.drop_index(
        "uq_dashboard_widgets_active_position",
        table_name="dashboard_widgets",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_dashboard_widgets_dashboard_id", table_name="dashboard_widgets")
    op.drop_index("ix_dashboard_widgets_chart_id", table_name="dashboard_widgets")
    op.drop_table("dashboard_widgets")
    op.drop_index("ix_board_widgets_module_id", table_name="board_widgets")
    op.drop_index("ix_board_widgets_chart_id", table_name="board_widgets")
    op.drop_table("board_widgets")
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
    op.drop_index("ix_charts_module_id", table_name="charts")
    op.drop_index("ix_charts_department_id", table_name="charts")
    op.drop_table("charts")
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
    op.drop_index(
        "uq_backup_exports_unresolved",
        table_name="backup_export_operations",
        postgresql_where=sa.text("state = 'preparing'"),
    )
    op.drop_index("ix_backup_exports_requester_id", table_name="backup_export_operations")
    op.drop_index("ix_backup_exports_queue", table_name="backup_export_operations")
    op.drop_index(
        "ix_backup_exports_cleanup",
        table_name="backup_export_operations",
        postgresql_where=sa.text("state = 'ready' AND artifact_deleted_at IS NULL"),
    )
    op.drop_index("ix_backup_exports_backup_run_id", table_name="backup_export_operations")
    op.drop_table("backup_export_operations")
    op.drop_index("ix_security_events_operation_id", table_name="security_events")
    op.drop_index("ix_security_events_occurred_at_id", table_name="security_events")
    op.drop_table("security_events")
    op.drop_table("sandbox_documents")
    op.drop_table("platform_operators")
    op.drop_index(op.f("ix_memberships_user_id"), table_name="memberships")
    op.drop_index(op.f("ix_memberships_sponsor_user_id"), table_name="memberships")
    op.drop_table("memberships")
    op.drop_index(
        "ix_lifecycle_rate_limit_failures_actor_occurred",
        table_name="lifecycle_rate_limit_failures",
    )
    op.drop_table("lifecycle_rate_limit_failures")
    op.drop_table("lifecycle_rate_limit_buckets")
    op.drop_table("lifecycle_confirmation_challenges")
    op.drop_index("ix_identity_sessions_user_active", table_name="identity_sessions")
    op.drop_table("identity_sessions")
    op.drop_table("identity_mfa_observations")
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
    op.drop_index(
        "uq_backup_runs_unresolved",
        table_name="backup_runs",
        postgresql_where=sa.text("started_at IS NOT NULL AND reconciled_at IS NULL"),
    )
    op.drop_index("ix_backup_runs_requester_id", table_name="backup_runs")
    op.drop_index("ix_backup_runs_queue", table_name="backup_runs")
    op.drop_table("backup_runs")
    op.drop_index("ix_audit_logs_request", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity", table_name="audit_logs")
    op.drop_index("ix_audit_logs_department_created_at_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_created_at_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_index(op.f("ix_users_username"), table_name="users")
    op.drop_index(op.f("ix_users_supabase_user_id"), table_name="users")
    op.drop_index(op.f("ix_users_email"), table_name="users")
    op.drop_index(op.f("ix_users_avatar_file_id"), table_name="users")
    op.drop_table("users")
    op.drop_table("update_statuses")
    op.drop_table("platform_settings")
    op.drop_table("organizations")
    op.drop_index(
        op.f("ix_identity_rate_limit_buckets_window_started_at"),
        table_name="identity_rate_limit_buckets",
    )
    op.drop_table("identity_rate_limit_buckets")
    op.drop_table("backup_policies")
    # ### end Alembic commands ###


def _create_board_guards() -> None:
    op.execute("""
        CREATE FUNCTION public.board_record_link_guard() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        DECLARE owner_board uuid; source_module uuid;
        BEGIN
            IF TG_OP = 'UPDATE' AND (
                OLD.org_id IS DISTINCT FROM NEW.org_id OR
                OLD.board_id IS DISTINCT FROM NEW.board_id OR
                OLD.event_id IS DISTINCT FROM NEW.event_id OR
                OLD.post_id IS DISTINCT FROM NEW.post_id OR
                OLD.record_id IS DISTINCT FROM NEW.record_id OR
                OLD.module_id IS DISTINCT FROM NEW.module_id
            ) THEN
                RAISE EXCEPTION 'Board Record link owner is immutable' USING ERRCODE = '23514';
            END IF;
            IF NEW.event_id IS NOT NULL THEN
                SELECT board_id INTO owner_board FROM public.board_events
                WHERE org_id = NEW.org_id AND id = NEW.event_id;
            ELSE
                SELECT board_id INTO owner_board FROM public.board_posts
                WHERE org_id = NEW.org_id AND id = NEW.post_id;
            END IF;
            SELECT module_id INTO source_module FROM public.records
            WHERE org_id = NEW.org_id AND id = NEW.record_id;
            IF owner_board IS DISTINCT FROM NEW.board_id OR
               source_module IS DISTINCT FROM NEW.module_id THEN
                RAISE EXCEPTION 'Board Record link parent mismatch' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $guard$;
    """)
    op.execute("""
        CREATE FUNCTION public.board_revision_record_link_guard() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        DECLARE source_module uuid; current_link uuid;
        BEGIN
            IF TG_OP = 'UPDATE' THEN
                RAISE EXCEPTION 'Published Board Record links are immutable'
                    USING ERRCODE = '23514';
            END IF;
            SELECT module_id INTO source_module FROM public.records
            WHERE org_id = NEW.org_id AND id = NEW.record_id;
            SELECT link.id INTO current_link
            FROM public.board_record_links AS link
            JOIN public.board_post_revisions AS revision
              ON revision.org_id = link.org_id AND revision.post_id = link.post_id
            WHERE revision.org_id = NEW.org_id AND revision.id = NEW.revision_id
              AND link.record_id = NEW.record_id AND link.module_id = NEW.module_id;
            IF source_module IS DISTINCT FROM NEW.module_id OR current_link IS NULL THEN
                RAISE EXCEPTION 'Published Board Record link parent mismatch'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $guard$;
    """)
    op.execute("""
        CREATE FUNCTION public.reject_board_attachment_owner_change() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        BEGIN
            IF OLD.org_id IS DISTINCT FROM NEW.org_id
                OR OLD.board_id IS DISTINCT FROM NEW.board_id
                OR OLD.file_id IS DISTINCT FROM NEW.file_id
                OR OLD.event_id IS DISTINCT FROM NEW.event_id
                OR OLD.post_id IS DISTINCT FROM NEW.post_id THEN
                RAISE EXCEPTION 'board file content owner is immutable'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $guard$;
    """)
    op.execute("""
        CREATE FUNCTION public.reject_board_post_revision_update() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        BEGIN
            RAISE EXCEPTION 'published post revisions are immutable'
                USING ERRCODE = 'check_violation';
        END;
        $guard$;
    """)
    op.execute("""
        CREATE FUNCTION public.reject_file_board_move() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        BEGIN
            IF OLD.org_id IS DISTINCT FROM NEW.org_id OR
               OLD.board_id IS DISTINCT FROM NEW.board_id THEN
                RAISE EXCEPTION 'file board ownership is immutable'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $guard$;
    """)
    op.execute("""
        CREATE FUNCTION public.reject_revision_attachment_update() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        BEGIN
            RAISE EXCEPTION 'published attachment snapshots are immutable'
                USING ERRCODE = 'check_violation';
        END;
        $guard$;
    """)
    op.execute("""
        CREATE FUNCTION public.validate_board_attachment() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        DECLARE content_board uuid;
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM public.files AS f
                WHERE f.org_id = NEW.org_id AND f.id = NEW.file_id
                  AND f.board_id = NEW.board_id AND f.purpose = 'board_attachment'
            ) THEN
                RAISE EXCEPTION 'file does not belong to owning board'
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.event_id IS NOT NULL THEN
                SELECT board_id INTO content_board FROM public.board_events
                WHERE org_id = NEW.org_id AND id = NEW.event_id;
            ELSE
                SELECT board_id INTO content_board FROM public.board_posts
                WHERE org_id = NEW.org_id AND id = NEW.post_id;
            END IF;
            IF content_board IS DISTINCT FROM NEW.board_id THEN
                RAISE EXCEPTION 'content does not belong to owning board'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $guard$;
    """)
    op.execute("""
        CREATE FUNCTION public.validate_revision_attachment() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        DECLARE content_id uuid;
        BEGIN
            SELECT post_id INTO content_id FROM public.board_post_revisions
            WHERE org_id = NEW.org_id AND id = NEW.revision_id;
            IF NOT EXISTS (
                SELECT 1 FROM public.board_attachments AS a
                WHERE a.org_id = NEW.org_id AND a.file_id = NEW.file_id
                  AND a.post_id = content_id
            ) THEN
                RAISE EXCEPTION 'published file has a different content owner'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $guard$;
    """)
    for trigger, table, events, function in BOARD_TRIGGERS:
        op.execute(
            f"CREATE TRIGGER {trigger} BEFORE {events} ON public.{table} "
            f"FOR EACH ROW EXECUTE FUNCTION public.{function}()"
        )


def _create_retention_capability() -> None:
    # Preserve the existing install-wide capability; per-organization execution is S06.
    op.execute("""
        CREATE FUNCTION public.retain_security_events() RETURNS integer
        LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        SET TimeZone = 'UTC'
        AS $retention$
        DECLARE
            retention_days integer;
            as_of timestamptz;
            cutoff timestamptz;
            deleted_events integer;
            proof_id uuid;
            operation_id uuid;
        BEGIN
            IF NOT pg_catalog.pg_try_advisory_xact_lock(22328052256015694::bigint) THEN
                RETURN 0;
            END IF;
            SELECT p.security_event_retention_days INTO STRICT retention_days
            FROM public.platform_settings AS p WHERE p.singleton_key IS TRUE FOR SHARE;
            as_of := pg_catalog.transaction_timestamp();
            cutoff := as_of - pg_catalog.make_interval(days => retention_days);
            WITH candidates AS (
                SELECT e.id FROM public.security_events AS e
                WHERE e.occurred_at < cutoff
                ORDER BY e.occurred_at, e.id LIMIT 1000 FOR UPDATE OF e SKIP LOCKED
            ), deleted AS (
                DELETE FROM public.security_events AS e USING candidates AS c
                WHERE e.id = c.id RETURNING e.id
            )
            SELECT pg_catalog.count(*) INTO deleted_events FROM deleted;
            IF deleted_events = 0 THEN
                RETURN 0;
            END IF;
            proof_id := pg_catalog.gen_random_uuid();
            operation_id := pg_catalog.gen_random_uuid();
            IF proof_id = operation_id THEN
                RAISE EXCEPTION 'Unable to generate independent retention proof identifiers';
            END IF;
            INSERT INTO public.security_events (
                id, occurred_at, event_type, outcome, source, operation_id,
                actor_id, subject_id, labels, fingerprint, reason,
                request_id, request_method, request_path, metadata
            ) VALUES (
                proof_id, as_of, 'security.retention', 'success', 'security.event_retention',
                operation_id, NULL, NULL, '{}'::jsonb, NULL, NULL, NULL, NULL, NULL,
                pg_catalog.jsonb_build_object(
                    'scope', 'security_events', 'retention_days', retention_days,
                    'batch_limit', 1000, 'as_of', as_of, 'cutoff', cutoff,
                    'deleted_events', deleted_events
                )
            );
            RETURN deleted_events;
        END;
        $retention$;
    """)
    op.execute("ALTER FUNCTION public.retain_security_events() OWNER TO openslate_owner")


def _grant_application_privileges() -> None:
    tables = ", ".join(f"public.{table}" for table in APPLICATION_TABLES)
    mutable = ", ".join(
        f"public.{table}"
        for table in APPLICATION_TABLES
        if table not in {"audit_logs", "security_events"}
    )
    op.execute(f"REVOKE ALL ON TABLE {tables} FROM PUBLIC, anon, authenticated, service_role")
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE {mutable} TO openslate_app")
    op.execute(
        "GRANT SELECT, INSERT ON TABLE public.audit_logs, public.security_events TO openslate_app"
    )
    op.execute(
        "REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs, public.security_events "
        "FROM openslate_app"
    )
    op.execute(
        "REVOKE ALL ON TABLE public.alembic_version "
        "FROM PUBLIC, anon, authenticated, service_role, openslate_app"
    )
    op.execute("GRANT SELECT ON TABLE public.alembic_version TO openslate_app")
    functions = ", ".join(
        [f"public.{function}()" for _, _, _, function in BOARD_TRIGGERS]
        + ["public.retain_security_events()"]
    )
    op.execute(f"REVOKE ALL ON FUNCTION {functions} FROM PUBLIC, anon, authenticated, service_role")
    op.execute(f"GRANT EXECUTE ON FUNCTION {functions} TO openslate_app")
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
