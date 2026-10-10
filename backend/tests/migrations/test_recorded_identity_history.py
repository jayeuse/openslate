"""Future-only recorded User history through a guarded forward migration."""

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from time import monotonic
from uuid import uuid4

import pytest
from sqlalchemy import text

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
# The recorded-history migration under test; later migrations may follow it.
REVISION = "482e986640e7"
PREVIOUS = "dc22b5c205a4"
COLUMNS = ("last_sign_in_at", "last_active_at")


class MigrationWorld:
    def __init__(self, environment, engine, identity):
        self.environment, self.engine, self.identity = environment, engine, identity

    def __iter__(self):
        return iter((self.environment, self.engine, self.identity))

    def __repr__(self):
        return "<owned guarded migration fixture>"


@pytest.fixture
def history_user():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity, provider = uuid4(), uuid4()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users(id,email,username,status,role) "
                "VALUES(:id,:email,:name,'active','member')"
            ),
            {"id": identity, "email": f"history-{identity}@example.test", "name": identity.hex},
        )
        connection.execute(
            text(
                "INSERT INTO "
                "identity_mfa_observations(user_id,observed_provider_user_id,verif"
                "ied_totp,observed_at) VALUES(:id,:provider,true,now())"
            ),
            {"id": identity, "provider": provider},
        )
    try:
        yield MigrationWorld(environment, engine, identity)
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
        engine.dispose()
        run_alembic(environment, "upgrade", "head")


def _column_count(connection):
    return connection.scalar(
        text(
            "SELECT count(*) FROM information_schema.columns WHERE "
            "table_schema='public' AND table_name='identity_mfa_observations' "
            "AND column_name IN ('last_sign_in_at','last_active_at')"
        )
    )


def test_upgrade_preserves_mfa_facts_and_initializes_only_null_history(history_user):
    environment, engine, identity = history_user
    run_alembic(environment, "downgrade", PREVIOUS)
    with engine.connect() as connection:
        before = connection.scalar(
            text("SELECT to_jsonb(o) FROM identity_mfa_observations o WHERE user_id=:id"),
            {"id": identity},
        )
        user = connection.scalar(
            text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": identity}
        )
    run_alembic(environment, "upgrade", REVISION)
    with engine.connect() as connection:
        # Observable upgrade outcome before referencing either potentially absent column.
        assert _column_count(connection) == 2
        after = connection.scalar(
            text("SELECT to_jsonb(o) FROM identity_mfa_observations o WHERE user_id=:id"),
            {"id": identity},
        )
        assert all(after.pop(column) is None for column in COLUMNS)
        assert after == before
        assert (
            connection.scalar(
                text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": identity}
            )
            == user
        )
        assert (
            connection.execute(
                text(
                    "SELECT data_type,is_nullable,column_default FROM "
                    "information_schema.columns WHERE table_schema='public' AND "
                    "table_name='identity_mfa_observations' AND column_name IN "
                    "('last_sign_in_at','last_active_at') ORDER BY column_name"
                )
            ).all()
            == [("timestamp with time zone", "YES", None)] * 2
        )
    runtime = guarded_create_engine(environment["TEST_DATABASE_URL"])
    try:
        with runtime.connect() as connection:
            assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
            assert connection.execute(
                text(
                    "SELECT last_sign_in_at,last_active_at FROM "
                    "identity_mfa_observations WHERE user_id=:id"
                ),
                {"id": identity},
            ).one() == (None, None)
    finally:
        runtime.dispose()


@pytest.mark.parametrize("field", COLUMNS)
def test_downgrade_refuses_recorded_history_without_losing_it(history_user, field):
    environment, engine, identity = history_user
    with engine.begin() as connection:
        connection.execute(
            text(f"UPDATE identity_mfa_observations SET {field}=now() WHERE user_id=:id"),
            {"id": identity},
        )
    try:
        refused = subprocess.run(
            [sys.executable, "-m", "alembic", "downgrade", PREVIOUS],
            env=environment,
            capture_output=True,
        )
        assert refused.returncode != 0
        with engine.connect() as connection:
            assert _column_count(connection) == 2
            assert (
                connection.scalar(
                    text(
                        f"SELECT {field} IS NOT NULL FROM identity_mfa_observations WHERE "
                        f"user_id=:id"
                    ),
                    {"id": identity},
                )
                is True
            )
    finally:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE identity_mfa_observations SET "
                    "last_sign_in_at=NULL,last_active_at=NULL WHERE user_id=:id"
                ),
                {"id": identity},
            )


def test_null_only_downgrade_and_upgrade_preserve_existing_observation(history_user):
    environment, engine, identity = history_user
    with engine.connect() as connection:
        before = connection.execute(
            text(
                "SELECT observed_provider_user_id,verified_totp,observed_at FROM "
                "identity_mfa_observations WHERE user_id=:id"
            ),
            {"id": identity},
        ).one()
    run_alembic(environment, "downgrade", PREVIOUS)
    with engine.connect() as connection:
        assert _column_count(connection) == 0
    run_alembic(environment, "upgrade", "head")
    with engine.connect() as connection:
        assert _column_count(connection) == 2
        assert (
            connection.execute(
                text(
                    "SELECT observed_provider_user_id,verified_totp,observed_at FROM "
                    "identity_mfa_observations WHERE user_id=:id"
                ),
                {"id": identity},
            ).one()
            == before
        )


def test_committed_writer_cannot_race_downgrade_data_loss(history_user):
    environment, engine, identity = history_user
    with engine.connect() as writer:
        writer.execute(
            text("UPDATE identity_mfa_observations SET last_active_at=now() WHERE user_id=:id"),
            {"id": identity},
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                subprocess.run,
                [sys.executable, "-m", "alembic", "downgrade", PREVIOUS],
                env=environment,
                capture_output=True,
            )
            try:
                limit = monotonic() + 10
                with engine.connect() as observer:
                    while not observer.scalar(
                        text(
                            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE "
                            "relation='public.identity_mfa_observations'::regclass AND NOT "
                            "granted)"
                        )
                    ):
                        assert monotonic() < limit and not pending.done(), (
                            "Downgrade did not reach actual table contention"
                        )
                writer.commit()
                assert pending.result(timeout=10).returncode != 0
                with engine.connect() as observer:
                    assert _column_count(observer) == 2
                    assert (
                        observer.scalar(
                            text(
                                "SELECT last_active_at IS NOT NULL FROM identity_mfa_observations "
                                "WHERE user_id=:id"
                            ),
                            {"id": identity},
                        )
                        is True
                    )
            finally:
                writer.rollback()
                pending.result(timeout=10)
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE identity_mfa_observations SET last_active_at=NULL WHERE user_id=:id"),
            {"id": identity},
        )
