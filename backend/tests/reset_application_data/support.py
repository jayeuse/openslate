"""Shared fakes and fixtures for reset utility contract tests."""
from __future__ import annotations

import re
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).parents[3]
EMAIL = "admin@example.test"
ADMIN_ID = UUID("00000000-0000-0000-0000-000000000101")
ADMIN_ROLE_ID = UUID("00000000-0000-0000-0000-000000000201")
MEMBER_ROLE_ID = UUID("00000000-0000-0000-0000-000000000202")
OTHER_ID = UUID("00000000-0000-0000-0000-000000000999")
PENDING_ADMIN_ID = UUID("00000000-0000-0000-0000-000000000301")
DISABLED_ADMIN_ID = UUID("00000000-0000-0000-0000-000000000302")
DELETED_ADMIN_ID = UUID("00000000-0000-0000-0000-000000000303")

CREATED_AT = datetime(2026, 8, 30, 0, 0, tzinfo=UTC)
UPDATED_AT = datetime(2026, 8, 30, 1, 0, tzinfo=UTC)
DELETED_AT = datetime(2026, 8, 30, 2, 0, tzinfo=UTC)

DATABASE_PASSWORD = "migration-password-must-not-leak"
STATUS_PASSWORD = "status-password-must-not-leak"
DATABASE_URL = (
    f"postgresql://postgres:{DATABASE_PASSWORD}@127.0.0.1:54322/postgres"
)
STATUS_URL = f"postgresql://postgres:{STATUS_PASSWORD}@127.0.0.1:54322/postgres"

APPLICATION_TABLES = {
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
}
NON_PRESERVED_TABLES = {
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
}
EXPECTED_CLEAN_COUNTS = {table: 0 for table in NON_PRESERVED_TABLES} | {
    "users": 1,
    "roles": 2,
}
DELETE_ORDER = [
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
]


def _auth_user(
    *,
    user_id: UUID = ADMIN_ID,
    email: str = EMAIL,
    confirmed: object = "2026-08-30T00:00:00+00:00",
    banned_until: object = None,
    deleted_at: object = None,
) -> dict[str, object]:
    return {
        "id": user_id,
        "email": email,
        "email_confirmed_at": confirmed,
        "banned_until": banned_until,
        "deleted_at": deleted_at,
    }


def _profile(
    *,
    user_id: UUID = ADMIN_ID,
    status: str = "active",
    is_deleted: bool = False,
    role_id: UUID = ADMIN_ROLE_ID,
    email: str = EMAIL,
    username: object = None,
    created_at: object = CREATED_AT,
    updated_at: object = UPDATED_AT,
    deleted_at: object = None,
    performed_by: UUID | None = None,
) -> dict[str, object]:
    return {
        "id": user_id,
        "status": status,
        "is_deleted": is_deleted,
        "role_id": role_id,
        "email": email,
        "username": username,
        "created_at": created_at,
        "updated_at": updated_at,
        "deleted_at": deleted_at,
        "performed_by": performed_by,
    }


def _role(
    role_id: UUID,
    name: str,
    *,
    is_deleted: bool = False,
    permissions: object = None,
    created_at: object = CREATED_AT,
    updated_at: object = UPDATED_AT,
    deleted_at: object = None,
    performed_by: UUID | None = None,
) -> dict[str, object]:
    return {
        "id": role_id,
        "role": name,
        "is_deleted": is_deleted,
        "permissions": permissions,
        "created_at": created_at,
        "updated_at": updated_at,
        "deleted_at": deleted_at,
        "performed_by": performed_by,
    }


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self._rows: list[tuple[object, ...]] = []
        self.rowcount = -1

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def close(self) -> None:
        return None

    def execute(self, statement: object, params: object = None) -> FakeCursor:
        query = " ".join(str(statement).split())
        self.connection.executed.append((query, params))

        delete_match = re.match(
            r"DELETE\s+FROM\s+public\.([a-z_]+)\b", query, flags=re.IGNORECASE
        )
        if delete_match:
            table = delete_match.group(1)
            if table == self.connection.fail_on_delete:
                raise RuntimeError(self.connection.database_error)
            self.connection.delete_tables.append(table)
            if table != self.connection.skip_delete:
                if table in NON_PRESERVED_TABLES:
                    self.connection.counts[table] = 0
                elif table == "users":
                    self.connection.counts[table] = 1
                    self.connection.delete_profiles_except(params)
                elif table == "roles":
                    self.connection.counts[table] = 2
                    self.connection.delete_roles_except(params)
            self.rowcount = 0 if table == self.connection.skip_delete else 1
            self._rows = []
            return self

        self._rows = self.connection.rows_for(query, params)
        self.rowcount = len(self._rows)
        return self

    def fetchone(self) -> tuple[object, ...] | None:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[tuple[object, ...]]:
        return list(self._rows)


