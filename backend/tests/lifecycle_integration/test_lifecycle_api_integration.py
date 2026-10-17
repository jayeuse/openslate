import os
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from secrets import token_urlsafe
from threading import Event
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import ADMINISTRATOR_CHANGE_LOCK, get_current_user
from app.core.database import get_db
from app.core.database.organization_scope import apply_connection_scope
from app.core.database.session import AuditSession
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_sessions import admit_provider_session
from app.systems.access.identity.rate_limits import login_fingerprint, rate_limit_fingerprint
from app.systems.access.users.models import Membership, PlatformOperator, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecyclePasswordServiceUnavailable
from app.systems.sandbox.modules.models import Module
from tests.api_integration_support import create_owned_admin, delete_owned_admin
from tests.conftest import _assert_alembic_head, _guard_integration_database
from tests.conftest import guarded_create_engine as create_engine
from tests.fake_provider_support import FakeProvider, install_fake_provider, real_session_pool
from tests.lifecycle_integration.lifecycle_integration_support import (
    delete_committed_scope,
    password_boundary,
)
from tests.organization_scope_support import scoped_override
from tests.sandbox_designs.fixtures import create_document

CONFIRMATION_PASSWORD = token_urlsafe(32)

pytestmark = pytest.mark.integration


class LifecycleApiClient:
    def __init__(self, database_url: str, actor) -> None:
        self.engine = create_engine(database_url)
        self.app = create_app()
        self.client = TestClient(self.app)
        self.actor = actor
        with Session(self.engine) as database:
            self.org_id = database.scalars(
                select(Membership.org_id).where(Membership.user_id == actor.id)
            ).one()
        self.active_database: AuditSession | None = None
        self.request_count = 0
        self.request_ids: set[UUID] = set()
        self.created_department_ids: set[UUID] = set()
        self.created_module_ids: set[UUID] = set()

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None):
        database = AuditSession(bind=self.engine)
        self.request_count += 1
        request_id = uuid7()
        self.request_ids.add(request_id)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=self.actor.id,
            request_id=request_id,
            request_method=method,
            request_path=path,
        )
        self.active_database = database
        self.app.dependency_overrides[get_current_user] = scoped_override(lambda: self.actor)
        self.app.dependency_overrides[get_db] = lambda: database
        try:
            return self.client.request(method, path, json=payload)
        finally:
            self.active_database = None
            database.close()

    def create_module(self, department_name: str) -> str:
        """Commit a department and module directly; the Sandbox publish owns schema writes."""

        request_id = uuid7()
        self.request_ids.add(request_id)
        database = AuditSession(bind=self.engine)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=self.actor.id,
            request_id=request_id,
            request_method="POST",
            request_path="/api/test/lifecycle-module",
        )
        try:
            department = Department(org_id=self.org_id, department_name=department_name)
            module = Module(org_id=department.org_id, department=department, module_name="Assets")
            database.add_all([department, module])
            database.flush()
            self.created_department_ids.add(department.id)
            self.created_module_ids.add(module.id)
            module_id = str(module.id)
            database.commit()
            return module_id
        finally:
            database.close()

    def close(self) -> None:
        self.client.close()
        self.engine.dispose()


def _cleanup(client: LifecycleApiClient) -> None:
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if owner_url is None:
        raise RuntimeError("MIGRATION_DATABASE_URL is required for lifecycle API cleanup")
    _guard_integration_database(owner_url)
    engine = create_engine(owner_url)
    try:
        with engine.begin() as connection:
            delete_committed_scope(
                connection,
                actor_id=client.actor.id,
                audit_entity_ids=client.created_department_ids | client.created_module_ids,
                audit_request_ids=client.request_ids,
                module_ids=client.created_module_ids,
                department_ids=client.created_department_ids,
            )
            connection.execute(
                text("DELETE FROM public.sandbox_documents WHERE org_id = :id"),
                {"id": client.org_id},
            )
    finally:
        engine.dispose()
        delete_owned_admin(owner_url, client.actor.id)


