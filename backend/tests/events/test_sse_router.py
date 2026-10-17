"""SSE transport contracts for opaque invalidation delivery."""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from uuid6 import uuid7

from app.core.database import get_db
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.events import router as events_router
from app.systems.platform.events.hub import EventHub, EventViewer
from app.systems.platform.events.models import InvalidationEvent
from app.systems.platform.events.router import (
    BoundedSSEStreamingResponse,
    EventPrincipal,
    event_stream,
    get_event_principal,
    router,
)

READABLE_MODULE = uuid7()
ORGANIZATION = uuid7()


def test_event_stream_starts_with_resync_then_uses_comment_heartbeats() -> None:
    async def exercise() -> None:
        hub = EventHub()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        user = EventViewer(user_id=uuid7(), role="member", module_ids=frozenset())
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=0,
            reauthorize=_sequence_authorizer(user, user),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        assert await anext(stream) == b": heartbeat\n\n"
        await stream.aclose()

    asyncio.run(exercise())


def test_event_stream_serializes_only_opaque_invalidation_metadata() -> None:
    async def exercise() -> None:
        hub = EventHub()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        user = EventViewer(
            user_id=uuid7(), role="member", module_ids=frozenset({READABLE_MODULE}),
            org_id=ORGANIZATION,
        )
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=1,
            reauthorize=_sequence_authorizer(user, user),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(InvalidationEvent(
            "records", module_id=READABLE_MODULE, org_id=ORGANIZATION,
        ))
        assert await anext(stream) == (
            b'event: invalidate\ndata: {"entity":"records","module_id":"'
            + str(READABLE_MODULE).encode()
            + b'"}\n\n'
        )
        await stream.aclose()

    asyncio.run(exercise())


def test_event_stream_emits_private_notification_without_a_recipient_identifier() -> None:
    async def exercise() -> None:
        from uuid6 import uuid7

        from app.systems.platform.events.models import event_for_entity

        hub = EventHub()
        recipient_id = uuid7()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        user = EventViewer(user_id=recipient_id, role="member", module_ids=frozenset())
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=1,
            reauthorize=_sequence_authorizer(user, user),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        event = event_for_entity("in_app_notifications", uuid7(), recipient_id=recipient_id)
        assert event is not None
        await hub.publish_notification(event.to_transport_json())
        assert await anext(stream) == (
            b'event: invalidate\ndata: {"entity":"in_app_notifications"}\n\n'
        )
        await stream.aclose()

    asyncio.run(exercise())


def test_event_stream_terminates_when_periodic_identity_check_is_revoked() -> None:
    async def exercise() -> None:
        hub = EventHub()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        user = EventViewer(user_id=uuid7(), role="member", module_ids=frozenset())
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=0,
            reauthorize=_sequence_authorizer(user, None),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        await stream.aclose()

    asyncio.run(exercise())


def test_event_stream_rechecks_changed_permissions_before_delivery() -> None:
    async def exercise() -> None:
        hub = EventHub()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        allowed = EventViewer(
            user_id=uuid7(), role="member", module_ids=frozenset({READABLE_MODULE}),
            org_id=ORGANIZATION,
        )
        denied = EventViewer(
            user_id=uuid7(), role="member", module_ids=frozenset(), org_id=ORGANIZATION,
        )
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=1,
            reauthorize=_sequence_authorizer(allowed, denied),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(InvalidationEvent(
            "records", module_id=READABLE_MODULE, org_id=ORGANIZATION,
        ))
        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await stream.aclose()

    asyncio.run(exercise())


def test_board_access_revoke_and_grant_resync_before_delivering_queued_events() -> None:
    async def exercise() -> None:
        hub = EventHub()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        board_id, user_id = uuid7(), uuid7()
        allowed = EventViewer(
            user_id, "member", frozenset(), board_ids=frozenset({board_id}), org_id=ORGANIZATION,
        )
        denied = EventViewer(
            user_id, "member", frozenset(), board_ids=frozenset(), org_id=ORGANIZATION,
        )
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=0.1,
            reauthorize=_sequence_authorizer(allowed, denied, denied, allowed, allowed),
        )
        event = InvalidationEvent("board_posts", board_id=board_id, org_id=ORGANIZATION)

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(event)
        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(event)
        assert await anext(stream) == b": heartbeat\n\n"
        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(event)
        assert await anext(stream) == (
            b'event: invalidate\ndata: {"board_id":"'
            + str(board_id).encode()
            + b'","entity":"board_posts"}\n\n'
        )
        await stream.aclose()

    asyncio.run(exercise())


def test_events_endpoint_requires_authenticated_user() -> None:
    application = FastAPI()
    application.state.events_hub = EventHub()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: SimpleNamespace(info={})

    response = TestClient(application).get("/api/events")

    assert response.status_code == 401