class FakeConnection:
    """A minimal psycopg-shaped fake with observable transaction behavior."""

    def __init__(
        self,
        *,
        head: str = "fc105d5b6283",
        public_tables: set[str] | None = None,
        auth_users: list[dict[str, object]] | None = None,
        profile: dict[str, object] | None = None,
        profiles: list[dict[str, object]] | None = None,
        roles: list[dict[str, object]] | None = None,
        counts: dict[str, int] | None = None,
        effective_admin_profiles: list[dict[str, object]] | None = None,
    ) -> None:
        self.head = head
        self.public_tables = set(public_tables or APPLICATION_TABLES)
        self.auth_users = list(auth_users if auth_users is not None else [_auth_user()])
        profile_rows = profiles if profiles is not None else ([] if profile is None else [profile])
        self.profiles = [dict(item) for item in profile_rows]
        self.profile = self.profiles[0] if self.profiles else None
        self.roles = list(
            roles
            or [
                _role(ADMIN_ROLE_ID, "admin"),
                _role(MEMBER_ROLE_ID, "member"),
            ]
        )
        self.effective_admin_profiles = (
            [dict(item) for item in effective_admin_profiles]
            if effective_admin_profiles is not None
            else None
        )
        self.counts = dict(
            counts
            or {table: 3 for table in NON_PRESERVED_TABLES}
            | {"users": len(self.profiles), "roles": len(self.roles)}
        )
        self.initial_counts = dict(self.counts)
        self.initial_profiles = deepcopy(self.profiles)
        self.initial_roles = deepcopy(self.roles)
        self.executed: list[tuple[str, object]] = []
        self.delete_tables: list[str] = []
        self.committed = False
        self.rolled_back = False
        self.closed = False
        self.fail_on_delete: str | None = None
        self.skip_delete: str | None = None
        self.database_error = "private database detail: migration-password-must-not-leak"

    def __enter__(self) -> FakeConnection:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def execute(self, statement: object, params: object = None) -> FakeCursor:
        cursor = self.cursor()
        return cursor.execute(statement, params)

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True
        self.counts = dict(self.initial_counts)
        self.profiles = deepcopy(self.initial_profiles)
        self.profile = self.profiles[0] if self.profiles else None
        self.roles = deepcopy(self.initial_roles)

    def close(self) -> None:
        self.closed = True

    def delete_profiles_except(self, params: object) -> None:
        preserved_id = params[0] if isinstance(params, tuple) and params else None
        deleted_ids = {
            profile["id"] for profile in self.profiles if profile["id"] != preserved_id
        }
        self.profiles = [
            profile for profile in self.profiles if profile["id"] == preserved_id
        ]
        self.profile = self.profiles[0] if self.profiles else None
        for retained in self.profiles + self.roles:
            if retained.get("performed_by") in deleted_ids:
                retained["performed_by"] = None

    def delete_roles_except(self, params: object) -> None:
        preserved_ids = set(params) if isinstance(params, tuple) else set()
        self.roles = [role for role in self.roles if role["id"] in preserved_ids]

    @staticmethod
    def _selected_columns(query: str) -> list[str]:
        match = re.search(r"\bselect\s+(.*?)\s+from\s+", query, flags=re.IGNORECASE)
        if match is None:
            return []
        columns: list[str] = []
        for expression in match.group(1).split(","):
            column = expression.strip().rsplit(".", maxsplit=1)[-1]
            column = column.split()[-1].casefold()
            if column in {
                "id",
                "status",
                "is_deleted",
                "role_id",
                "email",
                "username",
                "created_at",
                "updated_at",
                "deleted_at",
                "performed_by",
                "role",
                "permissions",
            }:
                columns.append(column)
        return columns

    @classmethod
    def _project(cls, query: str, values: dict[str, object]) -> tuple[object, ...]:
        return tuple(values[column] for column in cls._selected_columns(query))

    def _effective_admin_rows(
        self, query: str, params: object
    ) -> list[tuple[object, ...]]:
        profiles = (
            self.effective_admin_profiles
            if self.effective_admin_profiles is not None
            else self.profiles
        )
        roles_by_id = {role["id"]: role for role in self.roles}
        values = params if isinstance(params, tuple) else ()
        excluded_ids = {value for value in values if isinstance(value, UUID)}
        effective = [
            profile
            for profile in profiles
            if profile["id"] not in excluded_ids
            and profile["status"] == "active"
            and profile["is_deleted"] is False
            and roles_by_id.get(profile["role_id"], {}).get("role") == "admin"
            and roles_by_id.get(profile["role_id"], {}).get("is_deleted") is False
        ]
        if "count(" in query.casefold():
            return [(len(effective),)]
        return [self._project(query, profile) for profile in effective]

    def _profiles_to_delete_count(self, params: object) -> int:
        values = params if isinstance(params, tuple) else ()
        preserved_id = next((value for value in values if isinstance(value, UUID)), None)
        return sum(profile["id"] != preserved_id for profile in self.profiles)

    def _inactive_admin_profiles_to_delete_count(self, params: object) -> int:
        values = params if isinstance(params, tuple) else ()
        preserved_id = next((value for value in values if isinstance(value, UUID)), None)
        roles_by_id = {role["id"]: role for role in self.roles}
        return sum(
            profile["id"] != preserved_id
            and not (
                profile["status"] == "active"
                and profile["is_deleted"] is False
            )
            and roles_by_id.get(profile["role_id"], {}).get("role") == "admin"
            and roles_by_id.get(profile["role_id"], {}).get("is_deleted") is False
            for profile in self.profiles
        )

    def rows_for(
        self, query: str, params: object = None
    ) -> list[tuple[object, ...]]:
        lowered = query.casefold()

        if "alembic_version" in lowered:
            return [(self.head,)]

        if "information_schema.tables" in lowered or "pg_catalog.pg_tables" in lowered:
            return [(table,) for table in sorted(self.public_tables)]

        if re.search(r"select\s+count\s*\(\s*\*\s*\)", lowered):
            if "auth.users" in lowered:
                return [(len(self.auth_users),)]
            if "from public.users" in lowered:
                if "join public.roles" in lowered:
                    if "filter" in lowered:
                        return [
                            (
                                self._profiles_to_delete_count(params),
                                self._inactive_admin_profiles_to_delete_count(params),
                            )
                        ]
                    if "status" in lowered or "is_deleted" in lowered:
                        return [(self._inactive_admin_profiles_to_delete_count(params),)]
                    return self._effective_admin_rows(query, params)
                if "id <> %s" in lowered or "id != %s" in lowered:
                    return [(self._profiles_to_delete_count(params),)]
            table_match = re.search(r"from\s+public\.([a-z_]+)", lowered)
            if table_match:
                return [(self.counts.get(table_match.group(1), 0),)]

        if "from auth.users" in lowered:
            return [
                (
                    user["id"],
                    user["email"],
                    user["email_confirmed_at"],
                    user["banned_until"],
                    user.get("deleted_at"),
                )
                for user in self.auth_users
            ]

        if "from public.users" in lowered:
            if "join public.roles" in lowered:
                return self._effective_admin_rows(query, params)
            if "where id" in lowered:
                requested_id = params[0] if isinstance(params, tuple) and params else None
                profiles = [
                    profile for profile in self.profiles if profile["id"] == requested_id
                ]
            else:
                profiles = self.profiles
            if not profiles:
                return []
            return [self._project(query, profile) for profile in profiles]

        if "from public.roles" in lowered:
            return [self._project(query, role) for role in self.roles]

        return []
