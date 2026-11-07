"""`ensure_audit_partitions()`: the one DDL routine that the runtime can run (D20)."""

from collections.abc import Iterator

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError
from uuid6 import uuid7

from tests.migrations.audit_partition_support import (
    DEFAULT_PARTITION,
    INSUFFICIENT_PRIVILEGE,
    LOCK_NOT_AVAILABLE,
    AuditEngines,
    insert_audit_row,
    leaf_names,
    month_starts,
    partition_name,
    sqlstate,
)
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration

ENSURE = text("SELECT public.ensure_audit_partitions()")
# The key of `retain_security_events`; the two routines must not wait for each other.
SECURITY_RETENTION_LOCK = 22328052256015694
# A hang guard for the statement that must not wait, not a time limit.
HANG_GUARD = text("SET LOCAL lock_timeout = '10s'")
# A hang guard for the routine. It is not a lock limit, so only the routine's own limit can
# give `55P03`; if that limit goes, this one ends the call with `57014` and the test fails.
ROUTINE_HANG_GUARD = text("SET LOCAL statement_timeout = '10s'")


def _drop(connection: Connection, first_day: str) -> None:
    connection.execute(text(f"DROP TABLE public.{partition_name(first_day)}"))


def _partition_oids(connection: Connection) -> dict[str, int]:
    rows = connection.execute(
        text(
            "SELECT child.relname, child.oid::bigint FROM pg_inherits AS link "
            "JOIN pg_class AS child ON child.oid = link.inhrelid "
            "WHERE link.inhparent = 'public.audit_logs'::regclass"
        )
    )
    return dict(rows.all())


@pytest.fixture
def months(audit_engines: AuditEngines) -> Iterator[list[str]]:
    """This month and the next two; later tests get them back whatever a test removed."""

    with audit_engines.owner.connect() as connection:
        first_days = month_starts(connection)
    try:
        yield first_days
    finally:
        with audit_engines.owner.begin() as connection:
            connection.execute(
                text("DELETE FROM public.audit_logs_default WHERE created_at >= :first"),
                {"first": first_days[0]},
            )
            connection.execute(ENSURE)


def test_the_runtime_creates_the_missing_months_in_utc_and_a_second_call_changes_nothing(
    audit_engines: AuditEngines, months: list[str]
) -> None:
    with audit_engines.owner.begin() as connection:
        _drop(connection, months[1])
        _drop(connection, months[2])

    with audit_engines.runtime.begin() as connection:
        # The bounds must not follow the caller's zone.
        connection.execute(text("SET LOCAL \"TimeZone\" = 'Asia/Manila'"))
        assert connection.scalar(ENSURE) == 0

    with audit_engines.owner.begin() as connection:
        connection.execute(text("SET LOCAL \"TimeZone\" = 'UTC'"))
        before = _partition_oids(connection)
        bounds = connection.scalar(
            text("SELECT pg_get_expr(relpartbound, oid) FROM pg_class WHERE oid = :oid"),
            {"oid": before[partition_name(months[1])]},
        )
    assert {partition_name(first_day) for first_day in months} <= set(before)
    assert bounds == (
        f"FOR VALUES FROM ('{months[1]} 00:00:00+00') TO ('{months[2]} 00:00:00+00')"
    )

    with audit_engines.runtime.begin() as connection:
        assert connection.scalar(ENSURE) == 0
    with audit_engines.owner.connect() as connection:
        assert _partition_oids(connection) == before


def test_the_runtime_cannot_name_a_month_and_only_it_can_run_the_routine(
    audit_engines: AuditEngines,
) -> None:
    with audit_engines.runtime.connect() as connection:
        with pytest.raises(DBAPIError) as denied:
            connection.execute(text("SELECT public.create_audit_partition('2031-01-01')"))
    assert sqlstate(denied.value) == INSUFFICIENT_PRIVILEGE

    with audit_engines.owner.connect() as connection:
        held = connection.execute(
            text(
                "SELECT role, routine FROM unnest(ARRAY['anon', 'authenticated', 'service_role', "
                "'slateops_runtime']) AS role, unnest(ARRAY["
                "'public.ensure_audit_partitions()', 'public.create_audit_partition(date)']) "
                "AS routine WHERE has_function_privilege(role, routine, 'EXECUTE')"
            )
        ).all()
        definer, config = connection.execute(
            text(
                "SELECT prosecdef, proconfig FROM pg_proc "
                "WHERE oid = 'public.ensure_audit_partitions()'::regprocedure"
            )
        ).one()
    assert [tuple(row) for row in held] == [
        ("slateops_runtime", "public.ensure_audit_partitions()")
    ]
    assert definer is True
    assert "search_path=pg_catalog, pg_temp" in config