def test_unbound_provider_identity_cannot_open_event_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claims = SimpleNamespace(user_id="provider-user", session_id="provider-session")
    verified: list[str] = []
    resolved: list[object] = []

    class ProviderAuth:
        def verify_access_token(self, token: str) -> object:
            verified.append(token)
            return claims

    provider = ProviderAuth()

    @contextmanager
    def session(_engine: object):
        yield object()

    def resolve_provider_session(_db: object, identity: object, client: object) -> None:
        assert client is provider
        resolved.append(identity)
        return None

    monkeypatch.setattr(events_router, "get_supabase_auth_client", lambda: provider)
    monkeypatch.setattr(events_router, "get_engine", lambda: "engine")
    monkeypatch.setattr(events_router, "AuditSession", session)
    monkeypatch.setattr(events_router, "resolve_provider_session", resolve_provider_session)
    monkeypatch.setattr(
        events_router, "load_workspace_policy",
        lambda _db, **_kwargs: WorkspaceProfile(ip_allow_list=[]),
    )

    application = FastAPI()
    application.state.events_hub = EventHub()
    application.include_router(router, prefix="/api")

    response = TestClient(application).get(
        "/api/events", headers={"authorization": "Bearer provider-token"}
    )

    assert response.status_code == 401
    assert "provider-token" in verified
    assert resolved == [claims]


@pytest.mark.parametrize(
    ("headers", "allowed"),
    [
        ({"origin": "https://app.example"}, True),
        ({"sec-fetch-site": "same-origin"}, True),
        ({"origin": "https://app.example", "sec-fetch-site": "same-origin"}, True),
        ({}, False),
        ({"origin": "null"}, False),
        ({"origin": "http://localhost:3001"}, False),
        ({"origin": "https://other.example"}, False),
        ({"sec-fetch-site": "same-site"}, False),
        ({"sec-fetch-site": "cross-site"}, False),
        ({"sec-fetch-site": "none"}, False),
        ({"origin": "https://app.example", "sec-fetch-site": "cross-site"}, False),
        ({"origin": "https://app.example", "authorization": "broken"}, False),
    ],
)
def test_cookie_event_principal_checks_browser_origin_before_stream(
    monkeypatch, headers: dict[str, str], allowed: bool
) -> None:
    _install_provider_auth(monkeypatch, "cookie")
    monkeypatch.setattr(
        "app.systems.platform.events.router.browser_origin_is_permitted",
        lambda _settings, origin: origin in {"https://app.example", "http://localhost:3001"},
        raising=False,
    )
    monkeypatch.setattr(
        "app.systems.platform.events.router.get_settings",
        lambda: SimpleNamespace(public_origin="https://app.example"),
        raising=False,
    )
    request = SimpleNamespace(cookies={"openslate_access": "cookie"}, headers=headers, client=None)

    if allowed:
        assert get_event_principal(request, None) == EventPrincipal("cookie")
    else:
        with pytest.raises(HTTPException, match="Invalid authentication credentials") as error:
            get_event_principal(request, None)
        assert error.value.status_code == 401


def test_bearer_event_principal_does_not_require_browser_origin(monkeypatch) -> None:
    _install_provider_auth(monkeypatch, "bearer")
    request = SimpleNamespace(cookies={}, headers={}, client=None)

    assert get_event_principal(request, SimpleNamespace(credentials="bearer")) == EventPrincipal(
        "bearer"
    )


def test_stalled_asgi_send_cancels_the_stream_and_releases_admission_slot() -> None:
    async def exercise() -> None:
        hub = EventHub(max_subscribers=1)
        user = EventViewer(user_id="user", role="member", module_ids=frozenset())
        blocked = asyncio.Event()

        async def body():
            subscription = await hub.subscribe(user)
            try:
                yield b"event: resync\ndata: {}\n\n"
            finally:
                await hub.unsubscribe(subscription)

        async def send(message: object) -> None:
            if isinstance(message, dict) and message.get("type") == "http.response.body":
                await blocked.wait()

        response = BoundedSSEStreamingResponse(body(), send_timeout_seconds=0.001)
        await response.stream_response(send)

        assert hub.subscriber_count == 0

    asyncio.run(exercise())


async def _not_disconnected() -> bool:
    return False


def _install_provider_auth(monkeypatch: pytest.MonkeyPatch, expected_token: str) -> None:
    class ProviderAuth:
        def verify_access_token(self, token: str) -> object:
            assert token == expected_token
            return object()

    monkeypatch.setattr(events_router, "get_supabase_auth_client", ProviderAuth)


def _sequence_authorizer(*users: object | None):
    results = iter(users)

    async def reauthorize(_principal: EventPrincipal) -> object | None:
        return next(results)

    return reauthorize
