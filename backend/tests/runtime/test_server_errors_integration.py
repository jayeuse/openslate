"""S6-C1: each server error is stored with its reference, status, method, route template and
bound organization only, and nothing is stored for other answers (PostgreSQL)."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.exc import OperationalError
from uuid6 import uuid7

import app.common.dependencies.auth as dependencies
import app.main as main
from app.common.dependencies.auth import (
    CurrentIdentity,
    get_account_user,
    get_current_membership,
)
from app.core.integrations.supabase_auth import ProviderUser, SupabaseAuthUnavailable
from app.main import create_app
from app.systems.access.users.models import Membership, User
from app.systems.manage.health import errors
from tests.runtime.health_support import (
    committed_organization,
    owner_engine,
    remove_organizations,
    remove_server_errors,
    server_error_rows,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def member_world(monkeypatch, real_server_error_writes):
    """A committed organization A, a member of A, and an organization B they do not join."""

    first, second = committed_organization("errors-a"), committed_organization("errors-b")
    user_id, provider_id, membership_id = uuid7(), uuid7(), uuid7()
    with owner_engine().begin() as connection:
        connection.execute(User.__table__.insert().values(
            id=user_id, email=f"errors-{user_id}@example.test", username=f"errors-{user_id}",
            status="active", supabase_user_id=provider_id,
        ))
        connection.execute(Membership.__table__.insert().values(
            id=membership_id, org_id=first, user_id=user_id, role="member", status="active",
        ))
    person = User(id=user_id, email=f"errors-{user_id}@example.test",
                  username=f"errors-{user_id}", status="active", supabase_user_id=provider_id)
    monkeypatch.setattr(
        dependencies, "recent_provider_user",
        lambda subject: ProviderUser(subject, None, person.email),
    )
    # The session itself is not under test: every identity read answers with this member,
    # while membership resolution, its address and MFA checks run for real.
    monkeypatch.setattr(
        dependencies, "_resolve_identity",
        lambda request, bearer, db, *, allow_aal1: CurrentIdentity(person, uuid7(), False, False),
    )
    monkeypatch.setattr(errors, "_log", errors.ServerErrorLog())
    stored: list = []
    try:
        yield first, second, person, stored
    finally:
        remove_server_errors(*stored)
        remove_organizations(first, second)
        with owner_engine().begin() as connection:
            connection.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": user_id})


def _client(person: User) -> TestClient:
    application = create_app()

    @application.get("/api/test-health/members/{item_id}")
    def member_failure(
        item_id: str, membership: Annotated[Membership, Depends(get_current_membership)]
    ) -> None:
        raise RuntimeError("member route failed")

    @application.get("/api/test-health/account/{item_id}")
    def account_failure(item_id: str, user: Annotated[User, Depends(get_account_user)]) -> None:
        raise RuntimeError("account route failed")

    @application.get("/api/test-health/database")
    def database_failure() -> None:
        raise OperationalError("SELECT 1", {}, ConnectionRefusedError())

    @application.get("/api/test-health/missing")
    def missing() -> None:
        raise HTTPException(404, detail="Not found")

    @application.get("/api/test-health/fine")
    def fine() -> dict[str, bool]:
        return {"ok": True}

    return TestClient(application)


def test_s6_c1_i14_a_server_error_keeps_only_its_reference_route_and_organization(
    member_world, monkeypatch
):
    first, second, person, stored = member_world
    client = _client(person)
    monkeypatch.setattr(main, "get_readiness_snapshot", lambda: {
        "status": "not_ready", "components": {"auth": {"status": "unavailable", "required": True}},
    })
    before = datetime.now(UTC)

    bound = client.get("/api/test-health/members/7", headers={"X-Org": str(first)})
    unbound = client.get("/api/test-health/account/7", headers={"X-Org": str(first)})
    refused = client.get("/api/test-health/members/7", headers={"X-Org": str(second)})
    quiet = [
        client.get("/api/test-health/database"),
        client.get("/api/test-health/missing"),
        client.get("/api/test-health/fine"),
        client.get("/api/ready"),
    ]
    answers = [bound, unbound, refused, *quiet]
    stored += [UUID(response.headers["X-Request-ID"]) for response in answers]

    assert [response.status_code for response in answers] == [500, 500, 403, 503, 404, 200, 503]
    assert server_error_rows(*stored) == [
        (stored[0], 500, "GET", "/api/test-health/members/{item_id}", first),
        # A header alone never names the organization; only a passed membership check does.
        (stored[1], 500, "GET", "/api/test-health/account/{item_id}", None),
    ]
    with owner_engine().connect() as connection:
        times = connection.scalars(
            text("SELECT occurred_at FROM public.server_errors WHERE request_id = ANY(:ids)"),
            {"ids": stored},
        ).all()
        columns = {column["name"] for column in inspect(connection).get_columns("server_errors")}
    assert all(before <= moment <= datetime.now(UTC) for moment in times)
    # No body, header, query, person or record value has anywhere to go.
    assert columns == {"request_id", "occurred_at", "status", "method", "route", "org_id"}


_OUTAGE = OperationalError("SELECT 1", {}, ConnectionRefusedError())
# The real identity read, before ``member_world`` replaces it.
_REAL_IDENTITY = dependencies._resolve_identity


class _TokenClient:
    """Auth accepts the token, so the next step is the first database read."""

    def verify_access_token(self, token):
        return object()


@pytest.mark.parametrize(
    ("stage", "failure", "detail", "stored_rows"),
    [
        # The samples record a database outage, and a write now would wait for it too.
        ("identity", _OUTAGE, "Authentication service unavailable", 0),
        ("membership", _OUTAGE, "Organization context unavailable", 0),
        # Auth down with the database up: the server error is stored as usual.
        (
            "membership",
            SupabaseAuthUnavailable("Supabase Auth is unavailable", kind="connect"),
            "Organization context unavailable",
            1,
        ),
    ],
)
def test_s6_c1_i14_a_dependency_503_for_a_database_outage_attempts_no_write(
    member_world, monkeypatch, stage, failure, detail, stored_rows
):
    first, second, person, stored = member_world
    real_write = errors._write
    attempts: list[tuple] = []

    def write(*values):
        attempts.append(values)
        real_write(*values)

    def unavailable(*args, **kwargs):
        raise failure

    monkeypatch.setattr(errors, "_write", write)
    if stage == "identity":
        monkeypatch.setattr(dependencies, "_resolve_identity", _REAL_IDENTITY)
        monkeypatch.setattr(dependencies, "get_supabase_auth_client", _TokenClient)
        monkeypatch.setattr(dependencies, "load_platform_policy", unavailable)
    else:
        monkeypatch.setattr(dependencies, "resolve_membership", unavailable)

    response = _client(person).get(
        "/api/test-health/members/7",
        headers={"X-Org": str(first), "Authorization": "Bearer token"},
    )
    stored.append(UUID(response.headers["X-Request-ID"]))

    assert response.status_code == 503
    assert response.json()["detail"] == detail
    assert len(attempts) == stored_rows
    assert len(server_error_rows(*stored)) == stored_rows
