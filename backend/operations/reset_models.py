"""Static configuration, SQL statements, and snapshots for the local reset utility."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

EXPECTED_DATABASE_USER = "openslate_owner"

APPLICATION_TABLES = (
    "access_default_departments",
    "access_default_groups",
    "access_group_members",
    "access_groups",
    "access_policy_defaults",
    "access_policy_versions",
    "access_rules",
    "audit_logs",
    "board_announcement_personal_states",
    "board_announcement_revision_attachments",
    "board_announcement_revision_record_links",
    "board_announcement_revisions",
    "board_announcements",
    "board_content_attachments",
    "board_content_record_links",
    "board_event_reminders",
    "board_events",
    "board_favorites",
    "board_grants",
    "board_homes",
    "board_record_placements",
    "board_templates",
    "board_widgets",
    "boards",
    "dashboard_defaults",
    "dashboard_widgets",
    "dashboards",
    "departments",
    "fields",
    "files",
    "in_app_notifications",
    "identity_rate_limit_buckets",
    "identity_sessions",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_buckets",
    "lifecycle_rate_limit_failures",
    "modules",
    "openview_chart_preferences",
    "published_automation_actions",
    "published_automation_conditions",
    "published_automation_definitions",
    "published_automation_events",
    "published_automation_runs",
    "records",
    "report_run_eligible_users",
    "report_run_rows",
    "report_runs",
    "report_schedules",
    "reports",
    "relationship_edges",
    "roles",
    "sandbox_bindings",
    "sandbox_documents",
    "sandbox_publications",
    "sandbox_test_runs",
    "sandbox_versions",
    "saved_view_defaults",
    "saved_views",
    "scheduled_work",
    "security_events",
    "service_identities",
    "user_departments",
    "users",
    "workspace_profiles",
)
NON_PRESERVED_TABLES = tuple(
    table
    for table in APPLICATION_TABLES
    if table
    not in {
        "access_policy_defaults",
        "access_policy_versions",
        "roles",
        "sandbox_documents",
        "sandbox_versions",
        "users",
        "workspace_profiles",
    }
)
DELETE_ORDER = (
    "access_group_members",
    "access_default_groups",
    "access_default_departments",
    "user_departments",
    "service_identities",
    "access_rules",
    "access_groups",
    "identity_sessions",
    "identity_rate_limit_buckets",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_failures",
    "lifecycle_rate_limit_buckets",
    "sandbox_test_runs",
    "published_automation_runs",
    "published_automation_events",
    "sandbox_bindings",
    "published_automation_actions",
    "published_automation_conditions",
    "published_automation_definitions",
    "sandbox_publications",
    "sandbox_versions",
    "saved_view_defaults",
    "saved_views",
    "in_app_notifications",
    "report_schedules",
    "scheduled_work",
    "board_event_reminders",
    "board_announcement_personal_states",
    "board_announcement_revision_attachments",
    "board_announcement_revision_record_links",
    "board_announcement_revisions",
    "board_content_attachments",
    "board_content_record_links",
    "board_announcements",
    "board_events",
    "board_favorites",
    "board_grants",
    "board_homes",
    "board_record_placements",
    "board_templates",
    "board_widgets",
    "files",
    "boards",
    "openview_chart_preferences",
    "dashboard_defaults",
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
ACCESS_POLICY_DEFAULTS_ID = UUID("00000000-0000-7000-8000-000000000004")
ACCESS_POLICY_VERSION_ID = UUID("00000000-0000-0000-0000-000000000001")
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
       email, supabase_user_id, username, status, role_id, display_name, identity_kind, job_title,
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
       deleted_at, is_deleted, performed_by
  FROM public.workspace_profiles
"""
_ROLES_STATEMENT = """
SELECT id, created_at, deleted_at, is_deleted, updated_at, performed_by, role, permissions,
       description
  FROM public.roles
"""
_ACCESS_POLICY_DEFAULTS_STATEMENT = """
SELECT id, singleton_key, default_role_id, invitation_expiry_days, guest_duration_days,
       service_duration_days, default_deny, require_guest_sponsor, require_service_owner,
       revision, created_at, deleted_at, is_deleted, updated_at, performed_by
  FROM public.access_policy_defaults
"""
_ACCESS_POLICY_VERSION_STATEMENT = """
SELECT id, singleton_key, revision, created_at, deleted_at, is_deleted, updated_at, performed_by
  FROM public.access_policy_versions
"""
_EFFECTIVE_ADMIN_PROFILES_STATEMENT = """
SELECT profile.id FROM public.users AS profile
JOIN public.roles AS role ON role.id = profile.role_id
WHERE profile.id <> %s AND profile.status = 'active' AND profile.is_deleted = false
  AND role.role = 'admin' AND role.is_deleted = false
"""
_PROFILE_DELETE_COUNTS_STATEMENT = """
SELECT count(*) FILTER (WHERE profile.id <> %s),
       count(*) FILTER (WHERE profile.id <> %s
          AND NOT (profile.status = 'active' AND profile.is_deleted = false)
          AND role.role = 'admin' AND role.is_deleted = false)
FROM public.users AS profile JOIN public.roles AS role ON role.id = profile.role_id
"""
_LOCK_APPLICATION_STATEMENT = """
LOCK TABLE public.alembic_version, public.audit_logs,
 public.board_announcement_personal_states,
 public.board_announcement_revision_attachments,
 public.board_announcement_revision_record_links,
 public.board_announcement_revisions, public.board_announcements,
 public.board_content_attachments,
 public.board_content_record_links,
 public.board_grants, public.board_event_reminders, public.board_events,
 public.board_favorites, public.board_homes,
 public.board_record_placements,
 public.board_templates, public.board_widgets, public.boards,
 public.dashboard_defaults, public.dashboard_widgets, public.dashboards,
 public.departments, public.fields,
 public.files, public.in_app_notifications,
 public.openview_chart_preferences,
 public.identity_rate_limit_buckets, public.identity_sessions,
 public.access_default_departments, public.access_default_groups, public.access_group_members,
 public.access_groups, public.access_policy_defaults, public.access_policy_versions,
 public.access_rules,
 public.lifecycle_confirmation_challenges, public.lifecycle_rate_limit_buckets,
 public.lifecycle_rate_limit_failures, public.modules, public.records,
 public.report_run_eligible_users, public.report_run_rows, public.report_runs,
 public.report_schedules, public.reports,
 public.published_automation_actions, public.published_automation_conditions,
 public.published_automation_definitions, public.published_automation_events,
 public.published_automation_runs, public.relationship_edges, public.roles,
 public.sandbox_bindings, public.sandbox_documents, public.sandbox_publications,
 public.sandbox_test_runs, public.sandbox_versions, public.saved_view_defaults,
 public.saved_views, public.scheduled_work,
 public.security_events, public.service_identities, public.user_departments,
 public.users, public.workspace_profiles
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
    role_id: UUID
    display_name: object
    identity_kind: object
    job_title: object
    sponsor_user_id: object
    expires_at: object
    invitation_sent_at: object
    invitation_accepted_at: object
    tokens_valid_after: object


@dataclass(frozen=True)
class RoleSnapshot:
    id: UUID
    created_at: object
    deleted_at: object
    is_deleted: object
    updated_at: object
    performed_by: object
    role: object
    permissions: object
    description: object


@dataclass(frozen=True)
class AccessPolicyDefaultsSnapshot:
    id: UUID
    singleton_key: object
    default_role_id: UUID
    invitation_expiry_days: object
    guest_duration_days: object
    service_duration_days: object
    default_deny: object
    require_guest_sponsor: object
    require_service_owner: object
    revision: object
    created_at: object
    deleted_at: object
    is_deleted: object
    updated_at: object
    performed_by: object


@dataclass(frozen=True)
class AccessPolicyVersionSnapshot:
    id: UUID
    singleton_key: object
    revision: object
    created_at: object
    deleted_at: object
    is_deleted: object
    updated_at: object
    performed_by: object


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
    preserved_admin_role_id: UUID
    preserved_member_role_id: UUID
    profile_snapshot: ProfileSnapshot
    admin_role_snapshot: RoleSnapshot
    member_role_snapshot: RoleSnapshot
    workspace_snapshot: WorkspaceSnapshot
    access_policy_defaults_snapshot: AccessPolicyDefaultsSnapshot
    access_policy_version_snapshot: AccessPolicyVersionSnapshot
    storage_object_keys: tuple[str, ...]
    alembic_head: str
