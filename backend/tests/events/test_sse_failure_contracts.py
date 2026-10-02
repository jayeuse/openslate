"""Failure and authorization contracts that bound PostgreSQL-backed SSE."""

import asyncio
import threading
from types import SimpleNamespace

import psycopg
import pytest
from fastapi import HTTPException
from uuid6 import uuid7

from app.systems.platform.events import router as events_router
from app.systems.platform.events.hub import EventHub, EventViewer, PostgresInvalidationListener
from app.systems.platform.events.models import (
    InvalidationEvent,
    event_for_entity,
    parse_invalidation_payload,
)
from app.systems.platform.events.publisher import publish_invalidations
from app.systems.platform.events.router import (
    BoundedSSEStreamingResponse,
    EventPrincipal,
    event_stream,
    get_event_principal,
)

READABLE_MODULE = uuid7()


def test_untrusted_notification_payloads_fail_closed_without_fanout() -> None:
    async def exercise() -> None:
        hub = EventHub()
        subscription = await hub.subscribe(_user(reads=True))

        await hub.publish_notification("{")
        await hub.publish_notification('{"entity":"records","capability":"records.read"}')

        assert subscription.queue.empty()
        await hub.publish_notification('{"entity":"resync"}')
        assert await subscription.queue.get() is None
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "payload",
    [
        {"entity": "Records"},
        {"entity": "records", "entity_id": 7, "module_id": str(READABLE_MODULE)},
        {"entity": "records", "entity_id": "not-a-uuid", "module_id": str(READABLE_MODULE)},
        {"entity": "records", "capability": "records.read"},
        {"entity": "records", "module_id": 7},
        {"entity": "departments", "module_id": str(READABLE_MODULE)},
    ],
)
def test_payload_validation_rejects_malformed_or_under_authorized_events(payload: object) -> None:
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        parse_invalidation_payload(payload)


def test_invalid_entity_name_is_rejected_before_serialization() -> None:
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        InvalidationEvent("bad entity")


def test_empty_commits_do_not_open_a_postgresql_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.systems.platform.events.publisher.psycopg.connect",
        lambda *_args, **_kwargs: pytest.fail("an empty invalidation set must not connect"),
    )

    assert publish_invalidations(())


def test_event_principal_rejects_ambiguous_credentials_and_returns_one_verified_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cookie_request = SimpleNamespace(cookies={"openslate_access": "cookie-token"})
    bearer = SimpleNamespace(credentials="bearer-token")

    with pytest.raises(HTTPException, match="Invalid authentication credentials"):
        get_event_principal(cookie_request, bearer)

    verified: list[str] = []

    class ProviderAuth:
        def verify_access_token(self, token: str) -> object:
            verified.append(token)
            return object()

    monkeypatch.setattr(events_router, "get_supabase_auth_client", ProviderAuth)
    principal = get_event_principal(SimpleNamespace(cookies={}, client=None), bearer)

    assert principal == EventPrincipal("bearer-token")
    assert verified == ["bearer-token"]


def test_events_endpoint_fails_closed_for_missing_hub_revocation_and_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def exercise() -> None:
        principal = EventPrincipal("access-token")
        missing_hub = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(events_hub=None)))
        with pytest.raises(RuntimeError, match="event hub is not configured"):
            await events_router.events(missing_hub, principal)

        hub_request = _request_with_hub(EventHub())

        async def revoked(_principal: EventPrincipal) -> None:
            return None

        monkeypatch.setattr(events_router, "reauthorize_event_principal", revoked)
        with pytest.raises(HTTPException) as revoked_error:
            await events_router.events(hub_request, principal)
        assert revoked_error.value.status_code == 401

        full_hub = EventHub(max_subscribers=0)
        full_request = _request_with_hub(full_hub)

        async def admitted(_principal: EventPrincipal) -> object:
            return _user()

        monkeypatch.setattr(events_router, "reauthorize_event_principal", admitted)
        with pytest.raises(HTTPException) as capacity_error:
            await events_router.events(full_request, principal)
        assert capacity_error.value.status_code == 429
        assert capacity_error.value.detail == "Too many event streams"

        normal_hub = EventHub()
        normal_request = _request_with_hub(normal_hub)
        response = await events_router.events(normal_request, principal)
        assert response.media_type == "text/event-stream"
        assert response.headers["cache-control"] == "no-cache, no-transform"
        await response.body_iterator.aclose()

    asyncio.run(exercise())


