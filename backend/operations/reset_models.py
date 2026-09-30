"""Static configuration, SQL statements, and snapshots for the local reset utility."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

EXPECTED_DATABASE_USER = "openslate_owner"

APPLICATION_TABLES = (
    "audit_logs",
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
    "dashboards",
    "departments",
    "fields",
    "files",
    "group_access",
    "group_members",
    "groups",
    "in_app_notifications",
    "identity_rate_limit_buckets",
    "identity_sessions",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_buckets",
    "lifecycle_rate_limit_failures",
    "modules",
    "record_trigger_actions",
    "record_trigger_conditions",
    "record_trigger_events",
    "record_trigger_runs",
    "record_triggers",
    "records",
    "report_run_eligible_users",
    "report_run_rows",
    "report_runs",
    "report_schedules",
    "reports",
    "relationship_edges",
    "sandbox_bindings",
    "sandbox_documents",
    "sandbox_publications",
    "sandbox_test_runs",
    "sandbox_versions",
    "saved_views",
    "scheduled_work",
    "security_events",
    "users",
    "workspace_profiles",
)
NON_PRESERVED_TABLES = tuple(
    table
    for table in APPLICATION_TABLES
    if table
    not in {
        "boards",
        "sandbox_documents",
        "sandbox_versions",
        "users",
        "workspace_profiles",
    }
)
DELETE_ORDER = (
    "board_groups",
    "group_access",
    "group_members",
    "groups",
    "identity_sessions",
    "identity_rate_limit_buckets",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_failures",
    "lifecycle_rate_limit_buckets",
    "sandbox_test_runs",
    "record_trigger_runs",
    "record_trigger_events",
    "sandbox_bindings",
    "record_trigger_actions",
    "record_trigger_conditions",
    "record_triggers",
    "sandbox_publications",
    "sandbox_versions",
    "saved_views",
    "in_app_notifications",
    "report_schedules",
    "scheduled_work",
    "board_event_reminders",
    "board_post_revision_attachments",
    "board_post_revision_record_links",
    "board_post_revisions",
    "board_attachments",
    "board_record_links",
    "board_posts",
    "board_events",
    "board_widgets",
    "files",
    "boards",
    "dashboard_widgets",
    "dashboards",
    "report_run_eligible_users",
    "report_run_rows",
    "report_runs",
    "reports",
    "relationship_edges",
    "audit_logs",
    "security_events",
    "records",
    "fields",
    "modules",
    "departments",
)

_RESET_ADVISORY_LOCK_KEY = 8_341_721
_SCANNER_LEADER_LOCK_KEY = 57_168_423_129_478_012
_COUNT_STATEMENTS = tuple(
    (table, f"SELECT count(*) FROM public.{table}") for table in APPLICATION_TABLES
)
_PUBLIC_TABLES_STATEMENT = """
SELECT table_name FROM information_schema.tables
 WHERE table_schema = %s AND table_type = 'BASE TABLE'
"""
_ALEMBIC_HEAD_STATEMENT = "SELECT version_num FROM public.alembic_version"
_PROFILE_STATEMENT = """
SELECT id, created_at, deleted_at, is_deleted, updated_at, performed_by,
       email, supabase_user_id, username, status, role, display_name, job_title,
       sponsor_user_id, expires_at, invitation_sent_at, invitation_accepted_at,
       tokens_valid_after
  FROM public.users WHERE id = %s
"""
_PROVIDER_SUBJECTS_STATEMENT = """
SELECT id, supabase_user_id FROM public.users WHERE id <> %s ORDER BY id
"""
_WORKSPACE_STATEMENT = """
SELECT id, singleton_key, display_name, legal_name, description, contact_email,
       contact_phone, postal_address, logo_file_id, timezone, locale, revision,
       deleted_at, is_deleted, performed_by, invitation_expiry_days, guest_duration_days
  FROM public.workspace_profiles
"""
_EFFECTIVE_ADMIN_PROFILES_STATEMENT = """
SELECT profile.id FROM public.users AS profile
WHERE profile.id <> %s AND profile.status = 'active' AND profile.is_deleted = false
  AND profile.role = 'admin'
