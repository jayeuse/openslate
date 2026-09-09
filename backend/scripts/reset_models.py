"""Static configuration, SQL statements, and snapshots for the reset utility."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

EXPECTED_ALEMBIC_HEAD = "fc105d5b6283"
EXPECTED_PROJECT_ID = "openslate"
EXPECTED_DATABASE_PORT = 54322
EXPECTED_DATABASE_HOST = "127.0.0.1"
EXPECTED_DATABASE_NAME = "postgres"

APPLICATION_TABLES = (
    "users",
    "roles",
    "departments",
    "modules",
    "fields",
    "records",
    "audit_logs",
    "security_events",
    "relationship_edges",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_buckets",
    "lifecycle_rate_limit_failures",
)
NON_PRESERVED_TABLES = (
    "departments",
    "modules",
    "fields",
    "records",
    "audit_logs",
    "security_events",
    "relationship_edges",
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_buckets",
    "lifecycle_rate_limit_failures",
)
DELETE_ORDER = (
    "lifecycle_confirmation_challenges",
    "lifecycle_rate_limit_failures",
    "lifecycle_rate_limit_buckets",
    "relationship_edges",
    "audit_logs",
    "security_events",
    "records",
    "fields",
    "modules",
    "departments",
    "users",
    "roles",
)

_RESET_ADVISORY_LOCK_KEY = 8_341_721
_COUNT_STATEMENTS = (
    ("users", "SELECT count(*) FROM public.users"),
    ("roles", "SELECT count(*) FROM public.roles"),
    ("departments", "SELECT count(*) FROM public.departments"),
    ("modules", "SELECT count(*) FROM public.modules"),
    ("fields", "SELECT count(*) FROM public.fields"),
    ("records", "SELECT count(*) FROM public.records"),
    ("audit_logs", "SELECT count(*) FROM public.audit_logs"),
    ("security_events", "SELECT count(*) FROM public.security_events"),
    ("relationship_edges", "SELECT count(*) FROM public.relationship_edges"),
    (
        "lifecycle_confirmation_challenges",
        "SELECT count(*) FROM public.lifecycle_confirmation_challenges",
    ),
    (
        "lifecycle_rate_limit_buckets",
        "SELECT count(*) FROM public.lifecycle_rate_limit_buckets",
    ),
    (
        "lifecycle_rate_limit_failures",
        "SELECT count(*) FROM public.lifecycle_rate_limit_failures",
    ),
)

_PUBLIC_TABLES_STATEMENT = """
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = %s
   AND table_type = 'BASE TABLE'
"""
_ALEMBIC_HEAD_STATEMENT = "SELECT version_num FROM public.alembic_version"
_AUTH_USERS_STATEMENT = """
SELECT id, email, email_confirmed_at, banned_until, deleted_at
  FROM auth.users
"""
_AUTH_USER_COUNT_STATEMENT = "SELECT count(*) FROM auth.users"
_PROFILE_STATEMENT = """
SELECT id, created_at, deleted_at, is_deleted, updated_at, performed_by,
       email, username, status, role_id
  FROM public.users
 WHERE id = %s
"""
_ROLES_STATEMENT = """
SELECT id, created_at, deleted_at, is_deleted, updated_at, performed_by,
       role, permissions
  FROM public.roles
"""
_EFFECTIVE_ADMIN_PROFILES_STATEMENT = """
SELECT profile.id
  FROM public.users AS profile
  JOIN public.roles AS role ON role.id = profile.role_id
 WHERE profile.id <> %s
   AND profile.status = 'active'
   AND profile.is_deleted = false
   AND role.role = 'admin'
   AND role.is_deleted = false
"""
_PROFILE_DELETE_COUNTS_STATEMENT = """
SELECT count(*) FILTER (WHERE profile.id <> %s),
       count(*) FILTER (
           WHERE profile.id <> %s
             AND NOT (profile.status = 'active' AND profile.is_deleted = false)
             AND role.role = 'admin'
             AND role.is_deleted = false
       )
  FROM public.users AS profile
  JOIN public.roles AS role ON role.id = profile.role_id
"""
_LOCK_AUTH_STATEMENT = "LOCK TABLE auth.users IN SHARE MODE NOWAIT"
_LOCK_APPLICATION_STATEMENT = """
LOCK TABLE public.alembic_version,
           public.users,
           public.roles,
           public.departments,
           public.modules,
           public.fields,
           public.records,
           public.audit_logs,
           public.security_events,
           public.relationship_edges,
           public.lifecycle_confirmation_challenges,
           public.lifecycle_rate_limit_buckets,
           public.lifecycle_rate_limit_failures
 IN ACCESS EXCLUSIVE MODE NOWAIT
"""


class ResetError(RuntimeError):
    """A safe operational error raised by the local reset utility."""


@dataclass(frozen=True)
class AuthSnapshot:
    id: UUID
    email: object
    email_confirmed_at: object
    banned_until: object
    deleted_at: object = None


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
class ResetPlan:
    """Immutable read-only reset plan and the state it protects."""

    sample_email: str
    counts: Mapping[str, int]
    profiles_to_delete: int
    inactive_admin_profiles_to_delete: int
    impact_digest: str
    preserved_admin_id: UUID
    preserved_admin_role_id: UUID
    preserved_member_role_id: UUID
    auth_user_count: int
    auth_identity: AuthSnapshot
    auth_identities: tuple[AuthSnapshot, ...]
    profile_snapshot: ProfileSnapshot
    admin_role_snapshot: RoleSnapshot
    member_role_snapshot: RoleSnapshot
    alembic_head: str
