"""SSE admission contracts at the response boundary."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.systems.platform.events import router as events_router
from app.systems.platform.events.hub import EventHub
from app.systems.platform.events.router import BoundedSSEStreamingResponse, EventPrincipal


def test_events_endpoint_reserves_capacity_before_response_and_releases_on_start_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def exercise() -> None:
        hub = EventHub(max_subscribers=1)
        request = _request_with_hub(hub)
        principal = EventPrincipal("access-token")
        never = asyncio.Event()

        async def admitted(_principal: EventPrincipal) -> object:
            return _user()

        async def blocked_send(_message: dict[str, object]) -> None:
            await never.wait()

        monkeypatch.setattr(events_router, "reauthorize_event_principal", admitted)
        monkeypatch.setattr(events_router, "_SEND_TIMEOUT_SECONDS", 0.001)

        response = await events_router.events(request, principal)
        assert hub.subscriber_count == 1
        with pytest.raises(HTTPException) as capacity_error:
            await events_router.events(request, principal)
        assert capacity_error.value.status_code == 429

        await response.stream_response(blocked_send)
        assert hub.subscriber_count == 0

    asyncio.run(exercise())


def test_response_releases_a_pre_reserved_slot_when_its_body_raises_after_yielding() -> None:
    async def exercise() -> None:
        hub = EventHub(max_subscribers=1)
        subscription = await hub.subscribe(_user())

        async def body():
            yield b"event: resync\\ndata: {}\\n\\n"
            raise RuntimeError("stream failed")

        async def send(_message: dict[str, object]) -> None:
            return None

        response = BoundedSSEStreamingResponse(
            body(),
            on_close=lambda: hub.unsubscribe(subscription),
        )

        with pytest.raises(RuntimeError, match="stream failed"):
            await response.stream_response(send)
        assert hub.subscriber_count == 0

    asyncio.run(exercise())


def _user() -> object:
    return SimpleNamespace(role=SimpleNamespace(role="member", permissions={}))


def _request_with_hub(hub: EventHub) -> object:
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(events_hub=hub)))