@pytest.fixture
def lifecycle_api_client() -> Callable[[], LifecycleApiClient]:
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_DATABASE_URL to run PostgreSQL integration tests")
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if not owner_url:
        pytest.skip("MIGRATION_DATABASE_URL is required for lifecycle API cleanup")
    _guard_integration_database(database_url)
    _guard_integration_database(owner_url)
    readiness_engine = create_engine(database_url)
    try:
        with readiness_engine.connect() as connection:
            _assert_alembic_head(connection)
            assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
    finally:
        readiness_engine.dispose()
    actor = create_owned_admin(database_url, owner_url, "lifecycle-api")
    try:
        client = LifecycleApiClient(database_url, actor)
        owner_engine = create_engine(owner_url)
        try:
            with Session(owner_engine) as database:
                create_document(database, database.get(WorkspaceProfile, client.org_id))
                database.commit()
        finally:
            owner_engine.dispose()
    except BaseException:
        delete_owned_admin(owner_url, actor.id)
        raise
    try:
        yield lambda: client
    finally:
        try:
            _cleanup(client)
        finally:
            client.close()


def test_registered_close_password_callback_starts_without_request_transaction(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    module_id = client.create_module("API lifecycle")
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    assert preview.status_code == 200
    token = preview.json()["token"]
    observations: list[bool] = []

    def verify() -> UUID:
        assert client.active_database is not None
        observations.append(client.active_database.in_transaction())
        return client.actor.id

    with password_boundary(verify):
        closed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": CONFIRMATION_PASSWORD},
        )

    assert closed.status_code == 200
    assert observations == [False]


def test_registered_close_rejects_invalid_confirmation_without_provider_call(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    module_id = client.create_module("API invalid")
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    calls: list[str] = []

    def verify() -> UUID:
        calls.append("called")
        return client.actor.id

    with password_boundary(verify):
        response = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {
                "token": preview.json()["token"],
                "confirmation_name": "Wrong",
                "password": CONFIRMATION_PASSWORD,
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "confirmation_name_mismatch"
    assert calls == []


def test_registered_close_maps_provider_failure_and_consumed_token_replay(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    module_id = client.create_module("API provider")
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    token = preview.json()["token"]

    observations: list[bool] = []

    def verify() -> UUID:
        assert client.active_database is not None
        observations.append(client.active_database.in_transaction())
        raise LifecyclePasswordServiceUnavailable("provider unavailable")

    with password_boundary(verify):
        failed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": CONFIRMATION_PASSWORD},
        )

    assert failed.status_code == 503
    assert failed.json()["detail"]["code"] == "password_upstream_unavailable"
    assert observations == [False]

    def verify() -> UUID:
        return client.actor.id

    with password_boundary(verify):
        closed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": CONFIRMATION_PASSWORD},
        )
    assert closed.status_code == 200

    with client.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE public.modules SET is_deleted = false, deleted_at = NULL, "
                "lifecycle_close_operation_id = NULL WHERE id = :id"
            ),
            {"id": module_id},
        )
    replay = client.request(
        "POST",
        f"/api/modules/{module_id}/close",
        {"token": token, "confirmation_name": "Assets", "password": CONFIRMATION_PASSWORD},
    )
    assert replay.status_code == 404
    assert replay.json()["detail"]["code"] == "challenge_not_found"


