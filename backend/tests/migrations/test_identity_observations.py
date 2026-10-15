"""Guarded catalog/backfill/ACL and fail-closed observation migration proofs."""

import subprocess
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
PREVIOUS = "bbd3b29fc017"
REVISION = "7d4538964ae2"


@pytest.fixture
def migration_user():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity = uuid4()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users(id,email,username,role,status) "
                "VALUES(:id,:email,:name,'admin','active')"
            ),
            {"id": identity, "email": f"observation-{identity}@example.test", "name": identity.hex},
        )
    try:
        yield identity
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
        engine.dispose()


def test_upgrade_initializes_unknown_observations_without_inventing_legacy_facts():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity, session_id = uuid4(), uuid4()
    try:
        run_alembic(environment, "downgrade", PREVIOUS)
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users(id,email,username,role,status) "
                    "VALUES(:id,:email,:name,'admin','active')"
                ),
                {
                    "id": identity,
                    "email": f"legacy-observation-{identity}@example.test",
                    "name": identity.hex,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO "
                    "identity_sessions(id,user_id,refresh_token_digest,csrf_token_digest,created_at,refreshed_at,expires_at)"
                    " VALUES(:id,:user,:refresh,:csrf,now(),now(),now()+interval '1 hour')"
                ),
                {
                    "id": session_id,
                    "user": identity,
                    "refresh": session_id.hex * 2,
                    "csrf": identity.hex * 2,
                },
            )
            before_user = connection.scalar(
                text("SELECT to_jsonb(users) FROM users WHERE id=:id"), {"id": identity}
            )
            before_session = connection.scalar(
                text("SELECT to_jsonb(identity_sessions) FROM identity_sessions WHERE id=:id"),
                {"id": session_id},
            )
        run_alembic(environment, "upgrade", REVISION)
        with engine.connect() as connection:
            # Observable upgrade outcome, before referencing a potentially absent column/table.
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM information_schema.columns WHERE "
                        "table_schema='public' AND table_name='identity_sessions' AND "
                        "column_name='ip_address'"
                    )
                )
                == 1
            )
            after_session = connection.scalar(
                text("SELECT to_jsonb(identity_sessions) FROM identity_sessions WHERE id=:id"),
                {"id": session_id},
            )
            assert after_session.pop("ip_address") is None
            assert after_session == before_session
            assert (
                connection.scalar(
                    text("SELECT to_jsonb(users) FROM users WHERE id=:id"), {"id": identity}
                )
                == before_user
            )
            row = connection.execute(
                text(
                    "SELECT observed_provider_user_id,verified_totp,observed_at FROM "
                    "identity_mfa_observations WHERE user_id=:id"
                ),
                {"id": identity},
            ).one()
            assert tuple(row) == (None, None, None)
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM users u LEFT JOIN identity_mfa_observations o ON "
                        "o.user_id=u.id WHERE o.user_id IS NULL"
                    )
                )
                == 0
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM identity_mfa_observations WHERE "
                        "observed_provider_user_id IS NOT NULL OR verified_totp IS NOT NULL OR "
                        "observed_at IS NOT NULL"
                    )
                )
                == 0
            )
    finally:
        try:
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
        finally:
            try:
                run_alembic(environment, "upgrade", "head")
                run_alembic(environment, "check")
            finally:
                engine.dispose()


@pytest.mark.parametrize(
    "bad",
    ["known_without_binding", "known_without_time", "binding_without_time", "time_without_binding"],
)
def test_observation_check_rejects_incomplete_authority(bad, migration_user):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    values = {
        "user": migration_user,
        "provider": uuid4(),
        "verified": True,
        "observed": "2035-01-01T00:00:00Z",
    }
    values[
        "provider" if bad in {"known_without_binding", "time_without_binding"} else "observed"
    ] = None
    if bad in {"binding_without_time", "time_without_binding"}:
        values["verified"] = None
    try:
        with engine.connect() as connection:
            with pytest.raises(IntegrityError) as caught:
                connection.execute(
                    text(
                        "INSERT INTO "
                        "identity_mfa_observations(user_id,observed_provider_user_id,verified_totp,observed_at)"
                        " VALUES(:user,:provider,:verified,:observed)"
                    ),
                    values,
                )
            assert (
                caught.value.orig.diag.constraint_name == "ck_identity_mfa_observations_authority"
            )
            connection.rollback()
    finally:
        engine.dispose()


def test_runtime_projection_privileges_and_user_cascade_are_narrow(migration_user):
    environment = guarded_migration_environment()
    runtime = guarded_create_engine(environment["TEST_DATABASE_URL"])
    owner = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        with runtime.begin() as connection:
            connection.execute(
                text("INSERT INTO identity_mfa_observations(user_id) VALUES(:id)"),
                {"id": migration_user},
            )
            assert (
                connection.scalar(
                    text("SELECT verified_totp FROM identity_mfa_observations WHERE user_id=:id"),
                    {"id": migration_user},
                )
                is None
            )
            connection.execute(
                text(
                    "UPDATE identity_mfa_observations SET "
                    "verified_totp=false,observed_at=now(),observed_provider_user_id=:provider"
                    " WHERE user_id=:id"
                ),
                {"id": migration_user, "provider": uuid4()},
            )
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege(current_user,'auth.sessions','SELECT')")
                )
                is False
            )
        with owner.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": migration_user})
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM identity_mfa_observations WHERE user_id=:id"),
                    {"id": migration_user},
                )
                == 0
            )
    finally:
        runtime.dispose()
        owner.dispose()


