"""A private Realtime channel through the runner-owned gateway (S12, candidate A).

A signed-in member gets a channel token from ``POST /api/realtime/token`` and joins,
sends to and hears from ``org:<id>:probe`` over the gateway WebSocket. Another
organization's member, another organization's topic and an expired token are refused,
and the channel token opens neither Storage nor Supabase Auth.
"""

from __future__ import annotations

import json
import os
import ssl
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from websockets.sync.client import ClientConnection, connect

from app.core.config import Settings, get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.systems.access.users.models import UserStatus
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.realtime.tokens import mint_realtime_token
from tests.conftest import create_member, create_organization, guarded_create_engine
from tests.route_app_support import route_app

pytestmark = pytest.mark.integration

_REPLY_SECONDS = 10.0


@dataclass(frozen=True, slots=True)
class Person:
    email: str
    password: str
    user_id: UUID


@dataclass(frozen=True, slots=True)
class Organizations:
    member: Person
    outsider: Person
    org_a: UUID
    org_b: UUID


@pytest.fixture
def organizations() -> Iterator[Organizations]:
    settings = get_settings()
    assert_provider_instance(
        dict(os.environ), database_url=settings.database_url, expected_user="openslate_runtime"
    )
    owner_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    admin = httpx.Client(
        base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
        timeout=15,
        trust_env=False,
    )
    provider_ids: list[UUID] = []
    user_ids: list[UUID] = []
    org_ids: list[UUID] = []
    try:
        people = []
        with Session(owner_engine) as db:
            for _ in range(2):
                organization = create_organization(db)
                org_ids.append(organization.id)
            for org_id in org_ids:
                email = f"realtime-{uuid4().hex}@example.test"
                password = token_urlsafe(32)
                created = admin.post(
                    "admin/users",
                    json={"email": email, "password": password, "email_confirm": True},
                )
                if created.status_code not in {200, 201}:
                    raise AssertionError("runner Supabase Auth did not create the synthetic user")
                provider_ids.append(UUID(created.json()["id"]))
                organization = db.get(WorkspaceProfile, org_id)
                user, _membership = create_member(
                    db,
                    organization,
                    "member",
                    email=email,
                    username=f"realtime-{uuid4().hex}",
                    status=UserStatus.ACTIVE.value,
                    supabase_user_id=provider_ids[-1],
                )
                user_ids.append(user.id)
                people.append(Person(email, password, user.id))
            db.commit()
        yield Organizations(people[0], people[1], org_ids[0], org_ids[1])
    finally:
        try:
            for provider_id in provider_ids:
                deleted = admin.delete(f"admin/users/{provider_id}")
                if deleted.status_code not in {200, 204, 404}:
                    raise AssertionError("runner Supabase Auth did not remove the synthetic user")
        finally:
            admin.close()
            _remove_people(owner_engine, user_ids, org_ids)
            owner_engine.dispose()


def _remove_people(engine: Engine, user_ids: list[UUID], org_ids: list[UUID]) -> None:
    with engine.begin() as connection:
        parameters = {"users": user_ids, "orgs": org_ids}
        for statement in (
            "DELETE FROM public.identity_sessions WHERE user_id = ANY(:users)",
            "DELETE FROM public.memberships WHERE user_id = ANY(:users)",
            "DELETE FROM public.audit_logs WHERE org_id = ANY(:orgs)",
            "DELETE FROM public.users WHERE id = ANY(:users)",
            "DELETE FROM public.organizations WHERE id = ANY(:orgs)",
        ):
            connection.execute(text(statement), parameters)


def _sign_in(client: TestClient, person: Person) -> dict[str, str]:
    response = client.post(
        "/api/auth/token", json={"email": person.email, "password": person.password}
    )
    if response.status_code != 200:
        raise AssertionError("synthetic user could not authenticate through the API")
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _channel_token(client: TestClient, bearer: dict[str, str], org_id: UUID) -> httpx.Response:
    return client.post("/api/realtime/token", headers={**bearer, "X-Org": str(org_id)})


def _socket(settings: Settings) -> ClientConnection:
    gateway = os.environ.get("OPENSLATE_TEST_REALTIME_GATEWAY")
    if gateway:
        assert gateway == settings.public_origin == "https://localhost:3448"
        # Run-owned Caddy's ephemeral internal CA, matching other local gateway proofs.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
        return connect(
            "wss://localhost:3448/realtime/v1/websocket?vsn=1.0.0",
            origin=gateway,
            ssl=context,
            open_timeout=10,
        )
    url = "ws" + settings.supabase_url.rstrip("/").removeprefix("http")
    return connect(
        url + "/realtime/v1/websocket?vsn=1.0.0",
        additional_headers={"apikey": settings.supabase_publishable_key.get_secret_value()},
        open_timeout=10,
    )


def _read_until(ws: ClientConnection, wanted: Any) -> dict[str, Any] | None:
    deadline = time.monotonic() + _REPLY_SECONDS
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            message = json.loads(ws.recv(timeout=remaining))
        except TimeoutError:
            return None
        if wanted(message):
            return message
    return None


