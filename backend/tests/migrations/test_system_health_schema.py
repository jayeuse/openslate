"""S5, S6: the health tables keep their invariants, grants and row security (PostgreSQL)."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError, ProgrammingError
from uuid6 import uuid7

from app.core.database.organization_scope import apply_connection_scope
from app.core.database.session import AuditSession
from app.systems.manage.health.worker import SystemHealthWorker
from tests.config_support import settings_values
from tests.runtime.health_support import (
    add_sample,
    add_server_error,
    clear_samples,
    committed_organization,
    owner_engine,
    remove_organizations,
    remove_server_errors,
    runtime_engine,
    sample_rows,
)

pytestmark = pytest.mark.integration

FUNCTION = "public.retain_system_health()"


def test_s5_c6_the_migration_seeds_the_six_signals(integration_owner_db):
    keys = integration_owner_db.connection().scalars(
        text("SELECT key FROM public.system_health_signals ORDER BY key")
    ).all()

    assert keys == [
        "comms_jobs", "email_accepted", "email_failed", "provider_signout",
        "record_triggers", "report_scheduling",
    ]


@pytest.mark.parametrize(
    ("table", "allowed", "refused"),
    [
        ("system_health_samples", ("SELECT", "INSERT"), ("UPDATE", "DELETE", "TRUNCATE")),
        ("system_health_signals", ("SELECT", "UPDATE"), ("INSERT", "DELETE", "TRUNCATE")),
        ("server_errors", ("SELECT", "INSERT"), ("UPDATE", "DELETE", "TRUNCATE")),
    ],
)
def test_s5_c2_i4_the_runtime_role_has_only_the_contract_privileges(
    integration_owner_db, table, allowed, refused
):
    connection = integration_owner_db.connection()

    def granted(privilege: str) -> bool:
        return bool(connection.scalar(
            text("SELECT has_table_privilege('slateops_runtime', :table, :privilege)"),
            {"table": f"public.{table}", "privilege": privilege},
        ))

    assert {privilege: granted(privilege) for privilege in allowed + refused} == {
        **dict.fromkeys(allowed, True), **dict.fromkeys(refused, False),
    }


@pytest.mark.parametrize(
    "statement",
    [
        "DELETE FROM public.system_health_samples",
        "DELETE FROM public.server_errors",
        "UPDATE public.system_health_samples SET data_ms = 0",
        "INSERT INTO public.system_health_signals (key) VALUES ('email_failed')",
    ],
)
def test_s5_c2_i4_the_runtime_role_cannot_delete_or_rewrite_history(statement):
    with runtime_engine().connect() as connection:
        with pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text(statement))
        connection.rollback()


def test_s5_c2_i4_retention_is_a_narrow_owner_bound_capability(integration_owner_db):
    connection = integration_owner_db.connection()
    row = connection.execute(text(
        "SELECT p.pronargs, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), "
        f"pg_get_function_result(p.oid) FROM pg_proc p WHERE p.oid = '{FUNCTION}'::regprocedure"
    )).one()
    settings = dict(value.split("=", 1) for value in row[2])

    assert (row[0], row[1], row[3], row[4]) == (0, True, "slateops_owner", "integer")
    assert settings["search_path"] == "pg_catalog, pg_temp"
    privileges = {
        role: connection.scalar(
            text(f"SELECT has_function_privilege(:role, '{FUNCTION}', 'EXECUTE')"),
            {"role": role},
        )
        for role in ("anon", "authenticated", "service_role", "slateops_runtime")
    }
    assert privileges == {
        "anon": False, "authenticated": False, "service_role": False, "slateops_runtime": True,
    }
    assert connection.scalar(text(
        "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) acl "
        f"WHERE p.oid = '{FUNCTION}'::regprocedure AND acl.grantee = 0"
    )) == 0


@pytest.mark.parametrize(
    ("statement", "constraint"),
    [
        ("INSERT INTO public.system_health_samples (sampled_at, data_status, signing_in_status, "
         "files_status, email_status) VALUES ('2026-11-05 10:00:30+00', 'working', 'working', "
         "'working', 'set_up')", "ck_system_health_samples_minute"),
        ("INSERT INTO public.system_health_samples (sampled_at, data_status, signing_in_status, "
         "files_status, email_status) VALUES ('2026-11-05 10:00+00', 'slow', 'working', "
         "'working', 'set_up')", "ck_system_health_samples_part_status"),
        ("INSERT INTO public.server_errors (request_id, status, method, route) "
         "VALUES (gen_random_uuid(), 404, 'GET', '/api/x')", "ck_server_errors_status"),
        ("INSERT INTO public.server_errors (request_id, status, method, route) "
         "VALUES (gen_random_uuid(), 500, 'get /x', '/api/x')", "ck_server_errors_method"),
    ],
)
def test_s6_c1_stored_rows_keep_their_shape(integration_owner_db, statement, constraint):
    connection = integration_owner_db.connection()

    with pytest.raises(IntegrityError, match=constraint), connection.begin_nested():
        connection.execute(text(statement))


@pytest.fixture
def two_organizations():
    first, second = committed_organization("first"), committed_organization("second")
    errors = {name: uuid7() for name in ("first", "second", "none")}
    now = datetime.now(UTC)
    add_server_error(errors["first"], org_id=first, occurred_at=now)
    add_server_error(errors["second"], org_id=second, occurred_at=now)
    add_server_error(errors["none"], org_id=None, occurred_at=now)
    try:
        yield first, second, errors
    finally:
        remove_server_errors(*errors.values())
        remove_organizations(first, second)


def test_s6_c1_i16_server_errors_follow_the_bound_organization(two_organizations):
    first, second, errors = two_organizations
    query = text("SELECT request_id FROM public.server_errors WHERE request_id = ANY(:ids)")
    ids = {"ids": list(errors.values())}

    with runtime_engine().connect() as connection:
        unbound = set(connection.scalars(query, ids))
        connection.rollback()
        apply_connection_scope(connection, first)
        bound = set(connection.scalars(query, ids))
        with pytest.raises(ProgrammingError, match="row-level security"):
            connection.execute(text(
                "INSERT INTO public.server_errors (request_id, status, method, route, org_id) "
                "VALUES (gen_random_uuid(), 500, 'GET', '/api/x', :org)"
            ), {"org": second})
        connection.rollback()
        # The binding is transaction-local: unbound, no organization's row may be added.
        with pytest.raises(ProgrammingError, match="row-level security"):
            connection.execute(text(
                "INSERT INTO public.server_errors (request_id, status, method, route, org_id) "
                "VALUES (gen_random_uuid(), 500, 'GET', '/api/x', :org)"
            ), {"org": first})
        connection.rollback()

    assert unbound == {errors["none"]}
    assert bound == {errors["first"], errors["none"]}


def test_s5_c2_i4_retention_deletes_old_samples_and_errors_and_caps_the_log():
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    clear_samples()
    old_error, recent_error = uuid7(), uuid7()
    add_sample(now - timedelta(days=31))
    add_sample(now - timedelta(days=29))
    add_server_error(old_error, org_id=None, occurred_at=now - timedelta(days=31))
    add_server_error(recent_error, org_id=None, occurred_at=now - timedelta(days=1))
    with owner_engine().connect() as connection:
        # Errors other tests stored this run are newer than a day and fall under the cap too.
        existing = connection.scalar(text(
            "SELECT count(*) FROM public.server_errors WHERE request_id <> ALL(:ids)"
        ), {"ids": [old_error, recent_error]})
    with owner_engine().begin() as connection:
        # The cap counts every row; 50,001 more recent rows push out the two oldest.
        connection.execute(text(
            "INSERT INTO public.server_errors (request_id, occurred_at, status, method, route) "
            "SELECT gen_random_uuid(), now() - make_interval(secs => n), 500, 'GET', '/api/x' "
            "FROM generate_series(1, 50001) AS n"
        ))
    try:
        deleted = SystemHealthWorker(_settings()).retain_once()
        with owner_engine().connect() as connection:
            remaining = connection.scalar(text("SELECT count(*) FROM public.server_errors"))
            kept = set(connection.scalars(
                text("SELECT request_id FROM public.server_errors WHERE request_id = ANY(:ids)"),
                {"ids": [old_error, recent_error]},
            ))
        samples = [row[0] for row in sample_rows()]
    finally:
        with owner_engine().begin() as connection:
            connection.execute(text("DELETE FROM public.server_errors WHERE route = '/api/x'"))
        remove_server_errors(old_error, recent_error)
        clear_samples()

    # One old sample, one old error, then the oldest two of 50,002 errors under the cap.
    assert deleted == 4 + existing
    assert remaining == 50_000
    assert kept == set()
    assert samples == [now - timedelta(days=29)]


def _settings():
    from app.core.config import Settings

    return Settings(**settings_values(), _env_file=None)


def test_s5_c2_i4_retention_is_skipped_while_another_process_runs_it():
    held = owner_engine().connect()
    try:
        held.execute(text(
            "SELECT pg_advisory_xact_lock(hashtextextended('slateops:system-health-retention', 0))"
        ))
        with AuditSession(bind=runtime_engine()) as db:
            assert db.scalar(select(func.public.retain_system_health())) == 0
            db.rollback()
    finally:
        held.rollback()
        held.close()