@pytest.mark.parametrize("fact", ["ip", "observation"])
def test_downgrade_refuses_collected_facts_before_ddl(fact, migration_user):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    session_id = uuid4()
    try:
        run_alembic(environment, "downgrade", REVISION)
        with engine.begin() as connection:
            if fact == "ip":
                connection.execute(
                    text(
                        "INSERT INTO "
                        "identity_sessions(id,user_id,refresh_token_digest,csrf_token_digest,created_at,refreshed_at,expires_at,ip_address)"
                        " VALUES(:id,:user,:refresh,:csrf,now(),now(),now()+interval '1 "
                        "hour','192.0.2.3')"
                    ),
                    {
                        "id": session_id,
                        "user": migration_user,
                        "refresh": session_id.hex * 2,
                        "csrf": session_id.hex * 2,
                    },
                )
            else:
                connection.execute(
                    text(
                        "INSERT INTO "
                        "identity_mfa_observations(user_id,observed_provider_user_id,observed_at)"
                        " VALUES(:id,:provider,now())"
                    ),
                    {"id": migration_user, "provider": uuid4()},
                )
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", PREVIOUS)
        with engine.begin() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == REVISION
            assert (
                connection.scalar(text("SELECT to_regclass('public.identity_mfa_observations')"))
                is not None
            )
            connection.execute(
                text("DELETE FROM identity_sessions WHERE id=:id"), {"id": session_id}
            )
            connection.execute(
                text("DELETE FROM identity_mfa_observations WHERE user_id=:id"),
                {"id": migration_user},
            )
            connection.execute(
                text("INSERT INTO identity_mfa_observations(user_id) VALUES(:id)"),
                {"id": migration_user},
            )
        run_alembic(environment, "downgrade", PREVIOUS)
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
            run_alembic(environment, "check")
        finally:
            engine.dispose()


@pytest.mark.parametrize("fact", ["ip", "observation"])
def test_downgrade_cannot_drop_a_fact_committed_after_its_initial_read(
    fact, migration_user, monkeypatch
):
    """Observe actual PostgreSQL locks/commits and real Alembic DDL, not call-order mocks."""
    import importlib.util
    from concurrent.futures import ThreadPoolExecutor
    from pathlib import Path
    from threading import Event

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy.exc import OperationalError

    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    path = Path("migrations/versions/7d4538964ae2_add_session_ip_and_mfa_observations.py")
    spec = importlib.util.spec_from_file_location("observation_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    guard_read, writer_finished = Event(), Event()
    session_id = uuid4()

    def downgrade():
        with engine.connect() as connection:
            transaction = connection.begin()
            operation = Operations(MigrationContext.configure(connection))
            original = connection.exec_driver_sql

            def read_then_wait(statement, *args, **kwargs):
                result = original(statement, *args, **kwargs)
                if statement.startswith("SELECT EXISTS"):
                    guard_read.set()
                    assert writer_finished.wait(5), "Concurrent guarded writer did not finish"
                return result

            monkeypatch.setattr(connection, "exec_driver_sql", read_then_wait)
            monkeypatch.setattr(module, "op", operation)
            error = None
            try:
                module.downgrade()
            except RuntimeError as caught_error:
                error = caught_error
            finally:
                # Roll back this actual DDL so only the owned test data need cleanup.
                transaction.rollback()
            if error is not None:
                assert "Cannot discard captured" in str(error)
                return "refused_captured_fact"
            return "ddl_completed"

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(downgrade)
            assert guard_read.wait(5), "Migration never reached its real captured-fact query"
            outcome = None
            error = None
            try:
                with engine.begin() as connection:
                    table = "identity_sessions" if fact == "ip" else "identity_mfa_observations"
                    # A bounded actual write admission distinguishes held table locks from no guard.
                    connection.exec_driver_sql(f"LOCK TABLE {table} IN ROW EXCLUSIVE MODE NOWAIT")
                    if fact == "ip":
                        connection.execute(
                            text(
                                "INSERT INTO "
                                "identity_sessions(id,user_id,refresh_token_digest,csrf_token_digest,created_at,refreshed_at,expires_at,ip_address)"
                                " VALUES(:id,:user,:refresh,:csrf,now(),now(),now()+interval '1 "
                                "hour','192.0.2.7')"
                            ),
                            {
                                "id": session_id,
                                "user": migration_user,
                                "refresh": session_id.hex * 2,
                                "csrf": session_id.hex * 2,
                            },
                        )
                    else:
                        connection.execute(
                            text(
                                "INSERT INTO "
                                "identity_mfa_observations(user_id,observed_provider_user_id,observed_at)"
                                " VALUES(:id,:provider,now())"
                            ),
                            {"id": migration_user, "provider": uuid4()},
                        )
                outcome = "fact_committed"
            except OperationalError as caught_error:
                error = caught_error
            finally:
                writer_finished.set()
            if error is not None:
                assert error.orig.sqlstate == "55P03"
                outcome = "writer_refused_by_table_lock"
            result = pending.result(timeout=5)
        assert not (outcome == "fact_committed" and result == "ddl_completed"), (
            "A committed fact crossed the guard read and was dropped by real DDL",
            outcome,
            result,
        )
    finally:
        writer_finished.set()
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM identity_sessions WHERE id=:id"), {"id": session_id}
            )
            connection.execute(
                text("DELETE FROM identity_mfa_observations WHERE user_id=:id"),
                {"id": migration_user},
            )
        engine.dispose()
