"""Catalog and privilege contract for the disposable vanilla PostgreSQL baseline."""

import os
import select
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier

import psycopg
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.access.identity.rate_limits import login_fingerprint
from app.systems.access.identity.service import InvalidCredentials, authenticate_password
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.platform.files.models import File
from tests.conftest import _guard_integration_database, guarded_create_engine
from tests.operations import migration_support
from tests.operations.migration_support import guarded_migration_environment, run_alembic


def _catalog(db, statement: str):
    return db.connection().execute(text(statement))


@pytest.mark.integration
def test_baseline_has_one_head_and_local_identity_file_catalog(integration_owner_db) -> None:
    config = Config("alembic.ini")
    heads = ScriptDirectory.from_config(config).get_heads()
    assert len(heads) == 1
    current_revision = _catalog(
        integration_owner_db, "SELECT version_num FROM alembic_version"
    ).scalar()
    assert current_revision == heads[0]
    tables = set(
        _catalog(
            integration_owner_db,
            "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
        ).scalars()
    )
    assert {
        "users",
        "identity_credentials",
        "identity_sessions",
        "identity_delivery_outbox",
        "files",
    } <= tables
    assert "alembic_version" in tables
    assert _catalog(
        integration_owner_db, "SELECT role FROM public.roles ORDER BY role"
    ).scalars().all() == ["admin", "member"]
    assert _catalog(
        integration_owner_db,
        "SELECT display_name, timezone, locale FROM public.workspace_profiles",
    ).one() == ("OpenSlate", "UTC", "en-US")


@pytest.mark.integration
def test_baseline_uses_owner_app_runtime_roles_without_public_or_rls(integration_owner_db) -> None:
    roles = dict(
        _catalog(
            integration_owner_db,
            """
            SELECT rolname, (rolcanlogin, rolinherit, rolsuper, rolbypassrls)::text
              FROM pg_catalog.pg_roles
             WHERE rolname IN ('openslate_owner', 'openslate_app', 'openslate_runtime')
            """,
        ).all()
    )
    assert roles == {
        "openslate_owner": "(t,f,f,f)",
        "openslate_app": "(f,f,f,f)",
        "openslate_runtime": "(t,t,f,f)",
    }
    owner, public_connect = _catalog(
        integration_owner_db,
        """
        SELECT datdba::regrole::text,
               has_database_privilege('public', current_database(), 'CONNECT')
          FROM pg_catalog.pg_database WHERE datname = current_database()
        """,
    ).one()
    assert (owner, public_connect) == ("openslate_owner", False)
    audit_privileges = _catalog(
        integration_owner_db,
        """
        SELECT has_table_privilege('openslate_runtime', 'public.audit_logs', 'UPDATE'),
               has_table_privilege('openslate_runtime', 'public.audit_logs', 'DELETE'),
               has_table_privilege('openslate_runtime', 'public.security_events', 'UPDATE'),
               has_table_privilege('openslate_runtime', 'public.security_events', 'DELETE')
        """,
    ).one()
    assert audit_privileges == (False, False, False, False)
    default_function_acl = _catalog(
        integration_owner_db,
        """
        SELECT count(*)
          FROM pg_catalog.pg_default_acl AS defaults
         WHERE defaults.defaclrole = 'openslate_owner'::regrole
           AND defaults.defaclobjtype = 'f'
           AND defaults.defaclnamespace = 0
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.aclexplode(defaults.defaclacl) AS privilege
                WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
           )
        """,
    ).scalar()
    assert default_function_acl == 1
    assert _catalog(integration_owner_db, "SELECT count(*) FROM pg_catalog.pg_policy").scalar() == 0
    assert (
        _catalog(
            integration_owner_db,
            "SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace "
            "AND relkind = 'r' AND relrowsecurity",
        ).scalar()
        == 0
    )
    assert (
        _catalog(
            integration_owner_db,
            "SELECT count(*) FROM pg_catalog.pg_namespace "
            "WHERE nspname IN ('auth', 'storage', 'realtime')",
        ).scalar()
        == 0
    )
    assert (
        _catalog(
            integration_owner_db,
            "SELECT count(*) FROM pg_catalog.pg_proc WHERE proname ILIKE 'openslate_%'",
        ).scalar()
        == 0
    )


