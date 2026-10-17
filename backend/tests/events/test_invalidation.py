"""Focused contracts for PostgreSQL-backed SSE invalidation."""

import asyncio
from dataclasses import dataclass

import pytest
from uuid6 import uuid7

from app import main as app_main
from app.core.config.settings import Settings
from app.systems.platform.events.hub import (
    EventHub,
    EventViewer,
    SubscriberLimitReached,
    subscriber_capacity,
)
from app.systems.platform.events.models import (
    InvalidationEvent,
    event_for_entity,
    parse_invalidation_payload,
)
from tests.config_support import settings_values
from tests.events.test_postgres_integration import _assert_runtime_settings_target

ORGANIZATION = uuid7()


def _viewer(
    role: str = "member", modules: tuple[object, ...] = (), user_id: object = None,
    *, operator: bool = False,
):
    return EventViewer(
        user_id=user_id or uuid7(),
        role=role,
        module_ids=None if role == "admin" else frozenset(modules),
        org_id=ORGANIZATION,
        operator=operator,
    )


def test_notification_payload_is_opaque_and_round_trips() -> None:
    event = InvalidationEvent(entity="records", entity_id=uuid7(), module_id=uuid7())

    payload = event.to_payload()

    assert payload == {
        "entity": "records",
        "entity_id": str(event.entity_id),
        "module_id": str(event.module_id),
    }
    assert parse_invalidation_payload(payload) == event


@pytest.mark.parametrize(
    "entity", ["records", "relationship_edges", "fields", "modules", "saved_views"]
)
def test_module_scoped_event_without_its_module_fails_closed_to_administrators(
    entity: str,
) -> None:
    event = event_for_entity(entity, uuid7())

    assert event is not None
    assert event.module_id is None
    assert event.administrators_only
    assert parse_invalidation_payload(event.to_payload()).administrators_only


def test_runtime_settings_target_rejects_an_owner_or_different_database() -> None:
    runtime = "postgresql+psycopg://openslate_runtime:runtime@127.0.0.1:55322/openslate"

    with pytest.raises(RuntimeError, match="runner-owned runtime database"):
        _assert_runtime_settings_target(
            "postgresql+psycopg://openslate_owner:owner@127.0.0.1:55322/openslate",
            runtime,
        )


def test_operator_authority_never_substitutes_for_a_missing_event_organization() -> None:
    async def exercise() -> None:
        hub = EventHub()
        subscription = await hub.subscribe(_viewer("admin", operator=True))
        for entity in ("users", "files", "records", "departments", "unclassified"):
            event = event_for_entity(entity, uuid7())
            assert event is not None
            assert not hub.can_receive(subscription, event), entity
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_listener_fanout_filters_by_readable_module_and_discards_slow_consumers() -> None:
    async def exercise() -> None:
        hub = EventHub(subscriber_queue_size=1)
        inventory, finance = uuid7(), uuid7()
        allowed = _viewer(modules=(inventory,))
        denied = _viewer(modules=(finance,))
        allowed_subscription = await hub.subscribe(allowed)
        denied_subscription = await hub.subscribe(denied)

        event = InvalidationEvent(entity="records", module_id=inventory, org_id=ORGANIZATION)
        await hub.publish(event)

        # Every queue read below has a hang guard: a broken dispatch fails, never hangs.
        assert await asyncio.wait_for(allowed_subscription.queue.get(), timeout=5) == event
        assert denied_subscription.queue.empty()

        await hub.publish(event)
        await hub.publish(event)
        assert allowed_subscription.closed
        assert hub.subscriber_count == 2
        await hub.unsubscribe(allowed_subscription)
        assert hub.subscriber_count == 1
        await hub.unsubscribe(denied_subscription)

    asyncio.run(exercise())


def test_listener_delivers_a_cross_process_notification_to_local_subscribers() -> None:
    async def exercise() -> None:
        hub = EventHub()
        module_id = uuid7()
        subscription = await hub.subscribe(_viewer(modules=(module_id,)))
        event = InvalidationEvent(
            entity="modules", entity_id=module_id, module_id=module_id, org_id=ORGANIZATION,
        )

        await hub.publish_notification(event.to_transport_json())

        assert await asyncio.wait_for(subscription.queue.get(), timeout=5) == event
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_listener_reconnect_resyncs_existing_subscribers() -> None:
    async def exercise() -> None:
        hub = EventHub()
        subscription = await hub.subscribe(_viewer())

        await hub.publish_resync()

        assert await asyncio.wait_for(subscription.queue.get(), timeout=5) is None
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_subscriber_admission_limits_are_deterministic_and_release_on_disconnect() -> None:
    async def exercise() -> None:
        hub = EventHub(max_subscribers=1, max_subscribers_per_user=1)
        first_user = _viewer()
        second_user = _viewer()
        first = await hub.subscribe(first_user)

        with pytest.raises(SubscriberLimitReached):
            await hub.subscribe(second_user)

        await hub.unsubscribe(first)
        second = await hub.subscribe(second_user)
        await hub.unsubscribe(second)

    asyncio.run(exercise())


