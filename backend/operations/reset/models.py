"""Static configuration, SQL statements, and snapshots for the local reset utility."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from uuid import UUID

EXPECTED_DATABASE_USER = "openslate_owner"

APPLICATION_TABLES = (
    "audit_logs",
    "backup_export_operations",
    "backup_policies",
    "backup_runs",
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
    "charts",
    "comms_capability_grants",
    "comms_categories",
    "comms_conversation_counters",
    "comms_conversations",
    "comms_direct_blocks",
    "comms_member_preferences",
    "comms_members",
    "comms_mentions",
    "comms_message_attachments",
    "comms_message_record_links",
    "comms_message_revisions",
    "comms_messages",
    "comms_personal_preferences",
    "comms_reactions",
    "comms_read_states",
    "comms_setting_locks",
    "comms_settings",
    "comms_templates",
    "comms_thread_follows",
    "comms_threads",
    "dashboard_widgets",
    "dashboards",
    "departments",
    "fields",
    "files",
    "group_access",
    "group_members",
    "groups",
    "in_app_notifications",
    "identity_mfa_observations",
    "identity_rate_limit_buckets",
    "identity_sessions",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_buckets",
    "lifecycle_rate_limit_failures",
    "memberships",
    "modules",
    "organizations",
    "platform_operators",
    "platform_settings",
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
    "update_statuses",
    "users",
)
NON_PRESERVED_TABLES = tuple(
    table
    for table in APPLICATION_TABLES
    if table
    not in {
        "backup_export_operations",
        "backup_policies",
        "backup_runs",
        "platform_operators",
        "platform_settings",
        "update_statuses",
        "users",
    }
)
DELETE_ORDER = (
    "comms_templates",
    "comms_message_attachments",
    "comms_message_record_links",
    "comms_message_revisions",
    "comms_reactions",
    "comms_mentions",
    "comms_thread_follows",
    "comms_threads",
    "comms_read_states",
    "comms_member_preferences",
    "comms_members",
    "comms_conversation_counters",
    # Reset deletes the whole table in one statement, including roots and quotes.
    "comms_messages",
    "comms_capability_grants",
    "comms_setting_locks",
    "comms_settings",
    "comms_personal_preferences",
    "comms_direct_blocks",
    "board_groups",
    "group_access",
    "group_members",
    "groups",
    "identity_sessions",
    "identity_mfa_observations",
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
    "sandbox_documents",
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
    "comms_conversations",
    "comms_categories",
    "boards",
    "dashboard_widgets",
    "dashboards",
    "charts",
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
    "memberships",
    "organizations",
)

_RESET_ADVISORY_LOCK_KEY = 8_341_721
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
       email, supabase_user_id, username, status, display_name, job_title, phone, bio,
       theme_preference, appearance, avatar_file_id, tokens_valid_after
  FROM public.users WHERE id = %s
"""
_PROVIDER_SUBJECTS_STATEMENT = """
SELECT id, supabase_user_id FROM public.users WHERE id <> %s ORDER BY id
"""
_OPERATOR_STATEMENT = """
SELECT id FROM public.platform_operators WHERE user_id = %s AND is_deleted = false
"""
_ORGANIZATIONS_STATEMENT = """
SELECT to_jsonb(organization) FROM public.organizations AS organization ORDER BY id
"""
_EFFECTIVE_OPERATOR_PROFILES_STATEMENT = """
SELECT profile.id FROM public.users AS profile
WHERE profile.id <> %s AND profile.status = 'active' AND profile.is_deleted = false
  AND EXISTS (SELECT 1 FROM public.platform_operators AS operator
               WHERE operator.user_id = profile.id AND operator.is_deleted = false)
"""
_PROFILE_DELETE_COUNTS_STATEMENT = """
SELECT count(*) FILTER (WHERE profile.id <> %s),
       count(*) FILTER (WHERE profile.id <> %s
          AND NOT (profile.status = 'active' AND profile.is_deleted = false)
          AND EXISTS (SELECT 1 FROM public.platform_operators AS operator
                       WHERE operator.user_id = profile.id AND operator.is_deleted = false))
FROM public.users AS profile
"""
_LOCK_APPLICATION_STATEMENT = """
LOCK TABLE public.alembic_version, public.audit_logs,
 public.backup_export_operations, public.backup_policies, public.backup_runs,
 public.update_statuses,
 public.board_attachments, public.board_event_reminders, public.board_events,
 public.board_groups, public.board_post_revision_attachments,
 public.board_post_revision_record_links,
 public.board_post_revisions, public.board_posts,
  public.board_record_links, public.board_widgets, public.boards, public.charts,
   public.comms_templates,
   public.comms_capability_grants, public.comms_categories,
  public.comms_conversation_counters,
  public.comms_conversations, public.comms_direct_blocks,
  public.comms_member_preferences, public.comms_members, public.comms_mentions,
  public.comms_message_attachments, public.comms_message_record_links,
  public.comms_message_revisions, public.comms_messages,
  public.comms_personal_preferences, public.comms_reactions, public.comms_read_states,
  public.comms_setting_locks, public.comms_settings,
  public.comms_thread_follows, public.comms_threads,
 public.dashboard_widgets, public.dashboards,
 public.departments, public.fields,
 public.files, public.group_access, public.group_members, public.groups,
 public.in_app_notifications,
 public.identity_rate_limit_buckets, public.identity_sessions,
 public.identity_mfa_observations,
 public.lifecycle_confirmation_challenges, public.lifecycle_rate_limit_buckets,
  public.lifecycle_rate_limit_failures, public.memberships, public.modules, public.records,
  public.organizations, public.platform_operators, public.platform_settings,
 public.report_run_eligible_users, public.report_run_rows, public.report_runs,
 public.record_trigger_actions, public.record_trigger_conditions,
 public.record_trigger_events, public.record_trigger_runs, public.record_triggers,
 public.report_schedules, public.reports,
 public.relationship_edges,
 public.sandbox_bindings, public.sandbox_documents, public.sandbox_publications,
 public.sandbox_test_runs, public.sandbox_versions,
 public.saved_views, public.scheduled_work,
  public.security_events, public.users
 IN ACCESS EXCLUSIVE MODE NOWAIT
"""


class ResetError(RuntimeError):
    """A safe operational error raised by the local reset utility."""


@dataclass(frozen=True)
class BackupSnapshot:
    """Whole-row metadata kept only in memory, never included in plan output."""

    installation_id: str
    rows: tuple[tuple[str, tuple[str, ...]], ...] = field(repr=False)


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
    display_name: object
    job_title: object
    phone: object
    bio: object
    theme_preference: object
    appearance: object
    avatar_file_id: object
    tokens_valid_after: object


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
    inactive_operator_profiles_to_delete: int
    impact_digest: str
    preserved_admin_id: UUID
    preserved_admin_provider_id: UUID
    preserved_operator_id: UUID
    provider_subjects: tuple[tuple[UUID, UUID | None], ...]
    profile_snapshot: ProfileSnapshot
    # Every organization row the reset deletes, frozen so any change needs a fresh preview.
    organization_snapshot: tuple[str, ...] = field(repr=False)
    storage_object_keys: tuple[str, ...]
    alembic_head: str
    backup_snapshot: BackupSnapshot
    provider_account_ids: tuple[UUID, ...] = ()
