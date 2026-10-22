"""The fresh application schema preserves organization ownership at the database boundary."""

import pytest
from sqlalchemy import inspect, text

pytestmark = pytest.mark.integration

# S15's accepted inventory without D44's dropped channel access table; row-security imports
# this same organization inventory.
COMMS_TABLES = frozenset(
    "comms_categories comms_conversations comms_members "
    "comms_direct_blocks comms_settings comms_setting_locks comms_capability_grants "
    "comms_personal_preferences comms_member_preferences comms_read_states "
    "comms_conversation_counters comms_threads comms_thread_follows comms_messages "
    "comms_message_revisions comms_reactions comms_mentions comms_message_attachments "
    "comms_message_record_links".split()
)

# S04 proves schema ownership and paired keys; test_organization_row_security proves RLS.
ORGANIZATION_TABLES = (
    frozenset(
        "audit_logs board_attachments board_event_reminders board_events board_groups "
        "board_post_revision_attachments board_post_revision_record_links board_post_revisions "
        "board_posts board_record_links board_widgets boards charts dashboard_widgets dashboards "
        "departments fields files group_access group_members groups in_app_notifications "
        "lifecycle_confirmation_challenges lifecycle_rate_limit_buckets "
        "lifecycle_rate_limit_failures memberships modules record_trigger_actions "
        "record_trigger_conditions record_trigger_events "
        "record_trigger_runs record_triggers records relationship_edges report_run_eligible_users "
        "report_run_rows report_runs report_schedules reports sandbox_bindings sandbox_documents "
        "sandbox_publications sandbox_test_runs sandbox_versions saved_views scheduled_work "
        "security_events".split()
    )
    | COMMS_TABLES
    | {
        "comms_realtime_grants",
        "comms_realtime_admissions",
        "comms_presence",
        "comms_typing",
        "comms_reports",
        "comms_exports",
        "comms_export_sources",
        "comms_export_entries",
        "comms_schedules",
        "comms_retention_policies",
        "comms_retention_sweeps",
        "comms_expired_sends",
        "comms_templates",
        "comms_channel_access",
    }
)
MIXED_TABLES = frozenset({"audit_logs", "files", "security_events", "in_app_notifications"})


def test_root_schema_has_scoped_keys_without_organization_seeds(integration_owner_db):
    connection = integration_owner_db.connection()
    inspector = inspect(connection)
    tables = set(inspector.get_table_names(schema="public"))
    assert {"organizations", "platform_settings", "platform_operators"} <= tables
    assert "workspace_profiles" not in tables

    scoped = {}
    for table in tables:
        columns = {column["name"]: column for column in inspector.get_columns(table, "public")}
        if "org_id" in columns:
            scoped[table] = columns["org_id"]["nullable"]
    assert scoped == {table: table in MIXED_TABLES for table in ORGANIZATION_TABLES}

    for table in ORGANIZATION_TABLES:
        foreign_keys = inspector.get_foreign_keys(table, "public")
        assert any(
            key["constrained_columns"] == ["org_id"]
            and key["referred_table"] == "organizations"
            and key["referred_columns"] == ["id"]
            for key in foreign_keys
        ), table
        if table != "report_run_eligible_users":
            assert any(
                constraint["column_names"] == ["org_id", "id"]
                for constraint in inspector.get_unique_constraints(table, "public")
            ), table
        for key in foreign_keys:
            if key["referred_table"] in ORGANIZATION_TABLES:
                assert key["constrained_columns"][0] == "org_id", (table, key["name"])
                assert key["referred_columns"][0] == "org_id", (table, key["name"])

    user_columns = {column["name"] for column in inspector.get_columns("users", "public")}
    assert not user_columns & {
        "role",
        "sponsor_user_id",
        "expires_at",
        "invitation_sent_at",
        "invitation_accepted_at",
        "provider_invitation_operation_id",
        "mfa_required_since",
    }
    assert {"email", "username", "supabase_user_id", "status", "tokens_valid_after"} <= user_columns
    assert connection.scalar(text("SELECT count(*) FROM public.organizations")) == 0
    assert connection.scalar(text("SELECT count(*) FROM public.sandbox_documents")) == 0
    assert connection.scalar(text("SELECT count(*) FROM public.boards")) == 0
