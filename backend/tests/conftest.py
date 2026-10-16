import copy
import os
from collections.abc import Generator
from functools import cache
from pathlib import Path
from secrets import token_urlsafe

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.config import instance as _instance_module
from app.core.config import provider_instance as _provider_instance_module
from app.core.database import model_registry  # noqa: F401
from app.core.database.organization_scope import scope_session, worker_organization
from app.core.database.session import AuditSession
from app.systems.access.identity.provider_user_cache import clear_provider_users
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.config_support import settings_environment
from tests.database_pool import pooled_engine
from tests.organization_scope_support import (
    UNIT_ORGANIZATION_ID,
    bind_test_organization,
    organization_bindings,
)
from tests.postgres_runtime import assert_runner_database_url

MOCK_DATABASE_PASSWORD = token_urlsafe(32)


def create_organization(db: Session, **values) -> WorkspaceProfile:
    """Create owned fixture data without manufacturing application audit actions."""
    identity = values.pop("id", uuid7())
    db.connection().execute(
        WorkspaceProfile.__table__.insert().values(
            id=identity,
            **{
                "slug": f"test-{identity}", "display_name": "Test organization",
                "timezone": "UTC", "locale": "en-US", **values,
            },
        )
    )
    organization = db.get(WorkspaceProfile, identity)
    assert organization is not None
    # Like the operator command, bind the session to the organization it just created.
    scope_session(db, identity)
    # Raw runtime connections and direct worker calls in this test thread use it as well;
    # request handlers run in TestClient threads and still bind their own organization.
    bind_test_organization(identity)
    return organization


def membership_of(db: Session, user_id) -> Membership:
    """The only live membership of a single-organization fixture account."""
    memberships = db.scalars(select(Membership).where(
        Membership.user_id == user_id, Membership.is_deleted.is_(False),
    ).limit(2)).all()
    assert len(memberships) == 1, "fixture account must belong to exactly one organization"
    return memberships[0]


def workspace_of(db: Session, user_id) -> WorkspaceProfile:
    """The organization of a single-organization fixture account."""
    organization = db.get(WorkspaceProfile, membership_of(db, user_id).org_id)
    assert organization is not None
    return organization


def create_member(
    db: Session | None, organization: WorkspaceProfile, role: str = UserRole.MEMBER.value,
    *, user: User | None = None, **values,
) -> tuple[User, Membership]:
    """Build the account and its explicit organization-local fixture membership."""
    identity = values.pop("id", uuid7())
    status = values.pop("status", "active")
    membership_values = {
        key: values.pop(key)
        for key in (
            "sponsor_user_id", "expires_at", "invitation_sent_at", "invitation_accepted_at",
            "provider_invitation_operation_id", "mfa_required_since",
        )
        if key in values
    }
    if user is None:
        account = User(
            id=identity, email=values.pop("email", f"person-{identity}@example.test"),
            username=values.pop("username", f"person-{identity}"), status=status, **values,
        )
        if db is None:
            user = account
        else:
            db.connection().execute(User.__table__.insert().values(
                **{column.name: getattr(account, column.name)
                   for column in User.__table__.columns if column.name in account.__dict__}
            ))
            user = db.get(User, identity)
            assert user is not None
    membership = Membership(
        id=uuid7(), org_id=organization.id, user_id=user.id, role=role,
        status=status, **membership_values,
    )
    if db is not None:
        db.connection().execute(Membership.__table__.insert().values(
            **{column.name: getattr(membership, column.name)
               for column in Membership.__table__.columns if column.name in membership.__dict__}
        ))
        membership = db.get(Membership, membership.id)
        assert membership is not None
    return user, membership

# The runner-owned stack does not change while one pytest process runs, so repeated
# `docker inspect` answers are memoized per process and Docker endpoint. Each app lifespan
# otherwise spends four Docker CLI calls on the ownership check. Failures are never
# cached, and tests that need other answers still monkeypatch `_docker_json` themselves.
_REAL_DOCKER_JSON = _instance_module._docker_json
_DOCKER_JSON_CACHE: dict[tuple[str | None, ...], object] = {}


def _memoized_docker_json(arguments):
    endpoint = (os.environ.get("DOCKER_HOST"), os.environ.get("DOCKER_CONTEXT"))
    key = (*endpoint, *arguments)
    if key not in _DOCKER_JSON_CACHE:
        _DOCKER_JSON_CACHE[key] = _REAL_DOCKER_JSON(arguments)
    return copy.deepcopy(_DOCKER_JSON_CACHE[key])


_instance_module._docker_json = _memoized_docker_json
_provider_instance_module._docker_json = _memoized_docker_json

if os.getenv("TEST_DATABASE_URL") is None and os.getenv("E2E_ALLOW_MUTATIONS") != "true":
    os.environ.update(settings_environment())
    os.environ["OPENSLATE_ENV_SOURCE"] = "process"


# Live Docker ownership verified by the test fixtures, per process (see _guard_for_test).
_OWNERSHIP_CACHE: dict[tuple[object, ...], object] = {}