def test_two_callers_create_a_month_once_and_security_retention_does_not_stop_them(
    audit_engines: AuditEngines, months: list[str]
) -> None:
    missing = partition_name(months[2])
    with audit_engines.owner.begin() as connection:
        _drop(connection, months[2])

    runtime = audit_engines.runtime
    with runtime.connect() as retention, runtime.connect() as first, runtime.connect() as second:
        retention.execute(
            text("SELECT pg_advisory_xact_lock(:key)"), {"key": SECURITY_RETENTION_LOCK}
        )
        assert first.scalar(ENSURE) == 0
        # The month exists only in the first caller's open transaction, so the second gives way.
        assert second.scalar(ENSURE) == 0
        second.rollback()
        first.commit()
        retention.rollback()

    with audit_engines.owner.connect() as connection:
        assert missing in leaf_names(connection)


@pytest.mark.parametrize(
    "holder",
    [
        # Reads `audit_logs_default`, because nothing prunes it, and ATTACH locks that table.
        "SELECT count(*) FROM public.audit_logs",
        # The cloned foreign keys of ATTACH conflict with a write to `users`.
        "INSERT INTO public.users (id, email, username, status) VALUES "
        "(gen_random_uuid(), 'partition-lock@example.test', 'partition_lock', 'active')",
    ],
    ids=["a read of default", "a write to users"],
)
def test_the_routine_gives_way_while_an_audited_insert_commits(
    audit_engines: AuditEngines, months: list[str], holder: str
) -> None:
    with audit_engines.owner.begin() as connection:
        _drop(connection, months[2])

    written = uuid7()
    try:
        with audit_engines.runtime.connect() as lock_holder:
            lock_holder.execute(text(holder))

            with audit_engines.runtime.connect() as connection:
                connection.execute(ROUTINE_HANG_GUARD)
                with pytest.raises(DBAPIError) as gave_way:
                    connection.execute(ENSURE)
            assert sqlstate(gave_way.value) == LOCK_NOT_AVAILABLE

            with audit_engines.runtime.begin() as connection:
                connection.execute(HANG_GUARD)
                insert_audit_row(connection, f"{months[0]} 12:00:00+00", row_id=written)
            lock_holder.rollback()

        with audit_engines.runtime.begin() as connection:
            assert connection.scalar(ENSURE) == 0
        with audit_engines.owner.connect() as connection:
            assert partition_name(months[2]) in leaf_names(connection)
    finally:
        with audit_engines.owner.begin() as connection:
            connection.execute(
                text("DELETE FROM public.audit_logs WHERE id = :id"), {"id": written}
            )


def test_a_month_with_rows_in_default_is_skipped_and_its_rows_stay_readable(
    audit_engines: AuditEngines, months: list[str]
) -> None:
    with audit_engines.owner.begin() as connection:
        _drop(connection, months[1])
        _drop(connection, months[2])
        stranded = insert_audit_row(connection, f"{months[2]} 12:00:00+00")

    with audit_engines.runtime.begin() as connection:
        assert connection.scalar(ENSURE) == 1

    with audit_engines.owner.connect() as connection:
        leaves = leaf_names(connection)
    assert partition_name(months[1]) in leaves
    assert partition_name(months[2]) not in leaves

    with audit_engines.runtime.connect() as connection:
        where = connection.scalar(
            text("SELECT tableoid::regclass::text FROM public.audit_logs WHERE id = :id"),
            {"id": stranded},
        )
    assert where == DEFAULT_PARTITION