@pytest.mark.integration
def test_runtime_can_use_application_tables_but_cannot_change_schema(integration_db) -> None:
    assert _catalog(integration_db, "SELECT count(*) FROM public.users").scalar() == 0
    with pytest.raises(ProgrammingError):
        _catalog(integration_db, "CREATE TABLE public.runtime_schema_escape (id integer)")
    integration_db.rollback()


@pytest.mark.integration
def test_inspector_can_read_application_tables_but_cannot_mutate_them() -> None:
    database_url = os.getenv("TEST_INSPECTOR_DATABASE_URL", "")
    if not database_url:
        pytest.skip("Set TEST_INSPECTOR_DATABASE_URL to run PostgreSQL integration tests")
    _guard_integration_database(database_url)
    psycopg_url = database_url.replace("postgresql+psycopg", "postgresql")
    with psycopg.connect(psycopg_url, autocommit=True) as inspector:
        assert inspector.execute("SELECT current_user").fetchone() == ("openslate_inspector",)
        assert inspector.execute("SELECT count(*) FROM public.roles").fetchone() == (2,)
        privileges = inspector.execute(
            """
            SELECT has_schema_privilege(current_user, 'public', 'CREATE'),
                   has_table_privilege(current_user, 'public.roles', 'SELECT'),
                   has_table_privilege(current_user, 'public.roles', 'INSERT,UPDATE,DELETE')
            """
        ).fetchone()
        assert privileges == (False, True, False)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            inspector.execute("DELETE FROM public.roles WHERE false")


@pytest.mark.integration
def test_concurrent_failed_logins_create_one_rate_limit_bucket_without_a_database_error(
    integration_owner_db,
) -> None:
    database_url = os.environ["TEST_DATABASE_URL"]
    barrier = Barrier(2)

    def fail_login() -> None:
        engine = guarded_create_engine(database_url)
        try:
            with Session(engine) as db:
                barrier.wait(timeout=5)
                with pytest.raises(InvalidCredentials):
                    authenticate_password(db, "missing@example.test", "wrong-password")
                db.commit()
        finally:
            engine.dispose()

    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            list(workers.map(lambda _: fail_login(), range(2)))

        bucket = integration_owner_db.query(IdentityRateLimitBucket).one()
        assert bucket.attempt_count == 2
    finally:
        cleanup_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
        try:
            with cleanup_engine.begin() as connection:
                connection.execute(text("DELETE FROM public.identity_rate_limit_buckets"))
        finally:
            cleanup_engine.dispose()


@pytest.mark.integration
def test_concurrent_failed_logins_replace_a_stale_current_bucket_before_locking_it(
    integration_owner_db,
) -> None:
    database_url = os.environ["TEST_DATABASE_URL"]
    fingerprint = login_fingerprint("stale@example.test", None)
    stale_at = datetime.now(UTC) - timedelta(hours=1)
    seed_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    barrier = Barrier(2)

    try:
        with Session(seed_engine) as seed:
            seed.add(
                IdentityRateLimitBucket(
                    fingerprint=fingerprint,
                    attempt_count=4,
                    window_started_at=stale_at,
                    blocked_until=stale_at + timedelta(minutes=15),
                )
            )
            seed.commit()

        def fail_login() -> None:
            engine = guarded_create_engine(database_url)
            try:
                with Session(engine) as db:
                    barrier.wait(timeout=5)
                    with pytest.raises(InvalidCredentials):
                        authenticate_password(db, "stale@example.test", "wrong-password")
                    db.commit()
            finally:
                engine.dispose()

        with ThreadPoolExecutor(max_workers=2) as workers:
            list(workers.map(lambda _: fail_login(), range(2)))

        bucket = integration_owner_db.get(IdentityRateLimitBucket, fingerprint)
        assert bucket is not None
        assert bucket.attempt_count == 2
        assert bucket.window_started_at > stale_at
    finally:
        with seed_engine.begin() as connection:
            connection.execute(text("DELETE FROM public.identity_rate_limit_buckets"))
        seed_engine.dispose()


