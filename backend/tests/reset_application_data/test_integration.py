"""Rollback-protected PostgreSQL reset execution tests."""
from __future__ import annotations

from typing import Any

import psycopg
import pytest

from scripts import reset_application_data as reset

from .integration_support import (
    DeferredCommitConnection,
    ResetIntegrationDatabase,
    _rollback_and_close,
    _seed_department_and_build_plan,
)
from .support import EXPECTED_CLEAN_COUNTS


@pytest.mark.integration
def test_execute_deletes_postgres_rows_inside_transaction_but_cannot_commit(
    reset_integration_database: ResetIntegrationDatabase,  # noqa: F811
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
    reset_integration_database: ResetIntegrationDatabase,  # noqa: F811
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
