"""Mutation safety and command error contracts for the reset utility."""
from __future__ import annotations

import re

import pytest

from scripts import reset_application_data as reset

from .plan_support import _database, _plan
from .support import (
    ADMIN_ID,
    ADMIN_ROLE_ID,
    DATABASE_PASSWORD,
    DATABASE_URL,
    DELETE_ORDER,
    EMAIL,
    MEMBER_ROLE_ID,
    NON_PRESERVED_TABLES,
)


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
    assert database.head == "fc105d5b6283"
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
        "public.audit_logs, public.security_events, public.relationship_edges, "
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
    delete_names: list[str] = []
    for query, _ in deletes:
        match = re.match(r"DELETE\s+FROM\s+public\.([a-z_]+)\b", query, re.IGNORECASE)
        assert match is not None
        delete_names.append(match.group(1))
    assert delete_names == DELETE_ORDER
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