def test_registered_close_rejects_plan_drift_after_provider_success(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    module_id = client.create_module("API drift")
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    token = preview.json()["token"]

    def verify() -> UUID:
        with client.engine.begin() as connection:
            # The drift is another writer in the same organization.
            apply_connection_scope(connection, client.org_id)
            connection.execute(
                text("UPDATE public.modules SET module_name = :name WHERE id = :id"),
                {"name": "Assets changed", "id": module_id},
            )
        return client.actor.id

    with password_boundary(verify):
        response = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": CONFIRMATION_PASSWORD},
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "impact_changed"
    with client.engine.connect() as connection:
        state = connection.execute(
            text("SELECT is_deleted, module_name FROM public.modules WHERE id = :id"),
            {"id": module_id},
        ).one()
    assert tuple(state) == (False, "Assets changed")


def test_registered_module_purge_succeeds_when_enabled(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    module_id = client.create_module("API purge")
    close_preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    observations: list[bool] = []

    def verify() -> UUID:
        assert client.active_database is not None
        observations.append(client.active_database.in_transaction())
        return client.actor.id

    with password_boundary(verify, purge_enabled=True):
        closed = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {
                "token": close_preview.json()["token"],
                "confirmation_name": "Assets",
                "password": CONFIRMATION_PASSWORD,
            },
        )
        purge_preview = client.request("POST", f"/api/modules/{module_id}/purge/preview")
        purged = client.request(
            "POST",
            f"/api/modules/{module_id}/purge",
            {
                "token": purge_preview.json()["token"],
                "confirmation_name": "Assets",
                "password": CONFIRMATION_PASSWORD,
            },
        )

    assert closed.status_code == 200
    assert purge_preview.status_code == 200
    assert purged.status_code == 200
    assert observations == [False, False]
    with client.engine.connect() as connection:
        assert (
            connection.scalar(
                text("SELECT id FROM public.modules WHERE id = :id"), {"id": module_id}
            )
            is None
        )


def test_registered_purge_refuses_when_disabled_before_provider(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
) -> None:
    client = lifecycle_api_client()
    module_id = client.create_module("API purge off")
    calls: list[str] = []

    def verify() -> UUID:
        calls.append("called")
        return client.actor.id

    with password_boundary(verify, purge_enabled=False):
        response = client.request("POST", f"/api/modules/{module_id}/purge/preview")

    assert response.status_code == 403, response.text
    assert response.json()["detail"]["code"] == "purge_disabled"
    assert calls == []


@pytest.fixture
def authenticated_administrators(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
    monkeypatch: pytest.MonkeyPatch,
    request: pytest.FixtureRequest,
) -> Iterator[tuple[LifecycleApiClient, FakeProvider, dict[str, str]]]:
    client = lifecycle_api_client()
    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    administrator = create_owned_admin(
        os.environ["TEST_DATABASE_URL"], owner_url, "lifecycle-admin", org_id=client.org_id,
    )
    owner = create_engine(owner_url)
    fake = install_fake_provider(monkeypatch, real_session_pool(request.config))
    actors = (client.actor, administrator)
    try:
        with Session(owner) as db:
            organization = db.get(WorkspaceProfile, client.org_id)
            organization.owner_user_id = administrator.id
            for actor in actors:
                user = db.get(User, actor.id)
                user.supabase_user_id = fake.add(actor.email, CONFIRMATION_PASSWORD)
            assert db.get(PlatformOperator, client.actor.id) is None
            db.commit()

        tokens = []
        provider = get_supabase_auth_client()
        for actor in actors:
            grant = provider.password_grant(actor.email, CONFIRMATION_PASSWORD)
            with AuditSession(client.engine) as db:
                request_id = uuid7()
                client.request_ids.add(request_id)
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=request_id)
                issued = admit_provider_session(db, grant, provider)
                db.commit()
                tokens.append(issued.access_token)

        def database(http_request: Request) -> Iterator[Session]:
            with AuditSession(client.engine) as db:
                request_id = uuid7()
                client.request_ids.add(request_id)
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=request_id,
                    request_method=http_request.method,
                    request_path=http_request.url.path,
                )
                if http_request.url.path.endswith("/close"):
                    client.active_database = db
                try:
                    yield db
                finally:
                    if client.active_database is db:
                        client.active_database = None

        client.app.dependency_overrides[get_db] = database
        assert get_current_user not in client.app.dependency_overrides
        client.client.headers["Authorization"] = f"Bearer {tokens[0]}"
        yield client, fake, {"Authorization": f"Bearer {tokens[1]}"}
    finally:
        client.app.dependency_overrides.clear()
        with owner.begin() as connection:
            values = {"actor": client.actor.id, "admin": administrator.id, "org": client.org_id}
            for table, predicate in (
                ("identity_sessions", "user_id IN (:actor, :admin)"),
                ("in_app_notifications", "org_id = :org"),
                ("audit_logs", "org_id = :org OR entity_id IN (:actor, :admin)"),
                ("security_events", "org_id = :org OR actor_id IN (:actor, :admin)"),
            ):
                connection.execute(text(f"DELETE FROM public.{table} WHERE {predicate}"), values)
            connection.execute(
                text("UPDATE public.organizations SET owner_user_id = NULL WHERE id = :org"),
                values,
            )
            for actor in actors:
                for fingerprint in (
                    login_fingerprint(actor.email, None),
                    rate_limit_fingerprint("login-account", actor.email, None),
                ):
                    connection.execute(
                        text(
                            "DELETE FROM public.identity_rate_limit_buckets WHERE fingerprint = :f"
                        ),
                        {"f": fingerprint},
                    )
        owner.dispose()
        delete_owned_admin(owner_url, administrator.id)