def _join(ws: ClientConnection, topic: str, token: str) -> dict[str, Any]:
    ws.send(
        json.dumps(
            {
                "topic": f"realtime:{topic}",
                "event": "phx_join",
                "ref": "1",
                "join_ref": "1",
                "payload": {
                    "config": {
                        "broadcast": {"self": True, "ack": True},
                        "presence": {"key": ""},
                        "private": True,
                    },
                    "access_token": token,
                },
            }
        )
    )
    reply = _read_until(ws, lambda m: m.get("event") == "phx_reply" and m.get("ref") == "1")
    if reply is None:
        raise AssertionError("Realtime did not answer the join")
    return reply["payload"]


def _assert_refused(settings: Settings, topic: str, token: str, reason: str) -> None:
    with _socket(settings) as ws:
        reply = _join(ws, topic, token)
    assert reply["status"] == "error"
    assert reason in str(reply["response"])


def test_member_uses_a_private_channel_and_everyone_else_is_refused(
    organizations: Organizations,
) -> None:
    settings = get_settings()
    with TestClient(route_app()) as client:
        member = _sign_in(client, organizations.member)
        outsider = _sign_in(client, organizations.outsider)
        issued = _channel_token(client, member, organizations.org_a)
        assert issued.status_code == 200
        assert _channel_token(client, member, organizations.org_b).status_code == 403
        assert _channel_token(client, outsider, organizations.org_a).status_code == 403
        outsider_issued = _channel_token(client, outsider, organizations.org_b)
        assert outsider_issued.status_code == 200
        token = issued.json()["access_token"]
        # The channel token is not a session: Auth publishes only its own keys.
        as_session = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/auth/me", headers=as_session).status_code == 401
        assert _channel_token(client, as_session, organizations.org_a).status_code == 401
    assert issued.json()["topic_prefix"] == f"org:{organizations.org_a}:"
    topic = f"org:{organizations.org_a}:probe"

    with _socket(settings) as ws:
        assert _join(ws, topic, token)["status"] == "ok"
        marker = uuid4().hex
        ws.send(
            json.dumps(
                {
                    "topic": f"realtime:{topic}",
                    "event": "broadcast",
                    "ref": "2",
                    "join_ref": "1",
                    "payload": {
                        "type": "broadcast",
                        "event": "probe",
                        "payload": {"marker": marker},
                    },
                }
            )
        )
        heard = _read_until(
            ws,
            lambda m: (
                m.get("event") == "broadcast"
                and m.get("payload", {}).get("payload", {}).get("marker") == marker
            ),
        )
        assert heard is not None, "the member did not receive its own private broadcast"

    unauthorized = "You do not have permissions to read from this Channel topic"
    _assert_refused(settings, topic, outsider_issued.json()["access_token"], unauthorized)
    _assert_refused(settings, f"org:{organizations.org_b}:probe", token, unauthorized)
    expired = mint_realtime_token(
        settings,
        user_id=organizations.member.user_id,
        org_id=organizations.org_a,
        now=datetime.now(UTC) - timedelta(minutes=10),
    )
    _assert_refused(settings, topic, expired.token, "Token has expired")


def test_channel_token_opens_neither_storage_nor_auth(organizations: Organizations) -> None:
    settings = get_settings()
    token = mint_realtime_token(
        settings, user_id=organizations.member.user_id, org_id=organizations.org_a
    ).token
    headers = {
        "apikey": settings.supabase_publishable_key.get_secret_value(),
        "Authorization": f"Bearer {token}",
    }
    service = {"apikey": settings.supabase_secret_key.get_secret_value()}
    key = f"realtime-probe-{uuid4().hex}"
    with httpx.Client(
        base_url=settings.supabase_url.rstrip("/"), timeout=10, trust_env=False
    ) as gateway:
        stored = gateway.post(
            f"/storage/v1/object/openslate-ready/{key}",
            headers=service,
            content=b"private bytes",
        )
        assert stored.status_code == 200, "the service key could not store the probe object"
        try:
            buckets = gateway.get("/storage/v1/bucket", headers=headers)
            listed = gateway.post(
                "/storage/v1/object/list/openslate-ready",
                headers=headers,
                json={"prefix": "", "limit": 100},
            )
            fetched = gateway.get(f"/storage/v1/object/openslate-ready/{key}", headers=headers)
            authenticated = gateway.get(
                f"/storage/v1/object/authenticated/openslate-ready/{key}", headers=headers
            )
            user = gateway.get("/auth/v1/user", headers=headers)
        finally:
            gateway.request(
                "DELETE",
                "/storage/v1/object/openslate-ready",
                headers=service,
                json={"prefixes": [key]},
            )

    assert (buckets.status_code, buckets.json()) == (200, [])
    assert (listed.status_code, listed.json()) == (200, [])
    for response in (fetched, authenticated):
        assert response.status_code != 200
        assert b"private bytes" not in response.content
    assert user.status_code in {401, 403}