@pytest.mark.integration
def test_postgres_notifications_arrive_only_after_the_publishing_transaction_commits() -> None:
    database_url = os.environ["TEST_DATABASE_URL"].replace("postgresql+psycopg", "postgresql")
    with psycopg.connect(database_url, autocommit=True) as listener:
        listener.execute("LISTEN openslate_invalidation")
        with psycopg.connect(database_url) as sender:
            sender.execute("SELECT pg_notify(%s, %s)", ("openslate_invalidation", "committed"))
            sender.commit()
        notification = next(listener.notifies(timeout=5))
        assert notification.payload == "committed"

        with psycopg.connect(database_url) as sender:
            sender.execute("SELECT pg_notify(%s, %s)", ("openslate_invalidation", "rolled_back"))
            sender.rollback()
        assert select.select([listener.pgconn.socket], [], [], 0.2) == ([], [], [])


@pytest.mark.integration
def test_runtime_role_can_create_guarded_private_file_metadata() -> None:
    creator_id = None
    owner_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    try:
        with Session(owner_engine) as owner_db:
            role = owner_db.query(Role).filter_by(role="member").one()
            creator = User(
                email="file-metadata@example.test",
                username="file-metadata",
                status=UserStatus.ACTIVE.value,
                role_id=role.id,
            )
            owner_db.add(creator)
            owner_db.commit()
            creator_id = creator.id
    finally:
        owner_engine.dispose()

    assert creator_id is not None
    runtime_engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    try:
        with Session(runtime_engine) as runtime_db:
            file = File(
                purpose="library_document",
                creator_id=creator_id,
                filename="private.pdf",
                expected_size=1024,
                object_key="metadata-flow-object",
                state="awaiting_upload",
            )
            runtime_db.add(file)
            runtime_db.commit()
            assert runtime_db.get(File, file.id).creator_id == creator_id
    finally:
        runtime_engine.dispose()
        cleanup_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
        try:
            with cleanup_engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM public.files WHERE creator_id = :creator"),
                    {"creator": creator_id},
                )
                connection.execute(
                    text("DELETE FROM public.users WHERE id = :creator"), {"creator": creator_id}
                )
        finally:
            cleanup_engine.dispose()


@pytest.mark.integration
def test_downgrade_then_reupgrade_keeps_audit_and_security_events_non_destructive() -> None:
    environment = guarded_migration_environment()
    for operation in ("downgrade", "upgrade"):
        run_alembic(environment, operation, "base" if operation == "downgrade" else "head")
    database_url = environment["TEST_DATABASE_URL"].replace("postgresql+psycopg", "postgresql")
    with psycopg.connect(database_url, autocommit=True) as runtime:
        privileges = runtime.execute(
            """
            SELECT has_table_privilege(current_user, 'public.audit_logs', 'UPDATE'),
                   has_table_privilege(current_user, 'public.audit_logs', 'DELETE'),
                   has_table_privilege(current_user, 'public.security_events', 'UPDATE'),
                   has_table_privilege(current_user, 'public.security_events', 'DELETE')
            """
        ).fetchone()
    assert privileges == (False, False, False, False)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("TEST_DATABASE_URL", None),
        (
            "TEST_DATABASE_URL",
            "postgresql+psycopg://openslate_runtime:wrong@127.0.0.1:55322/openslate",
        ),
        (
            "MIGRATION_DATABASE_URL",
            "postgresql+psycopg://openslate_owner:wrong@127.0.0.1:55322/openslate",
        ),
    ],
)
def test_downgrade_reupgrade_requires_manifest_owned_database_urls(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv(name, raising=False)
    else:
        monkeypatch.setenv(name, value)

    with pytest.raises(RuntimeError, match="runner-owned"):
        guarded_migration_environment()


def test_downgrade_reupgrade_forces_validated_process_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_url = "postgresql+psycopg://openslate_runtime:runtime@127.0.0.1:55322/openslate"
    owner_url = "postgresql+psycopg://openslate_owner:owner@127.0.0.1:55322/openslate"
    guarded: list[str] = []
    monkeypatch.delenv("OPENSLATE_ENV_SOURCE", raising=False)
    monkeypatch.setenv("TEST_DATABASE_URL", runtime_url)
    monkeypatch.setenv("MIGRATION_DATABASE_URL", owner_url)
    monkeypatch.setattr(migration_support, "_guard_integration_database", guarded.append)

    environment = guarded_migration_environment()

    assert guarded == [runtime_url, owner_url]
    assert environment["OPENSLATE_ENV_SOURCE"] == "process"
    assert environment["TEST_DATABASE_URL"] == runtime_url
    assert environment["MIGRATION_DATABASE_URL"] == owner_url