def _close_state(client: LifecycleApiClient, module_id: str) -> tuple:
    with client.engine.connect() as connection:
        apply_connection_scope(connection, client.org_id)
        return (
            connection.scalar(
                text("SELECT to_jsonb(m) FROM public.modules m WHERE id = :id"), {"id": module_id},
            ),
            connection.scalar(
                text("SELECT to_jsonb(d) FROM public.sandbox_documents d WHERE org_id = :id"),
                {"id": client.org_id},
            ),
        )


def test_registered_close_requires_current_administrator_after_password(
    authenticated_administrators: tuple[LifecycleApiClient, FakeProvider, dict[str, str]],
) -> None:
    client, fake, administrator_headers = authenticated_administrators
    module_id = client.create_module("Current administrator")
    path = f"/api/modules/{module_id}/close"
    preview = client.client.post(f"{path}/preview")
    assert preview.status_code == 200
    before = _close_state(client, module_id)
    provider_pending, resume_provider = Event(), Event()
    limiter_transactions: list[bool] = []

    def provider_io(http_request: httpx.Request) -> None:
        if http_request.url.path == "/auth/v1/token":
            db = client.active_database
            assert db is not None and db.in_transaction()
            limiter_transactions.append(db.connection().scalar(text(
                "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() "
                "AND locktype = 'advisory' AND objsubid = 1 AND granted)"
            )))
            provider_pending.set()
            assert resume_provider.wait(timeout=10), "Password grant was not released"

    fake.hook = provider_io
    with ThreadPoolExecutor(max_workers=1) as executor:
        close = executor.submit(client.client.post, path, json={
            "token": preview.json()["token"], "confirmation_name": "Assets",
            "password": CONFIRMATION_PASSWORD,
        })
        try:
            if not provider_pending.wait(timeout=10):
                early_response = close.result(timeout=10)
                pytest.fail(
                    f"Password grant was not reached: HTTP {early_response.status_code}"
                )
            demoted = client.client.patch(
                f"/api/users/{client.actor.id}", json={"role": "member"},
                headers=administrator_headers,
            )
            assert demoted.status_code == 200
            with Session(client.engine) as db:
                membership = db.scalars(select(Membership).where(
                    Membership.org_id == client.org_id, Membership.user_id == client.actor.id,
                )).one()
                assert (membership.role, membership.status) == ("member", "active")
                assert db.scalars(select(IdentitySession).where(
                    IdentitySession.user_id == client.actor.id,
                    IdentitySession.revoked_at.is_(None),
                )).one()
        finally:
            resume_provider.set()
        response = close.result(timeout=10)

    assert limiter_transactions == [True]
    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden"
    assert _close_state(client, module_id) == before
    with Session(client.engine) as db:
        assert db.scalars(select(AuditLog.id).where(AuditLog.request_path == path)).all() == []


def test_registered_close_holds_administrator_authority_through_commit(
    authenticated_administrators: tuple[LifecycleApiClient, FakeProvider, dict[str, str]],
) -> None:
    client, _fake, _administrator_headers = authenticated_administrators
    module_id = client.create_module("Administrator commit")
    path = f"/api/modules/{module_id}/close"
    preview = client.client.post(f"{path}/preview")
    assert preview.status_code == 200
    lock_available_at_commit: list[bool] = []

    def administrator_lock_available() -> bool:
        with client.engine.begin() as connection:
            return connection.scalar(text(
                "SELECT pg_try_advisory_xact_lock(:key, hashtext(:org))"
            ), {"key": ADMINISTRATOR_CHANGE_LOCK, "org": str(client.org_id)})

    def before_commit(db: Session) -> None:
        context = db.info.get(AUDIT_CONTEXT_KEY)
        if context is not None and context.request_path == path and any(
            isinstance(row, Module) and str(row.id) == module_id and row.is_deleted
            for row in db.dirty
        ):
            lock_available_at_commit.append(administrator_lock_available())

    event.listen(AuditSession, "before_commit", before_commit)
    try:
        response = client.client.post(path, json={
            "token": preview.json()["token"], "confirmation_name": "Assets",
            "password": CONFIRMATION_PASSWORD,
        })
    finally:
        event.remove(AuditSession, "before_commit", before_commit)

    assert response.status_code == 200
    assert lock_available_at_commit == [False]
    assert administrator_lock_available() is True
    with Session(client.engine) as db:
        module = db.get(Module, UUID(module_id))
        assert module.is_deleted is True
        assert module.deleted_at is not None
        audit = db.scalars(select(AuditLog).where(
            AuditLog.entity_id == module.id, AuditLog.request_path == path,
        )).one()
        assert audit.performed_by == client.actor.id
