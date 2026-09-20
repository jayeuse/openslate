"""SSE transport contracts for opaque invalidation delivery."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.database import get_db
from app.systems.access.users.permissions import Capability
from app.systems.platform.events.hub import EventHub
from app.systems.platform.events.models import InvalidationEvent
from app.systems.platform.events.router import (
    BoundedSSEStreamingResponse,
    EventPrincipal,
    event_stream,
    get_event_principal,
    router,
)


def test_event_stream_starts_with_resync_then_uses_comment_heartbeats() -> None:
    async def exercise() -> None:
        hub = EventHub()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        user = SimpleNamespace(role=SimpleNamespace(role="member", permissions={}))
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
        user = SimpleNamespace(
            role=SimpleNamespace(role="member", permissions={"records.read": True})
        )
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=1,
            reauthorize=_sequence_authorizer(user, user),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(InvalidationEvent("records", capability=Capability.RECORDS_READ))
        assert await anext(stream) == (
            b'event: invalidate\ndata: {"capability":"records.read","entity":"records"}\n\n'
        )
        await stream.aclose()

    asyncio.run(exercise())


def test_event_stream_terminates_when_periodic_identity_check_is_revoked() -> None:
    async def exercise() -> None:
        hub = EventHub()
        request = SimpleNamespace(is_disconnected=_not_disconnected)
        user = SimpleNamespace(role=SimpleNamespace(role="member", permissions={}))
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
        allowed = SimpleNamespace(
            role=SimpleNamespace(role="member", permissions={"records.read": True})
        )
        denied = SimpleNamespace(role=SimpleNamespace(role="member", permissions={}))
        stream = event_stream(
            request,
            hub,
            EventPrincipal("token"),
            heartbeat_seconds=1,
            reauthorize=_sequence_authorizer(allowed, denied),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(InvalidationEvent("records", capability=Capability.RECORDS_READ))
        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await stream.aclose()

    asyncio.run(exercise())


def test_events_endpoint_requires_authenticated_user() -> None:
    application = FastAPI()
    application.state.events_hub = EventHub()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: SimpleNamespace(info={})

    response = TestClient(application).get("/api/events")

    assert response.status_code == 401


def test_event_principal_rejects_setup_only_token(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.systems.platform.events.router.decode_token",
        lambda *_args: {"setup": True},
    )
    request = SimpleNamespace(cookies={})
    bearer = SimpleNamespace(credentials="token")

    with pytest.raises(Exception) as error:
        get_event_principal(request, bearer)

    assert getattr(error.value, "status_code", None) == 401


def test_stalled_asgi_send_cancels_the_stream_and_releases_admission_slot() -> None:
    async def exercise() -> None:
        hub = EventHub(max_subscribers=1)
        user = SimpleNamespace(id="user", role=SimpleNamespace(role="member", permissions={}))
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


def _sequence_authorizer(*users: object | None):
    results = iter(users)

    async def reauthorize(_principal: EventPrincipal) -> object | None:
        return next(results)

    return reauthorize
