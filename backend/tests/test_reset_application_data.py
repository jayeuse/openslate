"""Contract tests for the local application-data reset utility.

The small contract exercised here is:

* ``_parser()`` exposes ``--execute`` only, and defaults to dry-run.
* ``required_environment(mapping)`` returns ``(migration_url, sample_email)``.
* ``parse_supabase_status_database_url(output)`` and
  ``read_supabase_status_database_url(run_command)`` parse status output without
  printing it.
* ``validate_local_database_url(url, expected_url=...)`` and
  ``validate_local_project(root)`` enforce the local-only guard.
* ``build_reset_plan(connection, sample_email)`` performs read-only validation,
  rejects additional effective administrators, and returns a plan with deletion
  categories, complete retained snapshots, ``impact_digest``, and preserved IDs.
* ``apply_reset(connection, plan, ...)`` is the only mutating operation.  It uses
  ``execute``, ``stdin_is_tty``, an exact ``confirmation`` digest gate, and
  postconditions that account only for expected actor-FK nulling.
* ``main(argv)`` converts operational failures into safe command-line failures.

Most tests use a fake connection that records SQL and transaction effects without
connecting to PostgreSQL.  The guarded integration tests exercise the destructive
path inside a transaction that is guaranteed to be rolled back.
"""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Generator
from contextlib import redirect_stdout
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock
from uuid import UUID, uuid4

import psycopg
import pytest

from scripts import reset_application_data as reset

ROOT = Path(__file__).parents[2]
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
        head: str = "20260831_0015",
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


class DeferredCommitConnection:
    """Delegate database work while making commit and rollback observable only."""

    def __init__(self, connection: Any) -> None:
        self._connection = connection
        self.commit_requested = False
        self.rollback_requested = False

    @property
    def info(self) -> Any:
        return self._connection.info

    def cursor(self) -> Any:
        return self._connection.cursor()

    def execute(self, statement: object, params: object = None) -> Any:
        if params is None:
            return self._connection.execute(statement)
        return self._connection.execute(statement, params)

    def commit(self) -> None:
        self.commit_requested = True

    def rollback(self) -> None:
        self.rollback_requested = True


@dataclass
class ResetIntegrationDatabase:
    connection: Any
    database_url: str
    sample_email: str
    baseline_counts: dict[str, int]
    baseline_plan: reset.ResetPlan
    fixture_id: UUID | None = None


