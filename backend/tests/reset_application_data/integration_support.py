"""PostgreSQL rollback fixtures for reset utility contract tests."""
from __future__ import annotations

import os
from collections.abc import Generator
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest

from scripts import reset_application_data as reset


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
    assert plan.counts["departments"] == database.baseline_counts["departments"] + 1
    assert _plan_canaries(plan) == _plan_canaries(database.baseline_plan)
    return plan