def test_stream_resyncs_without_replaying_untrusted_cursor_then_stops_on_disconnect() -> None:
    async def exercise() -> None:
        disconnected = False

        async def is_disconnected() -> bool:
            return disconnected

        request = SimpleNamespace(
            headers={"last-event-id": "malformed-and-unsupported"},
            is_disconnected=is_disconnected,
        )
        stream = event_stream(
            request,
            EventHub(),
            EventPrincipal("token"),
            initial_user=_user(),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        disconnected = True
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        await stream.aclose()

    asyncio.run(exercise())


def test_stream_releases_capacity_when_reauthorization_or_admission_fails() -> None:
    async def exercise() -> None:
        hub = EventHub()

        async def revoked(_principal: EventPrincipal) -> None:
            return None

        unauthenticated = event_stream(
            SimpleNamespace(is_disconnected=_never_disconnected),
            hub,
            EventPrincipal("token"),
            reauthorize=revoked,
        )
        with pytest.raises(StopAsyncIteration):
            await anext(unauthenticated)
        assert hub.subscriber_count == 0

        denied_hub = EventHub(max_subscribers=0)
        denied_stream = event_stream(
            SimpleNamespace(is_disconnected=_never_disconnected),
            denied_hub,
            EventPrincipal("token"),
            initial_user=_user(),
        )
        with pytest.raises(StopAsyncIteration):
            await anext(denied_stream)
        assert denied_hub.subscriber_count == 0

    asyncio.run(exercise())


def test_stream_stops_before_queued_event_when_session_is_revoked() -> None:
    async def exercise() -> None:
        hub = EventHub()
        stream = event_stream(
            SimpleNamespace(is_disconnected=_never_disconnected),
            hub,
            EventPrincipal("token"),
            initial_user=_user(reads=True),
            reauthorize=_sequence(None),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(InvalidationEvent("records", module_id=READABLE_MODULE))
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        assert hub.subscriber_count == 0

    asyncio.run(exercise())


def test_stream_emits_resync_when_permission_snapshot_changes() -> None:
    async def exercise() -> None:
        hub = EventHub()
        initial = _user(reads=True)
        stream = event_stream(
            SimpleNamespace(is_disconnected=_never_disconnected),
            hub,
            EventPrincipal("token"),
            initial_user=initial,
            reauthorize=_sequence(_user(), _user()),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish_resync()
        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await stream.aclose()

    asyncio.run(exercise())


def test_bounded_response_encodes_text_and_finishes_cleanly() -> None:
    async def exercise() -> None:
        sent: list[dict[str, object]] = []

        async def body():
            yield "event: resync\\ndata: {}\\n\\n"

        async def send(message: dict[str, object]) -> None:
            sent.append(message)

        response = BoundedSSEStreamingResponse(body(), send_timeout_seconds=1)
        await response.stream_response(send)

        assert sent[-1] == {"type": "http.response.body", "body": b"", "more_body": False}
        assert sent[1]["body"] == b"event: resync\\ndata: {}\\n\\n"

    asyncio.run(exercise())


def test_listener_entrypoints_ignore_absent_or_closed_event_loops() -> None:
    hub = EventHub()
    hub.publish_from_listener('{"entity":"resync"}')
    hub.publish_resync_from_listener()

    loop = asyncio.new_event_loop()
    loop.close()
    hub._loop = loop
    hub.publish_from_listener('{"entity":"resync"}')
    hub.publish_resync_from_listener()


def test_viewer_without_a_role_fails_closed_for_delivery_and_access_signatures() -> None:
    async def exercise() -> None:
        hub = EventHub()
        subscription = await hub.subscribe(
            EventViewer(user_id=uuid7(), role=None, module_ids=frozenset({READABLE_MODULE}))
        )
        event = event_for_entity("records", uuid7(), module_id=READABLE_MODULE)
        assert event is not None

        assert subscription.access_signature == ()
        assert not hub.can_receive(subscription, event)
        await hub.publish(event)
        assert subscription.queue.empty()
        await hub.unsubscribe(subscription)
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_listener_start_is_idempotent_and_stop_tolerates_connection_close_failure() -> None:
    connected = threading.Event()

    class Connection:
        def __enter__(self) -> "Connection":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def execute(self, _statement: str) -> None:
            connected.set()

        def close(self) -> None:
            raise psycopg.OperationalError("socket is already closed")

        def notifies(self, **_kwargs: object):
            while not listener._stop.is_set():
                listener._stop.wait(0.01)
            return
            yield None

    listener = PostgresInvalidationListener(
        EventHub(),
        "postgresql://events:test@localhost/openslate",
        connect=lambda *_args, **_kwargs: Connection(),
        connect_timeout_seconds=1,
        statement_timeout_ms=1_000,
    )
    listener.start()
    assert connected.wait(timeout=1)
    first_thread = listener._thread
    listener.start()

    assert listener._thread is first_thread
    assert listener.stop()


def test_hub_denies_missing_and_non_admin_roles_but_releases_one_of_many_streams() -> None:
    async def exercise() -> None:
        hub = EventHub()
        no_role = await hub.subscribe(EventViewer(user_id=uuid7(), role=None, module_ids=None))
        administrator = await hub.subscribe(
            EventViewer(user_id=uuid7(), role="admin", module_ids=None)
        )
        member = _user()
        first_member = await hub.subscribe(member)
        second_member = await hub.subscribe(member)
        records_event = event_for_entity("records")
        admin_event = event_for_entity("users")
        unclassified_event = InvalidationEvent("unclassified")

        assert no_role.access_signature == ()
        assert not hub.can_receive(no_role, records_event)
        assert administrator.access_signature == ("admin",)
        assert hub.can_receive(administrator, admin_event)
        assert not hub.can_receive(first_member, admin_event)
        assert not hub.can_receive(first_member, unclassified_event)
        await hub.unsubscribe(first_member)
        assert hub.can_subscribe(member)
        await hub.unsubscribe(no_role)
        await hub.unsubscribe(administrator)
        await hub.unsubscribe(second_member)

    asyncio.run(exercise())


def test_listener_uses_settings_defaults_and_stops_without_a_started_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.systems.platform.events.hub.get_settings",
        lambda: SimpleNamespace(
            database_url="postgresql+psycopg://events:secret@localhost/openslate",
            database_connect_timeout_seconds=7,
            database_statement_timeout_ms=9_000,
        ),
    )

    listener = PostgresInvalidationListener(EventHub())

    assert listener._database_url == "postgresql://events:secret@localhost/openslate"
    assert listener._connect_options == {
        "autocommit": True,
        "connect_timeout": 7,
        "options": "-c statement_timeout=9000",
    }
    assert listener.stop()


def test_stream_timeout_resyncs_when_authorization_changes() -> None:
    async def exercise() -> None:
        stream = event_stream(
            SimpleNamespace(is_disconnected=_never_disconnected),
            EventHub(),
            EventPrincipal("token"),
            heartbeat_seconds=0,
            initial_user=_user(reads=True),
            reauthorize=_sequence(_user()),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await stream.aclose()

    asyncio.run(exercise())


def test_stream_resync_terminates_when_the_session_is_revoked() -> None:
    async def exercise() -> None:
        hub = EventHub()
        stream = event_stream(
            SimpleNamespace(is_disconnected=_never_disconnected),
            hub,
            EventPrincipal("token"),
            initial_user=_user(),
            reauthorize=_sequence(None),
        )

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish_resync()
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        assert hub.subscriber_count == 0

    asyncio.run(exercise())


def test_stream_closes_a_subscription_marked_slow_before_sending_data() -> None:
    async def exercise() -> None:
        hub = EventHub(subscriber_queue_size=1)
        stream = event_stream(
            SimpleNamespace(is_disconnected=_never_disconnected),
            hub,
            EventPrincipal("token"),
            initial_user=_user(reads=True),
        )
        event = InvalidationEvent("records", module_id=READABLE_MODULE)

        assert await anext(stream) == b"event: resync\ndata: {}\n\n"
        await hub.publish(event)
        await hub.publish(event)
        with pytest.raises(StopAsyncIteration):
            await anext(stream)
        assert hub.subscriber_count == 0

    asyncio.run(exercise())


_MEMBER_ID = uuid7()


def _user(*, reads: bool = False) -> EventViewer:
    """A member who can read the one test module, or nothing."""
    return EventViewer(
        user_id=_MEMBER_ID,
        role="member",
        module_ids=frozenset({READABLE_MODULE}) if reads else frozenset(),
    )


def _request_with_hub(hub: EventHub) -> object:
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(events_hub=hub)))


async def _never_disconnected() -> bool:
    return False


def _sequence(*users: object | None):
    results = iter(users)

    async def reauthorize(_principal: EventPrincipal) -> object | None:
        return next(results)

    return reauthorize
