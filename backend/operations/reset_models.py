"""Static configuration, SQL statements, and snapshots for the local reset utility."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

EXPECTED_DATABASE_HOST = "127.0.0.1"
EXPECTED_DATABASE_PORT = 54322
EXPECTED_DATABASE_NAME = "openslate"
EXPECTED_DATABASE_USER = "openslate_owner"

APPLICATION_TABLES = (
    "audit_logs",
    "departments",
    "fields",
    "files",
    "identity_action_tokens",
    "identity_credentials",
    "identity_delivery_outbox",
    "identity_rate_limit_buckets",
    "identity_sessions",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_buckets",
    "lifecycle_rate_limit_failures",
    "modules",
    "published_automation_actions",
    "published_automation_conditions",
    "published_automation_definitions",
    "published_automation_events",
    "published_automation_runs",
    "records",
    "relationship_edges",
    "roles",
    "sandbox_bindings",
    "sandbox_documents",
    "sandbox_publications",
    "sandbox_test_runs",
    "sandbox_versions",
    "saved_views",
    "security_events",
    "users",
    "workspace_profiles",
)
NON_PRESERVED_TABLES = tuple(
    table
    for table in APPLICATION_TABLES
    if table
    not in {
        "identity_credentials",
        "roles",
        "sandbox_documents",
        "sandbox_versions",
        "users",
        "workspace_profiles",
    }
)
DELETE_ORDER = (
    "identity_sessions",
    "identity_delivery_outbox",
    "identity_action_tokens",
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
    "saved_views",
    "relationship_edges",
    "audit_logs",
    "security_events",
    "files",
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
       email, username, status, role_id
  FROM public.users WHERE id = %s
"""
_CREDENTIAL_STATEMENT = """
SELECT user_id, password_digest, must_change_password,
       temporary_password_expires_at, password_changed_at
  FROM public.identity_credentials WHERE user_id = %s
"""
_WORKSPACE_STATEMENT = """
SELECT id, singleton_key, display_name, legal_name, description, contact_email,
       contact_phone, postal_address, logo_file_id, timezone, locale, revision,
       deleted_at, is_deleted, performed_by
  FROM public.workspace_profiles
"""
_ROLES_STATEMENT = """
SELECT id, created_at, deleted_at, is_deleted, updated_at, performed_by, role, permissions
  FROM public.roles
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
LOCK TABLE public.alembic_version, public.audit_logs, public.departments, public.fields,
 public.files, public.identity_action_tokens, public.identity_delivery_outbox,
 public.identity_credentials, public.identity_rate_limit_buckets, public.identity_sessions,
 public.lifecycle_confirmation_challenges, public.lifecycle_rate_limit_buckets,
 public.lifecycle_rate_limit_failures, public.modules, public.records,
 public.published_automation_actions, public.published_automation_conditions,
 public.published_automation_definitions, public.published_automation_events,
 public.published_automation_runs, public.relationship_edges, public.roles,
 public.sandbox_bindings, public.sandbox_documents, public.sandbox_publications,
 public.sandbox_test_runs, public.sandbox_versions, public.saved_views,
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
    username: object
    status: object
    role_id: UUID


@dataclass(frozen=True)
class CredentialSnapshot:
    user_id: UUID
    password_digest: object
    must_change_password: object
    temporary_password_expires_at: object
    password_changed_at: object


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
    preserved_admin_role_id: UUID
    preserved_member_role_id: UUID
    profile_snapshot: ProfileSnapshot
    credential_snapshot: CredentialSnapshot
    admin_role_snapshot: RoleSnapshot
    member_role_snapshot: RoleSnapshot
    workspace_snapshot: WorkspaceSnapshot
    storage_object_keys: tuple[str, ...]
    alembic_head: str