def _owner_capability(connection: Any) -> bool:
    public_tables = [*reset.APPLICATION_TABLES, "alembic_version"]
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT COALESCE((
                       SELECT role_row.rolsuper
                         FROM pg_catalog.pg_roles AS role_row
                        WHERE role_row.rolname = current_user
                   ), false),
                   COUNT(*) = %s,
                   COALESCE(bool_and(
                       current_user = pg_get_userbyid(table_row.relowner)
                       OR pg_has_role(
                           current_user, pg_get_userbyid(table_row.relowner), 'SET'
                       )
                   ), false)
             FROM pg_catalog.pg_class AS table_row
              JOIN pg_catalog.pg_namespace AS namespace_row
                ON namespace_row.oid = table_row.relnamespace
             WHERE table_row.relkind IN ('r', 'p')
               AND namespace_row.nspname = 'public'
               AND table_row.relname = ANY(%s)
            """,
            (len(public_tables), public_tables),
        )
        row = cursor.fetchone()
    if row is None or len(row) != 3:
        return False
    is_superuser, all_tables_present, can_assume_all_owners = row
    if not bool(all_tables_present) or not (
        bool(is_superuser) or bool(can_assume_all_owners)
    ):
        connection.rollback()
        return False
    try:
        connection.rollback()
        with connection.cursor() as cursor:
            cursor.execute(reset._LOCK_AUTH_STATEMENT)
            cursor.execute(reset._LOCK_APPLICATION_STATEMENT)
    except psycopg.Error:
        connection.rollback()
        return False
    connection.rollback()
    return True


def _rollback_and_close(connection: Any) -> Exception | None:
    if connection is None:
        return None
    first_error: Exception | None = None
    try:
        connection.rollback()
    except Exception as error:
        first_error = error
    finally:
        try:
            connection.close()
        except Exception as error:
            if first_error is None:
                first_error = error
    return first_error


def _plan_canaries(plan: reset.ResetPlan) -> tuple[object, ...]:
    return (
        plan.auth_user_count,
        plan.auth_identities,
        plan.profile_snapshot,
        plan.admin_role_snapshot,
        plan.member_role_snapshot,
        plan.preserved_admin_id,
        plan.preserved_admin_role_id,
        plan.preserved_member_role_id,
        plan.alembic_head,
    )


def _assert_clean_reconnected_state(
    database: ResetIntegrationDatabase, connection: Any
) -> None:
    assert dict(reset._read_counts(connection)) == database.baseline_counts
    if database.fixture_id is not None:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT 1 FROM public.departments WHERE id = %s",
                (database.fixture_id,),
            )
            assert cursor.fetchone() is None
    verified_plan = reset.build_reset_plan(connection, database.sample_email)
    assert dict(verified_plan.counts) == dict(database.baseline_plan.counts)
    assert _plan_canaries(verified_plan) == _plan_canaries(database.baseline_plan)
    assert verified_plan.impact_digest == database.baseline_plan.impact_digest


@pytest.fixture
def reset_integration_database() -> Generator[ResetIntegrationDatabase, None, None]:
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is not set")
    try:
        reset.validate_local_database_url(database_url)
        normalized_url = reset._psycopg_database_url(database_url)
    except reset.ResetError:
        pytest.skip(
            "TEST_DATABASE_URL must be the exact owner-capable local Supabase target "
            "127.0.0.1:54322/postgres"
        )

    sample_email = os.getenv("SAMPLE_EMAIL")
    if not sample_email or not sample_email.strip():
        pytest.skip("SAMPLE_EMAIL is required to identify the preserved local admin")

    connection: Any = None
    baseline_ready = False
    try:
        try:
            connection = psycopg.connect(normalized_url, autocommit=False)
            if not _owner_capability(connection):
                pytest.skip(
                    "TEST_DATABASE_URL did not connect with an owner-capable local role"
                )
        except psycopg.Error:
            pytest.skip(
                "TEST_DATABASE_URL did not connect to an owner-capable local PostgreSQL database"
            )

        connection.rollback()
        baseline_counts = dict(reset._read_counts(connection))
        if baseline_counts != EXPECTED_CLEAN_COUNTS:
            pytest.skip(
                "The local application baseline is not the expected clean state: "
                f"{baseline_counts!r}"
            )

        try:
            baseline_plan = reset.build_reset_plan(connection, sample_email)
        except reset.ResetError as error:
            pytest.skip(f"The local application baseline is not reset-safe: {error}")
        connection.rollback()
        database = ResetIntegrationDatabase(
            connection=connection,
            database_url=normalized_url,
            sample_email=sample_email,
            baseline_counts=baseline_counts,
            baseline_plan=baseline_plan,
        )
        baseline_ready = True
        yield database
    finally:
        connection_error = _rollback_and_close(connection)
        verification_error: Exception | None = None
        if baseline_ready:
            verification_connection: Any = None
            try:
                verification_connection = psycopg.connect(
                    normalized_url, autocommit=False
                )
                _assert_clean_reconnected_state(database, verification_connection)
            except Exception as error:
                verification_error = error
            finally:
                close_error = _rollback_and_close(verification_connection)
                if verification_error is None:
                    verification_error = close_error

        if connection_error is not None:
            raise connection_error
        if verification_error is not None:
            raise verification_error


def _seed_department_and_build_plan(database: ResetIntegrationDatabase) -> reset.ResetPlan:
    fixture_id = uuid4()
    database.fixture_id = fixture_id
    fixture_name = f"Rollback-only reset fixture {fixture_id}"
    with database.connection.cursor() as cursor:
        cursor.execute("BEGIN")
        cursor.execute(
            """
            INSERT INTO public.departments (id, department_name)
            VALUES (%s, %s)
            """,
            (fixture_id, fixture_name),
        )
    plan = reset.build_reset_plan(database.connection, database.sample_email)
    assert plan.counts["departments"] == 1
    assert _plan_canaries(plan) == _plan_canaries(database.baseline_plan)
    return plan


@pytest.mark.integration
def test_execute_deletes_postgres_rows_inside_transaction_but_cannot_commit(
    reset_integration_database: ResetIntegrationDatabase,
) -> None:
    database = reset_integration_database
    plan = _seed_department_and_build_plan(database)
    proxy = DeferredCommitConnection(database.connection)

    reset.apply_reset(
        proxy,
        plan,
        execute=True,
        stdin_is_tty=True,
        confirmation=plan.impact_digest,
    )

    assert proxy.commit_requested is True
    assert proxy.rollback_requested is False
    with database.connection.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM public.departments WHERE id = %s",
            (database.fixture_id,),
        )
        assert cursor.fetchone() is None
    assert dict(reset._read_counts(database.connection)) == EXPECTED_CLEAN_COUNTS
    auth_count, auth_identities = reset._read_auth_users(database.connection)
    assert auth_count == database.baseline_plan.auth_user_count
    assert auth_identities == database.baseline_plan.auth_identities
    assert (
        reset._read_profile(database.connection, database.baseline_plan.preserved_admin_id)
        == database.baseline_plan.profile_snapshot
    )
    roles = {role.id: role for role in reset._read_roles(database.connection)}
    assert roles == {
        database.baseline_plan.admin_role_snapshot.id: database.baseline_plan.admin_role_snapshot,
        database.baseline_plan.member_role_snapshot.id: database.baseline_plan.member_role_snapshot,
    }
    assert reset._read_alembic_head(database.connection) == database.baseline_plan.alembic_head


@pytest.mark.integration
def test_execute_lock_conflict_is_sanitized_and_rolled_back(
    reset_integration_database: ResetIntegrationDatabase,
) -> None:
    database = reset_integration_database
    plan = _seed_department_and_build_plan(database)
    proxy = DeferredCommitConnection(database.connection)
    blocker: Any = None
    try:
        blocker = psycopg.connect(database.database_url, autocommit=False)
        with blocker.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(%s)",
                (reset._RESET_ADVISORY_LOCK_KEY,),
            )

        with pytest.raises(reset.ResetError, match="^Unable to apply application-data reset$"):
            reset.apply_reset(
                proxy,
                plan,
                execute=True,
                stdin_is_tty=True,
                confirmation=plan.impact_digest,
            )

        assert proxy.commit_requested is False
        assert proxy.rollback_requested is True
    finally:
        blocker_error = _rollback_and_close(blocker)
        if blocker_error is not None:
            raise blocker_error


def _database(**changes: Any) -> FakeConnection:
    values: dict[str, Any] = {
        "profile": _profile(),
    }
    values.update(changes)
    return FakeConnection(**values)


def _plan(database: FakeConnection) -> Any:
    return reset.build_reset_plan(database, EMAIL)


def _counts(*, users: int, roles: int = 2) -> dict[str, int]:
    return {table: 3 for table in NON_PRESERVED_TABLES} | {
        "users": users,
        "roles": roles,
    }


PROFILE_SNAPSHOT_FIELDS = (
    "id",
    "created_at",
    "deleted_at",
    "is_deleted",
    "updated_at",
    "performed_by",
    "email",
    "username",
    "status",
    "role_id",
)
ROLE_SNAPSHOT_FIELDS = (
    "id",
    "created_at",
    "deleted_at",
    "is_deleted",
    "updated_at",
    "performed_by",
    "role",
    "permissions",
)


def _rich_profile_snapshot(profile: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(**{field: profile[field] for field in PROFILE_SNAPSHOT_FIELDS})


def _rich_role_snapshot(role: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(**{field: role[field] for field in ROLE_SNAPSHOT_FIELDS})


def test_local_database_url_accepts_only_the_exact_loopback_target() -> None:
    reset.validate_local_database_url(DATABASE_URL)
    reset.validate_local_database_url(
        f"postgresql+psycopg://postgres:{DATABASE_PASSWORD}@127.0.0.1:54322/postgres"
    )


@pytest.mark.parametrize(
    "value",
    [
        f"postgresql://postgres:{DATABASE_PASSWORD}@localhost:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@::1:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@database.example:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@192.0.2.10:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@127.0.0.1:54321/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@127.0.0.1:54322/other",
        "postgresql://@127.0.0.1:54322/postgres",
        "postgresql://127.0.0.1:54322/postgres",
        "not-a-database-url",
    ],
)
def test_local_database_url_rejects_nonlocal_or_malformed_forms(value: str) -> None:
    with pytest.raises(reset.ResetError) as error:
        reset.validate_local_database_url(value)

    assert DATABASE_PASSWORD not in str(error.value)


def test_supabase_status_output_is_parsed_in_memory_and_not_printed(
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = Mock(
        return_value=subprocess.CompletedProcess(
            ["supabase", "status", "-o", "env"],
            0,
            stdout=(
                "API_URL='http://127.0.0.1:54321'\n"
                f"DB_URL='{STATUS_URL}'\n"
                "PRIVATE_METADATA='must stay private'\n"
            ),
            stderr="",
        )
    )

    assert reset.read_supabase_status_database_url(runner) == STATUS_URL
    assert reset.parse_supabase_status_database_url(f"DB_URL='{STATUS_URL}'\n") == STATUS_URL
    assert capsys.readouterr().out == ""
    runner.assert_called_once()
    command = runner.call_args.args[0]
    assert command == ["supabase", "status", "-o", "env"]
    assert runner.call_args.kwargs["capture_output"] is True
    assert runner.call_args.kwargs["text"] is True
    assert runner.call_args.kwargs["cwd"] == ROOT


def test_status_command_receives_only_path_and_no_environment_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = "/private/test-bin"
    sentinel = "status-environment-secret"
    monkeypatch.setenv("PATH", path)
    monkeypatch.setenv("RESET_TEST_SENTINEL", sentinel)
    runner = Mock(
        return_value=subprocess.CompletedProcess(
            ["supabase", "status", "-o", "env"],
            0,
            stdout=f"DB_URL='{STATUS_URL}'\n",
            stderr="",
        )
    )

    assert reset.read_supabase_status_database_url(runner) == STATUS_URL

    environment = runner.call_args.kwargs["env"]
    assert environment == {"PATH": path}
    assert sentinel not in environment.values()


def test_status_command_fails_closed_when_path_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PATH", raising=False)
    runner = Mock(
        return_value=subprocess.CompletedProcess(
            ["supabase", "status", "-o", "env"],
            0,
            stdout=f"DB_URL='{STATUS_URL}'\n",
            stderr="",
        )
    )

    with pytest.raises(reset.ResetError):
        reset.read_supabase_status_database_url(runner)

    runner.assert_not_called()


def test_status_failures_and_url_mismatches_do_not_expose_passwords() -> None:
    runner = Mock(
        side_effect=subprocess.CalledProcessError(
            1,
            ["supabase", "status", "-o", "env"],
            output=f"status output contains {STATUS_PASSWORD}",
            stderr=f"stderr contains {STATUS_PASSWORD}",
        )
    )
    with pytest.raises(reset.ResetError) as status_error:
        reset.read_supabase_status_database_url(runner)
    assert STATUS_PASSWORD not in str(status_error.value)

    with pytest.raises(reset.ResetError) as mismatch_error:
        reset.validate_local_database_url(DATABASE_URL, expected_url=STATUS_URL)
    assert DATABASE_PASSWORD not in str(mismatch_error.value)
    assert STATUS_PASSWORD not in str(mismatch_error.value)


@pytest.mark.parametrize(
    "output",
    [
        "API_URL=http://127.0.0.1:54321\n",
        "DB_URL=\n",
        "DB_URL='not a postgres URL'\n",
        "DB_URL=postgresql://one@127.0.0.1:54322/postgres\n"
        "DB_URL=postgresql://two@127.0.0.1:54322/postgres\n",
    ],
)
def test_status_parser_rejects_missing_or_ambiguous_database_url(output: str) -> None:
    with pytest.raises(reset.ResetError):
        reset.parse_supabase_status_database_url(output)


def test_local_project_guard_requires_the_expected_open_slate_config(tmp_path: Path) -> None:
    reset.validate_local_project(ROOT)

    supabase_directory = tmp_path / "supabase"
    supabase_directory.mkdir()
    (supabase_directory / "config.toml").write_text(
        'project_id = "not-openslate"\n\n[db]\nport = 54322\n',
        encoding="utf-8",
    )
    with pytest.raises(reset.ResetError):
        reset.validate_local_project(tmp_path)

    (supabase_directory / "config.toml").write_text(
        'project_id = "openslate"\n\n[db]\nport = 54321\n',
        encoding="utf-8",
    )
    with pytest.raises(reset.ResetError):
        reset.validate_local_project(tmp_path)


def test_required_environment_never_falls_back_to_database_url() -> None:
    assert reset.required_environment(
        {"MIGRATION_DATABASE_URL": DATABASE_URL, "SAMPLE_EMAIL": EMAIL}
    ) == (DATABASE_URL, EMAIL)

    with pytest.raises(reset.ResetError, match="MIGRATION_DATABASE_URL"):
        reset.required_environment({"DATABASE_URL": DATABASE_URL, "SAMPLE_EMAIL": EMAIL})


@pytest.mark.parametrize(
    "environment",
    [
        {"MIGRATION_DATABASE_URL": DATABASE_URL},
        {"MIGRATION_DATABASE_URL": DATABASE_URL, "SAMPLE_EMAIL": "   "},
        {"MIGRATION_DATABASE_URL": "   ", "SAMPLE_EMAIL": EMAIL},
    ],
)
def test_required_environment_rejects_missing_or_blank_values(
    environment: dict[str, str],
) -> None:
    with pytest.raises(reset.ResetError):
        reset.required_environment(environment)


def test_cli_defaults_to_dry_run_and_has_no_secret_options() -> None:
    parser = reset._parser()
    assert parser.parse_args([]).execute is False
    assert parser.parse_args(["--execute"]).execute is True

    for option in ("--database-url", "--sample-email"):
        with pytest.raises(SystemExit):
            parser.parse_args([option, "secret-value"])


def test_plan_requires_expected_head_and_exact_public_application_table_allowlist() -> None:
    valid = _database()
    plan = _plan(valid)
    assert set(plan.counts) >= NON_PRESERVED_TABLES
    assert plan.preserved_admin_id == ADMIN_ID
    assert plan.preserved_admin_role_id == ADMIN_ROLE_ID
    assert plan.preserved_member_role_id == MEMBER_ROLE_ID

    for changes in (
        {"head": "20260830_0013"},
        {"public_tables": APPLICATION_TABLES | {"unrelated_table"}},
        {"public_tables": APPLICATION_TABLES - {"records"}},
    ):
        database = _database(**changes)
        with pytest.raises(reset.ResetError):
            _plan(database)
        assert database.delete_tables == []


def test_plan_rejects_another_effective_admin_without_auth_liveness_guards() -> None:
    additional_admin = _profile(
        user_id=OTHER_ID,
        email="other@example.test",
        deleted_at=DELETED_AT,
    )
    database = _database(
        profiles=[_profile(), additional_admin],
        auth_users=[
            _auth_user(),
            _auth_user(
                user_id=OTHER_ID,
                email="other@example.test",
                confirmed=None,
                banned_until=DELETED_AT,
                deleted_at=DELETED_AT,
            ),
        ],
        counts=_counts(users=2),
    )

    with pytest.raises(reset.ResetError, match="administrator"):
        _plan(database)

    assert database.delete_tables == []


def test_plan_counts_inactive_admin_profiles_that_are_still_deleteable() -> None:
    pending_admin = _profile(
        user_id=PENDING_ADMIN_ID,
        status="pending",
        email="pending@example.test",
    )
    disabled_admin = _profile(
        user_id=DISABLED_ADMIN_ID,
        status="disabled",
        email="disabled@example.test",
    )
    soft_deleted_admin = _profile(
        user_id=DELETED_ADMIN_ID,
        is_deleted=True,
        deleted_at=DELETED_AT,
        email="deleted@example.test",
    )
    member = _profile(
        user_id=OTHER_ID,
        status="active",
        role_id=MEMBER_ROLE_ID,
        email="member@example.test",
    )
    database = _database(
        profiles=[_profile(), pending_admin, disabled_admin, soft_deleted_admin, member],
        auth_users=[
            _auth_user(),
            _auth_user(user_id=PENDING_ADMIN_ID, email="pending@example.test"),
            _auth_user(user_id=DISABLED_ADMIN_ID, email="disabled@example.test"),
            _auth_user(user_id=DELETED_ADMIN_ID, email="deleted@example.test"),
            _auth_user(user_id=OTHER_ID, email="member@example.test"),
        ],
        counts=_counts(users=5),
    )

    plan = _plan(database)

    assert plan.counts["profiles_to_delete"] == 4
    assert plan.counts["inactive_admin_profiles_to_delete"] == 3


def test_profile_delete_categories_change_the_digest_even_when_total_counts_match() -> None:
    auth_users = [
        _auth_user(),
        _auth_user(user_id=OTHER_ID, email="other@example.test"),
    ]
    pending_admin = _database(
        profiles=[
            _profile(),
            _profile(
                user_id=OTHER_ID,
                status="pending",
                email="other@example.test",
            ),
        ],
        auth_users=auth_users,
        counts=_counts(users=2),
    )
    active_member = _database(
        profiles=[
            _profile(),
            _profile(
                user_id=OTHER_ID,
                status="active",
                role_id=MEMBER_ROLE_ID,
                email="other@example.test",
            ),
        ],
        auth_users=auth_users,
        counts=_counts(users=2),
    )

    pending_plan = _plan(pending_admin)
    member_plan = _plan(active_member)

    assert pending_plan.counts["profiles_to_delete"] == member_plan.counts[
        "profiles_to_delete"
    ] == 1
    assert pending_plan.counts["inactive_admin_profiles_to_delete"] == 1
    assert member_plan.counts["inactive_admin_profiles_to_delete"] == 0
    assert pending_plan.impact_digest != member_plan.impact_digest


def test_printed_plan_exposes_profile_delete_categories() -> None:
    database = _database(
        profiles=[
            _profile(),
            _profile(
                user_id=OTHER_ID,
                status="pending",
                email="other@example.test",
            ),
        ],
        auth_users=[
            _auth_user(),
            _auth_user(user_id=OTHER_ID, email="other@example.test"),
        ],
        counts=_counts(users=2),
    )
    plan = _plan(database)
    output = StringIO()

    with redirect_stdout(output):
        reset._print_plan(plan)

    printed = output.getvalue()
    assert "profiles_to_delete=1" in printed
    assert "inactive_admin_profiles_to_delete=1" in printed


def test_plan_snapshots_include_all_retained_profile_and_role_columns() -> None:
    profile = _profile(
        username="preserved-admin",
        deleted_at=DELETED_AT,
        performed_by=ADMIN_ID,
    )
    admin_role = _role(
        ADMIN_ROLE_ID,
        "admin",
        permissions={"scope": "all"},
        deleted_at=DELETED_AT,
        performed_by=ADMIN_ID,
    )
    member_role = _role(
        MEMBER_ROLE_ID,
        "member",
        permissions={"scope": "limited"},
        performed_by=ADMIN_ID,
    )
    database = _database(profile=profile, roles=[admin_role, member_role])

    plan = _plan(database)

    assert {
        field: getattr(plan.profile_snapshot, field, object())
        for field in PROFILE_SNAPSHOT_FIELDS
    } == {field: profile[field] for field in PROFILE_SNAPSHOT_FIELDS}
    assert {
        field: getattr(plan.admin_role_snapshot, field, object())
        for field in ROLE_SNAPSHOT_FIELDS
    } == {field: admin_role[field] for field in ROLE_SNAPSHOT_FIELDS}
    assert {
        field: getattr(plan.member_role_snapshot, field, object())
        for field in ROLE_SNAPSHOT_FIELDS
    } == {field: member_role[field] for field in ROLE_SNAPSHOT_FIELDS}


def test_digest_changes_when_a_retained_performed_by_actor_changes() -> None:
    with_deleted_actor = _database(
        profile=_profile(performed_by=OTHER_ID),
        roles=[
            _role(ADMIN_ROLE_ID, "admin", performed_by=OTHER_ID),
            _role(MEMBER_ROLE_ID, "member"),
        ],
    )
    without_deleted_actor = _database(
        profile=_profile(performed_by=None),
        roles=[
            _role(ADMIN_ROLE_ID, "admin", performed_by=None),
            _role(MEMBER_ROLE_ID, "member"),
        ],
    )

    assert _plan(with_deleted_actor).impact_digest != _plan(without_deleted_actor).impact_digest


def test_postconditions_allow_only_expected_performed_by_set_nulling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    retained = _profile(performed_by=OTHER_ID)
    deleted_profile = _profile(
        user_id=OTHER_ID,
        role_id=MEMBER_ROLE_ID,
        email="deleted@example.test",
    )
    admin_role = _role(ADMIN_ROLE_ID, "admin", performed_by=ADMIN_ID)
    member_role = _role(MEMBER_ROLE_ID, "member", performed_by=OTHER_ID)
    database = _database(
        profiles=[retained, deleted_profile],
        roles=[admin_role, member_role],
        auth_users=[
            _auth_user(),
            _auth_user(user_id=OTHER_ID, email="deleted@example.test"),
        ],
        counts={table: 0 for table in NON_PRESERVED_TABLES}
        | {"users": 2, "roles": 2},
    )
    expected_profile = _rich_profile_snapshot(retained)
    expected_roles = (
        _rich_role_snapshot(admin_role),
        _rich_role_snapshot(member_role),
    )
    monkeypatch.setattr(
        reset,
        "_read_profile",
        lambda *_: _rich_profile_snapshot(database.profiles[0]),
    )
    monkeypatch.setattr(
        reset,
        "_read_roles",
        lambda *_: tuple(_rich_role_snapshot(role) for role in database.roles),
    )

    plan = _plan(database)
    assert plan.profile_snapshot == expected_profile
    assert plan.admin_role_snapshot == expected_roles[0]
    assert plan.member_role_snapshot == expected_roles[1]

    reset.apply_reset(
        database,
        plan,
        execute=True,
        stdin_is_tty=True,
        confirmation=plan.impact_digest,
    )

    assert database.profiles[0]["performed_by"] is None
    assert database.roles[0]["performed_by"] == ADMIN_ID
    assert database.roles[1]["performed_by"] is None


def test_postconditions_reject_an_unexpected_retained_snapshot_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = _database(
        counts={table: 0 for table in NON_PRESERVED_TABLES}
        | {"users": 1, "roles": 2},
    )
    plan = _plan(database)
    expected_profile = _rich_profile_snapshot(_profile())
    changed_profile = _rich_profile_snapshot(_profile(status="disabled"))
    roles = tuple(_rich_role_snapshot(role) for role in database.roles)
    plan = replace(
        plan,
        profile_snapshot=expected_profile,
        admin_role_snapshot=roles[0],
        member_role_snapshot=roles[1],
    )
    monkeypatch.setattr(reset, "_read_profile", lambda *_: changed_profile)
    monkeypatch.setattr(reset, "_read_roles", lambda *_: roles)

    with pytest.raises(reset.ResetError, match="profile"):
        reset._validate_postconditions(database, plan)


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"auth_users": []}, id="no-matching-identity"),
        pytest.param(
            {"auth_users": [_auth_user(), _auth_user(user_id=OTHER_ID)]},
            id="multiple-matching-identities",
        ),
        pytest.param(
            {"auth_users": [_auth_user(confirmed=None)]},
            id="unconfirmed-identity",
        ),
        pytest.param(
            {"auth_users": [_auth_user(banned_until="2026-08-30T01:00:00+00:00")]},
            id="disabled-identity",
        ),
        pytest.param({"profile": None}, id="missing-profile"),
        pytest.param(
            {"profile": _profile(user_id=OTHER_ID)},
            id="profile-uuid-mismatch",
        ),
        pytest.param({"profile": _profile(status="pending")}, id="inactive-profile"),
        pytest.param(
            {"profile": _profile(is_deleted=True)},
            id="deleted-profile",
        ),
        pytest.param(
            {"profile": _profile(email="different@example.test")},
            id="profile-email-mismatch",
        ),
    ],
)
def test_plan_rejects_invalid_auth_identity_or_profile(changes: dict[str, object]) -> None:
    database = _database(**changes)
    with pytest.raises(reset.ResetError) as error:
        _plan(database)

    assert DATABASE_PASSWORD not in str(error.value)
    assert database.delete_tables == []


@pytest.mark.parametrize(
    "roles",
    [
        [_role(ADMIN_ROLE_ID, "Admin"), _role(MEMBER_ROLE_ID, "member")],
        [_role(ADMIN_ROLE_ID, "admin", is_deleted=True), _role(MEMBER_ROLE_ID, "member")],
        [_role(ADMIN_ROLE_ID, "admin")],
        [
            _role(ADMIN_ROLE_ID, "admin"),
            _role(MEMBER_ROLE_ID, "member"),
            _role(OTHER_ID, "member"),
        ],
    ],
)
def test_plan_rejects_nonliteral_admin_or_invalid_member_role_count(
    roles: list[dict[str, object]],
) -> None:
    database = _database(roles=roles)
    with pytest.raises(reset.ResetError):
        _plan(database)
    assert database.delete_tables == []


def test_zero_count_plan_is_read_only_and_idempotent() -> None:
    database = _database(
        counts={"users": 1, "roles": 2}
        | {table: 0 for table in NON_PRESERVED_TABLES}
    )
    plan = _plan(database)

    assert all(plan.counts[table] == 0 for table in NON_PRESERVED_TABLES)
    reset.apply_reset(database, plan)
    assert database.delete_tables == []
    assert database.committed is False


def test_default_reset_is_dry_run_and_does_not_delete_or_commit() -> None:
    database = _database()
    plan = _plan(database)

    reset.apply_reset(database, plan)

    assert database.delete_tables == []
    assert database.committed is False
    assert database.counts == database.initial_counts


def test_execute_requires_a_tty_even_with_the_exact_digest() -> None:
    database = _database()
    plan = _plan(database)

    with pytest.raises(reset.ResetError, match="TTY"):
        reset.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=False,
            confirmation=plan.impact_digest,
        )

    assert database.delete_tables == []
    assert database.committed is False


@pytest.mark.parametrize("confirmation", [None, "wrong-digest", "wrong-digest\n"])
def test_execute_requires_an_exact_digest_confirmation(confirmation: str | None) -> None:
    database = _database()
    plan = _plan(database)

    with pytest.raises(reset.ResetError, match="confirmation"):
        reset.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=confirmation,
        )

    assert database.delete_tables == []
    assert database.committed is False


def test_execute_uses_locks_parameterized_static_deletes_and_preserves_auth_state() -> None:
    database = _database()
    plan = _plan(database)
    auth_before = list(database.auth_users)

    reset.apply_reset(
        database,
        plan,
        execute=True,
        stdin_is_tty=True,
        confirmation=plan.impact_digest,
    )

    assert database.delete_tables == DELETE_ORDER
    assert database.committed is True
    assert database.rolled_back is False
    assert database.auth_users == auth_before
    assert database.head == "20260831_0015"
    assert all(database.counts[table] == 0 for table in NON_PRESERVED_TABLES)
    assert database.counts["users"] == 1
    assert database.counts["roles"] == 2

    statements = [query for query, _ in database.executed]
    assert any("pg_advisory_xact_lock" in query.casefold() for query in statements)
    assert [
        query
        for query in statements
        if query.casefold().startswith("lock table")
    ] == [
        "LOCK TABLE auth.users IN SHARE MODE NOWAIT",
        "LOCK TABLE public.alembic_version, public.users, public.roles, "
        "public.departments, public.modules, public.fields, public.records, "
        "public.audit_logs, public.relationship_edges, "
        "public.lifecycle_confirmation_challenges, "
        "public.lifecycle_rate_limit_buckets, "
        "public.lifecycle_rate_limit_failures IN ACCESS EXCLUSIVE MODE NOWAIT",
    ]

    deletes = [
        (query, params)
        for query, params in database.executed
        if re.match(r"DELETE\s+FROM\s+public\.", query, flags=re.IGNORECASE)
    ]
    assert len(deletes) == len(DELETE_ORDER)
    assert [
        re.match(r"DELETE\s+FROM\s+public\.([a-z_]+)\b", query, re.IGNORECASE).group(1)
        for query, _ in deletes
    ] == DELETE_ORDER
    for query, _ in deletes:
        assert "cascade" not in query.casefold()
        assert "truncate" not in query.casefold()
        assert re.match(r"DELETE\s+FROM\s+public\.[a-z_]+\b", query, re.IGNORECASE)

    user_delete = next(item for item in deletes if ".users" in item[0])
    role_delete = next(item for item in deletes if ".roles" in item[0])
    assert user_delete[1] == (ADMIN_ID,)
    assert role_delete[1] == (ADMIN_ROLE_ID, MEMBER_ROLE_ID)
    assert not any("delete from auth.users" in query.casefold() for query in statements)


def test_failed_delete_rolls_back_without_commit_or_private_error_details() -> None:
    database = _database()
    database.fail_on_delete = "records"
    plan = _plan(database)

    with pytest.raises(reset.ResetError) as error:
        reset.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=plan.impact_digest,
        )

    assert database.rolled_back is True
    assert database.committed is False
    assert database.counts == database.initial_counts
    assert DATABASE_PASSWORD not in str(error.value)


def test_postcondition_failure_rolls_back_without_commit() -> None:
    database = _database()
    database.skip_delete = "records"
    plan = _plan(database)

    with pytest.raises(reset.ResetError):
        reset.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=plan.impact_digest,
        )

    assert database.rolled_back is True
    assert database.committed is False
    assert database.counts == database.initial_counts


def test_main_sanitizes_configuration_and_database_details(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv(
        "MIGRATION_DATABASE_URL",
        f"postgresql://postgres:{DATABASE_PASSWORD}@remote.example:54322/postgres",
    )
    monkeypatch.setenv("SAMPLE_EMAIL", EMAIL)
    monkeypatch.setenv("DATABASE_URL", DATABASE_URL)

    with pytest.raises(SystemExit):
        reset.main([])

    output = capsys.readouterr()
    assert DATABASE_PASSWORD not in output.out + output.err
    assert DATABASE_PASSWORD not in str(output)