def test_each_user_holds_at_most_the_per_user_streams_and_a_closed_one_frees_one_slot() -> None:
    async def exercise() -> None:
        hub = EventHub(max_subscribers=10, max_subscribers_per_user=2)
        user_id = uuid7()
        streams = [await hub.subscribe(_viewer(user_id=user_id)) for _ in range(2)]
        with pytest.raises(SubscriberLimitReached):
            await hub.subscribe(_viewer(user_id=user_id))
        other = await hub.subscribe(_viewer())

        await hub.unsubscribe(streams.pop())
        streams.append(await hub.subscribe(_viewer(user_id=user_id)))
        with pytest.raises(SubscriberLimitReached):
            await hub.subscribe(_viewer(user_id=user_id))

        for stream in streams:
            await hub.unsubscribe(stream)
        streams = [await hub.subscribe(_viewer(user_id=user_id)) for _ in range(2)]
        assert hub.subscriber_count == 3
        for stream in (*streams, other):
            await hub.unsubscribe(stream)

    asyncio.run(exercise())


def test_application_sse_admission_reserves_capacity_for_ordinary_requests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SSE streams cannot consume every Uvicorn concurrency slot."""

    settings = Settings(**settings_values(server_max_concurrency=32))
    monkeypatch.setattr(app_main, "get_settings", lambda: settings)
    hub = app_main.create_app().state.events_hub

    async def exercise() -> None:
        subscribers = [await hub.subscribe(_viewer()) for _ in range(24)]
        try:
            next_user = _viewer()
            assert not hub.can_subscribe(next_user)
        finally:
            for subscriber in subscribers:
                await hub.unsubscribe(subscriber)

    asyncio.run(exercise())


@pytest.mark.parametrize(
    ("server_max_concurrency", "expected_subscriber_capacity"),
    [
        (2, 1),
        (8, 1),
        (9, 1),
        (32, 24),
        (1_000, 128),
    ],
)
def test_subscriber_capacity_preserves_http_headroom_at_every_server_limit(
    server_max_concurrency: int,
    expected_subscriber_capacity: int,
) -> None:
    assert subscriber_capacity(server_max_concurrency) == expected_subscriber_capacity


def test_notification_transport_keeps_recipient_internal_and_rejects_unsafe_envelopes() -> None:
    recipient_id = uuid7()
    event = event_for_entity("in_app_notifications", uuid7(), recipient_id=recipient_id)

    assert event is not None
    assert event.to_payload() == {"entity": "in_app_notifications"}
    assert event.to_json() == '{"entity":"in_app_notifications"}'
    assert event.to_transport_payload() == {
        "entity": "in_app_notifications",
        "recipient_id": str(recipient_id),
    }
    assert parse_invalidation_payload(event.to_transport_json()) == event

    for payload in (
        {"entity": "in_app_notifications"},
        {"entity": "in_app_notifications", "recipient_id": "not-a-uuid"},
        {
            "entity": "in_app_notifications",
            "recipient_id": str(recipient_id),
            "entity_id": str(uuid7()),
        },
        {"entity": "records", "module_id": str(uuid7()), "recipient_id": str(recipient_id)},
    ):
        with pytest.raises(ValueError, match="invalid invalidation payload"):
            parse_invalidation_payload(payload)


def test_module_and_board_access_with_the_same_identifier_have_distinct_signatures() -> None:
    async def exercise() -> None:
        hub = EventHub()
        scope_id, user_id = uuid7(), uuid7()
        subscription = await hub.subscribe(_viewer(modules=(scope_id,), user_id=user_id))
        board_reader = EventViewer(
            user_id, "member", frozenset(), board_ids=frozenset({scope_id}), org_id=ORGANIZATION,
        )
        assert hub.refresh_subscription(subscription, board_reader)
        assert not hub.can_receive(subscription, InvalidationEvent("records", module_id=scope_id))
        assert hub.can_receive(
            subscription,
            parse_invalidation_payload({
                "entity": "boards", "board_id": str(scope_id), "org_id": str(ORGANIZATION),
            }),
        )
        assert not hub.refresh_subscription(subscription, board_reader)
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_refreshed_access_changes_the_subscription_signature() -> None:
    async def exercise() -> None:
        hub = EventHub()
        module_id = uuid7()
        user_id = uuid7()
        subscription = await hub.subscribe(_viewer(user_id=user_id))

        assert hub.refresh_subscription(subscription, _viewer(user_id=user_id)) is False
        assert hub.refresh_subscription(
            subscription, _viewer(modules=(module_id,), user_id=user_id)
        )
        assert hub.can_receive(subscription, InvalidationEvent(
            "records", module_id=module_id, org_id=ORGANIZATION,
        ))
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


@dataclass(frozen=True)
class _FanOut:
    """Events published in order, the subscribers, and the events each one receives.

    ``transports`` are the cross-process payloads; ``payloads`` are what a browser sees.
    ``audiences`` name each event's audience flag: "administrators_only", "all_authenticated"
    or "neither" (the entity, module, board or recipient decides).
    """

    events: list[InvalidationEvent | None]
    payloads: list[dict[str, str]]
    transports: list[dict[str, str]]
    audiences: list[str]
    viewers: dict[str, EventViewer]
    receives: dict[str, list[int]]
    through_transport: bool


def _entity_only(
    entity: str,
    viewers: dict[str, EventViewer],
    receivers: set[str],
    *,
    audience: str,
    keeps_row_id: bool = False,
) -> _FanOut:
    row_id = uuid7()
    payload = {"entity": entity, "entity_id": str(row_id)} if keeps_row_id else {"entity": entity}
    org_id = (
        None if entity in {"backup_policies", "backup_runs", "update_statuses"} else ORGANIZATION
    )
    return _FanOut(
        events=[event_for_entity(entity, row_id, org_id=org_id)],
        payloads=[payload],
        transports=[payload if org_id is None else {**payload, "org_id": str(org_id)}],
        audiences=[audience],
        viewers=viewers,
        receives={name: [0] if name in receivers else [] for name in viewers},
        through_transport=False,
    )


def _backup_authority(entity: str) -> _FanOut:
    viewers = {"admin": _viewer(role="admin", operator=True), "member": _viewer()}
    return _entity_only(
        entity, viewers, {"admin"}, audience="administrators_only", keeps_row_id=True
    )


def _files() -> _FanOut:
    viewers = {"records_reader": _viewer(modules=(uuid7(),)), "administrator": _viewer("admin")}
    return _entity_only("files", viewers, {"administrator"}, audience="administrators_only")


def _group_access() -> _FanOut:
    viewers = {"member": _viewer(modules=(uuid7(),)), "admin": _viewer("admin")}
    return _entity_only("group_access", viewers, {"admin"}, audience="neither")


def _saved_views_and_workspace() -> _FanOut:
    module_id = uuid7()
    payloads = [
        {"entity": "saved_views", "module_id": str(module_id)},
        {"entity": "workspace_profiles"},
    ]
    return _FanOut(
        events=[
            event_for_entity("saved_views", uuid7(), module_id=module_id, org_id=ORGANIZATION),
            event_for_entity("workspace_profiles", uuid7(), org_id=ORGANIZATION),
        ],
        payloads=payloads,
        transports=[{**payload, "org_id": str(ORGANIZATION)} for payload in payloads],
        audiences=["neither", "all_authenticated"],
        viewers={"module_reader": _viewer(modules=(module_id,)), "ordinary": _viewer()},
        receives={"module_reader": [0, 1], "ordinary": [1]},
        through_transport=False,
    )


def _board(entity: str) -> _FanOut:
    board_id = uuid7()
    scope = frozenset({board_id})
    payload = {"entity": entity, "board_id": str(board_id)}
    return _FanOut(
        events=[event_for_entity(
            entity, uuid7(), board_id=board_id, module_id=uuid7(), org_id=ORGANIZATION,
        )],
        payloads=[payload],
        transports=[{**payload, "org_id": str(ORGANIZATION)}],
        audiences=["neither"],
        viewers={
            "reader": EventViewer(
                uuid7(), "member", frozenset(), board_ids=scope, org_id=ORGANIZATION,
            ),
            "guest": EventViewer(
                uuid7(), "guest", frozenset(), board_ids=scope, org_id=ORGANIZATION,
            ),
            "outsider": _viewer(modules=(board_id,)),
            "admin": _viewer("admin"),
            "inactive": EventViewer(uuid7(), None, None, board_ids=scope),
        },
        receives={"reader": [0], "guest": [0], "outsider": [], "admin": [0], "inactive": []},
        through_transport=True,
    )


def _dashboard(entity: str) -> _FanOut:
    return _FanOut(
        events=[event_for_entity(entity, uuid7(), module_id=uuid7(), org_id=ORGANIZATION)],
        payloads=[{"entity": "dashboards"}],
        transports=[{"entity": "dashboards", "org_id": str(ORGANIZATION)}],
        audiences=["all_authenticated"],
        viewers={
            "admin": _viewer("admin"),
            "member": _viewer("member"),
            "guest": _viewer("guest"),
            "inactive": EventViewer(uuid7(), None, frozenset()),
        },
        receives={"admin": [0], "member": [0], "guest": [0], "inactive": []},
        through_transport=True,
    )


def _notification_recipient() -> _FanOut:
    recipient_id = uuid7()
    return _FanOut(
        events=[event_for_entity("in_app_notifications", uuid7(), recipient_id=recipient_id)],
        payloads=[{"entity": "in_app_notifications"}],
        transports=[{"entity": "in_app_notifications", "recipient_id": str(recipient_id)}],
        audiences=["neither"],
        viewers={
            "recipient": _viewer(user_id=recipient_id),
            "other": _viewer(),
            "admin": _viewer("admin"),
        },
        receives={"recipient": [0], "other": [], "admin": []},
        through_transport=True,
    )


def _chart_hint() -> _FanOut:
    module_id = uuid7()
    payload = {"entity": "charts", "module_id": str(module_id)}
    return _FanOut(
        events=[event_for_entity("charts", uuid7(), module_id=module_id, org_id=ORGANIZATION)],
        payloads=[payload],
        transports=[{**payload, "org_id": str(ORGANIZATION)}],
        audiences=["neither"],
        viewers={
            "allowed": EventViewer(uuid7(), "member", frozenset({module_id}), org_id=ORGANIZATION),
            "denied": EventViewer(uuid7(), "member", frozenset({uuid7()}), org_id=ORGANIZATION),
            "admin": EventViewer(uuid7(), "admin", None, org_id=ORGANIZATION),
        },
        receives={"allowed": [0], "denied": [], "admin": [0]},
        through_transport=True,
    )


def _received(row: _FanOut, events: list[InvalidationEvent]) -> dict[str, list[object]]:
    async def exercise() -> dict[str, list[object]]:
        hub = EventHub()
        subscriptions = {name: await hub.subscribe(viewer) for name, viewer in row.viewers.items()}
        for event in events:
            if row.through_transport:
                await hub.publish_notification(event.to_transport_json())
            else:
                await hub.publish(event)
        received: dict[str, list[object]] = {}
        for name, subscription in subscriptions.items():
            received[name] = []
            while not subscription.queue.empty():
                received[name].append(subscription.queue.get_nowait())
            await hub.unsubscribe(subscription)
        return received

    return asyncio.run(exercise())


@pytest.mark.parametrize(
    "build",
    [
        *(
            pytest.param(lambda entity=entity: _backup_authority(entity), id=entity)
            for entity in ["backup_policies", "backup_runs", "update_statuses"]
        ),
        pytest.param(_saved_views_and_workspace, id="saved_views-and-workspace_profiles"),
        pytest.param(_files, id="files"),
        *(
            pytest.param(lambda entity=entity: _board(entity), id=entity)
            for entity in ["boards", "board_posts", "board_events", "board_widgets"]
        ),
        *(
            pytest.param(lambda entity=entity: _dashboard(entity), id=entity)
            for entity in ["dashboards", "dashboard_widgets"]
        ),
        pytest.param(_notification_recipient, id="in_app_notifications"),
        pytest.param(_group_access, id="group_access"),
        pytest.param(_chart_hint, id="charts"),
    ],
)
def test_each_invalidation_reaches_exactly_its_audience_without_row_identifiers(build) -> None:
    row = build()
    events = [event for event in row.events if event is not None]
    assert len(events) == len(row.events)
    for event, payload, transport, audience in zip(
        events, row.payloads, row.transports, row.audiences, strict=True
    ):
        assert event.to_payload() == payload
        assert event.to_transport_payload() == transport
        assert parse_invalidation_payload(transport) == event
        assert event.administrators_only is (audience == "administrators_only")
        assert event.all_authenticated is (audience == "all_authenticated")
    assert _received(row, events) == {
        name: [events[index] for index in indexes] for name, indexes in row.receives.items()
    }