"""
_PROFILE_DELETE_COUNTS_STATEMENT = """
SELECT count(*) FILTER (WHERE profile.id <> %s),
       count(*) FILTER (WHERE profile.id <> %s
          AND NOT (profile.status = 'active' AND profile.is_deleted = false)
          AND profile.role = 'admin')
FROM public.users AS profile
"""
_LOCK_APPLICATION_STATEMENT = """
LOCK TABLE public.alembic_version, public.audit_logs,
 public.board_attachments, public.board_event_reminders, public.board_events,
 public.board_groups, public.board_post_revision_attachments,
 public.board_post_revision_record_links,
 public.board_post_revisions, public.board_posts,
 public.board_record_links, public.board_widgets, public.boards,
 public.dashboard_widgets, public.dashboards,
 public.departments, public.fields,
 public.files, public.group_access, public.group_members, public.groups,
 public.in_app_notifications,
 public.identity_rate_limit_buckets, public.identity_sessions,
 public.lifecycle_confirmation_challenges, public.lifecycle_rate_limit_buckets,
 public.lifecycle_rate_limit_failures, public.modules, public.records,
 public.report_run_eligible_users, public.report_run_rows, public.report_runs,
 public.record_trigger_actions, public.record_trigger_conditions,
 public.record_trigger_events, public.record_trigger_runs, public.record_triggers,
 public.report_schedules, public.reports,
 public.relationship_edges,
 public.sandbox_bindings, public.sandbox_documents, public.sandbox_publications,
 public.sandbox_test_runs, public.sandbox_versions,
 public.saved_views, public.scheduled_work,
 public.security_events, public.users, public.workspace_profiles
 IN ACCESS EXCLUSIVE MODE NOWAIT
"""


class ResetError(RuntimeError):
    """A safe operational error raised by the local reset utility."""


@dataclass(frozen=True)
class ProfileSnapshot:
    id: UUID
    created_at: object
    deleted_at: object
    is_deleted: object
    updated_at: object
    performed_by: object
    email: object
    supabase_user_id: UUID | None
    username: object
    status: object
    role: object
    display_name: object
    job_title: object
    sponsor_user_id: object
    expires_at: object
    invitation_sent_at: object
    invitation_accepted_at: object
    tokens_valid_after: object


@dataclass(frozen=True)
class WorkspaceSnapshot:
    id: UUID
    singleton_key: object
    display_name: object
    legal_name: object
    description: object
    contact_email: object
    contact_phone: object
    postal_address: object
    logo_file_id: object
    timezone: object
    locale: object
    revision: object
    deleted_at: object
    is_deleted: object
    performed_by: object
    invitation_expiry_days: object
    guest_duration_days: object


def stable_snapshot_payload(snapshot: object) -> dict[str, object]:
    """Return a deterministic, JSON-safe snapshot without printing its contents."""

    def stable(value: object) -> object:
        if isinstance(value, UUID):
            return str(value)
        if isinstance(value, Mapping):
            return {str(key): stable(item) for key, item in sorted(value.items(), key=str)}
        if isinstance(value, (list, tuple)):
            return [stable(item) for item in value]
        isoformat = getattr(value, "isoformat", None)
        return (
            isoformat()
            if callable(isoformat)
            else value
            if value is None or isinstance(value, (str, int, float, bool))
            else str(value)
        )

    fields = getattr(snapshot, "__dataclass_fields__", None)
    names = fields.keys() if fields is not None else vars(snapshot).keys()
    return {name: stable(getattr(snapshot, name)) for name in names}


@dataclass(frozen=True)
class ResetPlan:
    """Immutable read-only reset plan and the local identity it protects."""

    sample_email: str
    counts: Mapping[str, int]
    profiles_to_delete: int
    inactive_admin_profiles_to_delete: int
    impact_digest: str
    preserved_admin_id: UUID
    preserved_admin_provider_id: UUID
    provider_subjects: tuple[tuple[UUID, UUID | None], ...]
    profile_snapshot: ProfileSnapshot
    workspace_snapshot: WorkspaceSnapshot
    storage_object_keys: tuple[str, ...]
    alembic_head: str
    provider_account_ids: tuple[UUID, ...] = ()
