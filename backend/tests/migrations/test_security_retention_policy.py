"""Guarded schema/capability admission and data-preserving retention downgrade."""

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from time import monotonic

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
PREVIOUS = "482e986640e7"
FIELDS = ("session_retention_days", "security_event_retention_days")


class MigrationWorld:
    def __init__(self, environment, engine):
        self.environment, self.engine = environment, engine

    def __repr__(self):
        return "<owned guarded retention migration fixture>"


@pytest.fixture
def policy_migration():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        yield MigrationWorld(environment, engine)
    finally:
        with engine.begin() as connection:
            names = set(
                connection.scalars(
                    text(
                        "SELECT column_name FROM information_schema.columns WHERE "
                        "table_schema='public' AND table_name='workspace_profiles'"
                    )
                )
            )
            if set(FIELDS) <= names:
                connection.execute(
                    text(
                        "UPDATE public.workspace_profiles SET session_retention_days=365, "
                        "security_event_retention_days=365"
                    )
                )
        run_alembic(environment, "upgrade", "head")
        engine.dispose()


def _count_columns(connection):
    return connection.scalar(
        text(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
            "AND table_name='workspace_profiles' AND column_name IN "
            "('session_retention_days','security_event_retention_days')"
        )
    )


def test_upgrade_adds_defaults_without_cleanup_and_preserves_existing_configuration(
    policy_migration,
):
    world = policy_migration
    run_alembic(world.environment, "downgrade", PREVIOUS)
    with world.engine.connect() as connection:
        before = connection.scalar(text("SELECT to_jsonb(p) FROM public.workspace_profiles p"))
        counts = connection.execute(
            text(
                "SELECT (SELECT count(*) FROM public.identity_sessions), "
                "(SELECT count(*) FROM public.security_events), "
                "(SELECT count(*) FROM public.identity_mfa_observations)"
            )
        ).one()
    run_alembic(world.environment, "upgrade", "head")
    with world.engine.connect() as connection:
        # Observable upgrade result before using any potentially absent column/routine.
        assert _count_columns(connection) == 2
        after = connection.scalar(text("SELECT to_jsonb(p) FROM public.workspace_profiles p"))
        assert [after.pop(field) for field in FIELDS] == [365, 365]
        assert after == before
        assert (
            connection.execute(
                text(
                    "SELECT (SELECT count(*) FROM public.identity_sessions), "
                    "(SELECT count(*) FROM public.security_events), "
                    "(SELECT count(*) FROM public.identity_mfa_observations)"
                )
            ).one()
            == counts
        )
        assert (
            connection.execute(
                text(
                    "SELECT data_type,is_nullable,column_default FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name='workspace_profiles' "
                    "AND column_name IN ('session_retention_days','security_event_retention_days') "
                    "ORDER BY column_name"
                )
            ).all()
            == [("integer", "NO", "365")] * 2
        )
    subprocess.run([sys.executable, "-m", "alembic", "check"], env=world.environment, check=True)


@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("value", [0, 3651, None])
def test_named_retention_bounds_reject_invalid_storage(policy_migration, field, value):
    with policy_migration.engine.begin() as connection:
        with pytest.raises(IntegrityError), connection.begin_nested():
            connection.execute(
                text(f"UPDATE public.workspace_profiles SET {field}=:value"), {"value": value}
            )


@pytest.mark.parametrize("field", FIELDS)
def test_downgrade_refuses_configured_retention_before_losing_it(policy_migration, field):
    world = policy_migration
    with world.engine.begin() as connection:
        connection.execute(text(f"UPDATE public.workspace_profiles SET {field}=30"))
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", PREVIOUS],
        env=world.environment,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    with world.engine.connect() as connection:
        assert _count_columns(connection) == 2
        assert connection.scalar(text(f"SELECT {field} FROM public.workspace_profiles")) == 30
        assert connection.scalar(text("SELECT to_regprocedure('public.retain_security_events()')"))


def test_default_only_downgrade_roundtrip_does_not_delete_events(policy_migration):
    world = policy_migration
    with world.engine.connect() as connection:
        before = connection.scalar(text("SELECT count(*) FROM public.security_events"))
    run_alembic(world.environment, "downgrade", PREVIOUS)
    with world.engine.connect() as connection:
        assert _count_columns(connection) == 0
        assert (
            connection.scalar(text("SELECT to_regprocedure('public.retain_security_events()')"))
            is None
        )
    run_alembic(world.environment, "upgrade", "head")
    with world.engine.connect() as connection:
        assert _count_columns(connection) == 2
        assert connection.scalar(text("SELECT count(*) FROM public.security_events")) == before


def test_capability_catalog_is_zero_argument_owner_bound_and_narrowly_granted(policy_migration):
    with policy_migration.engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT p.pronargs,p.prosecdef,p.provolatile,p.proparallel,p.proconfig, "
                "pg_get_userbyid(p.proowner),pg_get_function_result(p.oid) FROM pg_proc p "
                "WHERE p.oid='public.retain_security_events()'::regprocedure"
            )
        ).one()
        assert row[0:4] == (0, True, "v", "u")
        settings = dict(value.split("=", 1) for value in row[4])
        assert settings["search_path"] == "pg_catalog, pg_temp"
        assert settings["TimeZone"] == "UTC"
        assert row[5:] == ("openslate_owner", "integer")
        assert connection.scalar(text("SELECT to_regprocedure('pg_catalog.gen_random_uuid()')"))
        for role in ("anon", "authenticated", "service_role"):
            assert (
                connection.scalar(
                    text(
                        "SELECT has_function_privilege(:role,"
                        "'public.retain_security_events()','EXECUTE')"
                    ),
                    {"role": role},
                )
                is False
            )
        assert (
            connection.scalar(
                text(
                    "SELECT has_function_privilege('openslate_runtime', "
                    "'public.retain_security_events()','EXECUTE')"
                )
            )
            is True
        )
        assert (
            connection.scalar(
                text(
                    "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) acl "
                    "WHERE p.oid='public.retain_security_events()'::regprocedure AND acl.grantee=0"
                )
            )
            == 0
        )


def test_downgrade_waits_for_concurrent_policy_change_then_refuses_it(policy_migration):
    world = policy_migration
    with world.engine.connect() as writer:
        transaction = writer.begin()
        writer.execute(text("UPDATE public.workspace_profiles SET session_retention_days=30"))
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                subprocess.run,
                [sys.executable, "-m", "alembic", "downgrade", PREVIOUS],
                env=world.environment,
                capture_output=True,
                text=True,
            )
            try:
                deadline = monotonic() + 8
                with world.engine.connect() as observer:
                    while monotonic() < deadline:
                        waiting = observer.scalar(
                            text(
                                "SELECT count(*) FROM pg_locks WHERE "
                                "relation='public.workspace_profiles'::regclass "
                                "AND NOT granted"
                            )
                        )
                        if waiting:
                            break
                    assert waiting, "Downgrade did not reach its real policy-lock boundary"
                transaction.commit()
                assert pending.result(timeout=8).returncode != 0
            finally:
                if transaction.is_active:
                    transaction.rollback()
    with world.engine.connect() as connection:
        assert _count_columns(connection) == 2
        assert (
            connection.scalar(text("SELECT session_retention_days FROM public.workspace_profiles"))
            == 30
        )
