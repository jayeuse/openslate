"""organization row-level security

Revision ID: f5a100021193
Revises: ffe73dc0240d
Create Date: 2026-10-16 09:00:00.000000

Every organization table admits the application role only to rows of the
organization bound to the transaction (``openslate.org_id``). Without that setting
no organization row matches, so a forgotten scope fails closed. The owner role
keeps migration and maintenance access: RLS is enabled without ``FORCE``.

Memberships stay unprotected because account reads list one person's memberships
across organizations before any organization is chosen. Mixed tables also admit
rows without an organization. Audit and security events accept inserts for any
organization, because one action (for example accepting an invitation) records
events for an organization other than the bound one; reads stay scoped.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f5a100021193"
down_revision: str | None = "ffe73dc0240d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCOPE = "(SELECT nullif(current_setting('openslate.org_id', true), '')::uuid)"
OWNED = f"org_id = {SCOPE}"
OWNED_OR_SHARED = f"(org_id IS NULL OR org_id = {SCOPE})"

ORGANIZATION_TABLES = (
    "board_attachments", "board_event_reminders", "board_events", "board_groups",
    "board_post_revision_attachments", "board_post_revision_record_links",
    "board_post_revisions", "board_posts", "board_record_links", "board_widgets", "boards",
    "charts", "dashboard_widgets", "dashboards", "departments", "fields", "group_access",
    "group_members", "groups", "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_buckets", "lifecycle_rate_limit_failures", "modules",
    "record_trigger_actions", "record_trigger_conditions", "record_trigger_events",
    "record_trigger_runs", "record_triggers", "records", "relationship_edges",
    "report_run_eligible_users", "report_run_rows", "report_runs", "report_schedules",
    "reports", "sandbox_bindings", "sandbox_documents", "sandbox_publications",
    "sandbox_test_runs", "sandbox_versions", "saved_views", "scheduled_work",
)
MIXED_TABLES = ("files", "in_app_notifications")
APPEND_ONLY_TABLES = ("audit_logs", "security_events")


def upgrade() -> None:
    for table in ORGANIZATION_TABLES:
        _enable(table)
        op.execute(
            f"CREATE POLICY organization_rows ON public.{table} TO openslate_app "
            f"USING ({OWNED}) WITH CHECK ({OWNED})"
        )
    for table in MIXED_TABLES:
        _enable(table)
        op.execute(
            f"CREATE POLICY organization_rows ON public.{table} TO openslate_app "
            f"USING {OWNED_OR_SHARED} WITH CHECK {OWNED_OR_SHARED}"
        )
    for table in APPEND_ONLY_TABLES:
        _enable(table)
        op.execute(
            f"CREATE POLICY organization_rows ON public.{table} FOR SELECT TO openslate_app "
            f"USING {OWNED_OR_SHARED}"
        )
        op.execute(
            f"CREATE POLICY organization_appends ON public.{table} FOR INSERT "
            "TO openslate_app WITH CHECK (true)"
        )


def downgrade() -> None:
    for table in APPEND_ONLY_TABLES:
        op.execute(f"DROP POLICY organization_appends ON public.{table}")
    for table in (*ORGANIZATION_TABLES, *MIXED_TABLES, *APPEND_ONLY_TABLES):
        op.execute(f"DROP POLICY organization_rows ON public.{table}")
        op.execute(f"ALTER TABLE public.{table} DISABLE ROW LEVEL SECURITY")


def _enable(table: str) -> None:
    op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
