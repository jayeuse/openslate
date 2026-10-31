"""soft delete pair checks

Every table with both soft-delete columns gets ``ck_<table>_deletion_state``, the check
that ``app/core/database/base.py`` adds to each such model (plan finding F7). Alembic
does not compare check constraints, so this revision is written by hand.

Each constraint is added NOT VALID in one short transaction, so no table is scanned
while its exclusive lock is held, then validated one table at a time outside it, which
does not block writes. A row that breaks the rule fails the validation and the upgrade;
the data is never repaired here. A failed upgrade leaves the constraints NOT VALID, and
a rerun after the data is fixed replaces them.

Revision ID: e10810d4789c
Revises: 48e05d7138d7
Create Date: 2026-10-31 18:20:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e10810d4789c"
down_revision: str | None = "48e05d7138d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHECK = "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)"
TABLES = (
    "backup_export_operations", "backup_policies", "backup_runs", "board_attachments",
    "board_calendar_sources", "board_card_checklist_items", "board_card_labels", "board_cards",
    "board_event_reminders", "board_events", "board_groups", "board_labels",
    "board_post_revision_attachments", "board_post_revision_record_links", "board_post_revisions",
    "board_posts", "board_record_links", "board_stages", "boards", "charts",
    "comms_capability_grants", "comms_categories", "comms_channel_access",
    "comms_conversation_counters", "comms_conversations", "comms_direct_blocks",
    "comms_expired_sends", "comms_export_entries", "comms_export_sources", "comms_exports",
    "comms_member_preferences", "comms_members", "comms_mentions", "comms_message_attachments",
    "comms_message_record_links", "comms_message_revisions", "comms_messages",
    "comms_personal_preferences", "comms_reactions", "comms_read_states", "comms_reports",
    "comms_retention_policies", "comms_retention_sweeps", "comms_schedules", "comms_setting_locks",
    "comms_settings", "comms_templates", "comms_thread_follows", "comms_threads",
    "dashboard_widgets", "dashboards", "departments", "fields", "files", "group_access",
    "group_members", "groups", "in_app_notifications", "memberships", "modules", "organizations",
    "platform_operators", "platform_settings", "record_trigger_actions",
    "record_trigger_conditions", "record_trigger_events", "record_trigger_runs", "record_triggers",
    "records", "relationship_edges", "report_run_rows", "report_runs", "report_schedules",
    "reports", "sandbox_bindings", "sandbox_documents", "sandbox_publications",
    "sandbox_test_runs", "sandbox_versions", "saved_views", "update_statuses", "users",
)


def upgrade() -> None:
    for table in TABLES:
        name = f"ck_{table}_deletion_state"
        op.execute(f"ALTER TABLE public.{table} DROP CONSTRAINT IF EXISTS {name}")
        op.execute(f"ALTER TABLE public.{table} ADD CONSTRAINT {name} CHECK ({CHECK}) NOT VALID")
    with op.get_context().autocommit_block():
        for table in TABLES:
            op.execute(
                f"ALTER TABLE public.{table} VALIDATE CONSTRAINT ck_{table}_deletion_state"
            )


def downgrade() -> None:
    for table in TABLES:
        op.execute(
            f"ALTER TABLE public.{table} DROP CONSTRAINT IF EXISTS ck_{table}_deletion_state"
        )