def _guard_integration_database(database_url: str, ownership_cache=None) -> None:
    """Allow integration tests to touch only the runner-owned PostgreSQL database."""

    if database_url == os.getenv("TEST_DATABASE_URL"):
        roles = frozenset({"openslate_runtime"})
    elif database_url == os.getenv("MIGRATION_DATABASE_URL"):
        roles = frozenset({"openslate_owner"})
    else:
        assert_runner_database_url(database_url, ownership_cache=ownership_cache)
        return
    # The per-test identity check runs on a pooled connection; see tests/database_pool.py.
    assert_runner_database_url(
        database_url,
        allowed_roles=roles,
        ownership_cache=ownership_cache,
        engine=pooled_engine(database_url) if ownership_cache is not None else None,
    )


def guarded_create_engine(database_url, **options):
    """Guard direct test connections as well as shared session fixtures.

    The live Docker ownership verdict is reused per process and the identity check runs
    on a pooled connection, as in the per-test guard; the caller still gets its own engine.
    """
    _guard_integration_database(database_url, ownership_cache=_OWNERSHIP_CACHE)
    return create_engine(database_url, **options)


def guarded_pooled_engine(database_url: str):
    """Guard *database_url*, then return this process's shared pool for it.

    For short helper statements that used to open a new engine each time; callers must
    not dispose it (see tests/database_pool.py).
    """
    _guard_integration_database(database_url, ownership_cache=_OWNERSHIP_CACHE)
    return pooled_engine(database_url)


_GUARDED_IN_TEST = pytest.StashKey[set[tuple[str, tuple[tuple[str, str], ...]]]]()


def _guard_for_test(request, database_url: str) -> None:
    """Guard *database_url* once per test.

    Every test rechecks the connected database identity; live Docker ownership is verified
    once per process for the same URL and environment. Within one test, a fixture reuses
    the whole verdict. Refusals are never recorded.
    """

    key = (database_url, tuple(sorted(os.environ.items())))
    guarded = request.node.stash.setdefault(_GUARDED_IN_TEST, set())
    if key in guarded:
        return
    _guard_integration_database(database_url, ownership_cache=_OWNERSHIP_CACHE)
    guarded.add(key)


@pytest.fixture(autouse=True)
def _bound_test_organizations(request):
    if request.node.get_closest_marker("integration") is None:
        # A unit test acts in one organization, as a bound request would.
        with organization_bindings(), worker_organization(UNIT_ORGANIZATION_ID):
            yield
        return
    with organization_bindings():
        yield


@pytest.fixture(autouse=True)
def _isolated_provider_user_cache():
    clear_provider_users()
    yield
    clear_provider_users()


@pytest.fixture(autouse=True)
def _guard_direct_database_tests(request):
    if request.node.get_closest_marker("integration") and os.getenv("TEST_DATABASE_URL"):
        _guard_for_test(request, os.environ["TEST_DATABASE_URL"])
        _guard_for_test(request, os.getenv("MIGRATION_DATABASE_URL", ""))


def pytest_collection_modifyitems(session, config, items):
    if os.getenv("OPENSLATE_REQUIRE_DATABASE_TESTS") == "true":
        _guard_integration_database(os.getenv("TEST_DATABASE_URL", ""))
        _guard_integration_database(os.getenv("MIGRATION_DATABASE_URL", ""))


def pytest_sessionfinish(session, exitstatus):
    if os.getenv("OPENSLATE_REQUIRE_DATABASE_TESTS") == "true":
        reporter = session.config.pluginmanager.get_plugin("terminalreporter")
        if reporter and reporter.stats.get("skipped"):
            session.exitstatus = pytest.ExitCode.TESTS_FAILED


@cache
def alembic_heads() -> frozenset[str]:
    """Read the migration heads once per process; the scripts do not change during a run."""
    migrations = Path(__file__).parents[1] / "migrations"
    config = Config()
    config.set_main_option("script_location", str(migrations))
    return frozenset(ScriptDirectory.from_config(config).get_heads())


def _assert_alembic_head(connection) -> None:
    heads = alembic_heads()
    applied = set(
        connection.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
    )
    if applied != heads:
        raise RuntimeError(f"Integration database is not at Alembic head: {applied!r}")


@pytest.fixture
def integration_db(request) -> Generator[Session, None, None]:
    database_url = os.getenv("TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    _guard_for_test(request, database_url)
    yield from _integration_session(database_url)


@pytest.fixture
def integration_owner_db(request) -> Generator[Session, None, None]:
    """Owner-only fixture setup for the explicitly created disposable full-stack DB."""
    if os.getenv("TEST_DATABASE_URL") is None:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    database_url = os.getenv("MIGRATION_DATABASE_URL", "")
    # Ownership is validated (once per test) before the session opens its connection.
    _guard_for_test(request, database_url)
    yield from _integration_session(database_url)


def _integration_session(database_url: str) -> Generator[Session, None, None]:
    """Open a rolled-back session; callers guard *database_url* first."""

    connection = pooled_engine(database_url).connect()
    _assert_alembic_head(connection)
    connection.rollback()
    transaction = connection.begin()
    session = AuditSession(bind=connection, join_transaction_mode="create_savepoint")
    session.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/test",
    )
    try:
        yield session
    finally:
        session.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()


@pytest.fixture(scope="session")
def shared_provider_account():
    """One real provider user and six real sessions per process, for ``policy_world``."""
    from tests.auth.session_policy_support import shared_provider_sessions

    yield from shared_provider_sessions()
