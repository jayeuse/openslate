"""Focused contracts for PostgreSQL-backed SSE invalidation."""

import asyncio

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


def _viewer(role: str = "member", modules: tuple[object, ...] = (), user_id: object = None):
    return EventViewer(
        user_id=user_id or uuid7(),
        role=role,
        module_ids=None if role == "admin" else frozenset(modules),
    )


def test_notification_payload_is_opaque_and_rejects_unknown_fields() -> None:
    event = InvalidationEvent(entity="records", entity_id=uuid7(), module_id=uuid7())

    payload = event.to_payload()

    assert payload == {
        "entity": "records",
        "entity_id": str(event.entity_id),
        "module_id": str(event.module_id),
    }
    assert parse_invalidation_payload(payload) == event
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        parse_invalidation_payload({"entity": "records", "snapshot": {"secret": "no"}})


@pytest.mark.parametrize(
    "entity",
    ["files", "saved_views", "workspace_profiles", "groups", "group_members", "group_access"],
)
def test_entity_only_notification_payload_rejects_an_untrusted_identifier(entity: str) -> None:
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        parse_invalidation_payload({"entity": entity, "entity_id": str(uuid7())})


def test_module_is_accepted_only_on_module_scoped_entities() -> None:
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        parse_invalidation_payload({"entity": "workspace_profiles", "module_id": str(uuid7())})
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        parse_invalidation_payload({"entity": "records", "capability": "records.read"})


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


def test_listener_fanout_filters_by_readable_module_and_discards_slow_consumers() -> None:
    async def exercise() -> None:
        hub = EventHub(subscriber_queue_size=1)
        inventory, finance = uuid7(), uuid7()
        allowed = _viewer(modules=(inventory,))
        denied = _viewer(modules=(finance,))
        allowed_subscription = await hub.subscribe(allowed)
        denied_subscription = await hub.subscribe(denied)

        event = InvalidationEvent(entity="records", module_id=inventory)
        await hub.publish(event)

        assert await allowed_subscription.queue.get() == event
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
        event = InvalidationEvent(entity="modules", entity_id=module_id, module_id=module_id)

        await hub.publish_notification(event.to_json())

        assert await subscription.queue.get() == event
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_listener_reconnect_resyncs_existing_subscribers() -> None:
    async def exercise() -> None:
        hub = EventHub()
        subscription = await hub.subscribe(_viewer())

        await hub.publish_resync()

        assert await subscription.queue.get() is None
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


def test_saved_views_and_workspace_profiles_have_safe_non_admin_audiences() -> None:
    module_id = uuid7()

    async def exercise() -> None:
        hub = EventHub()
        module_reader = _viewer(modules=(module_id,))
        ordinary_user = _viewer()
        view_subscription = await hub.subscribe(module_reader)
        workspace_subscription = await hub.subscribe(ordinary_user)
        views = event_for_entity("saved_views", uuid7(), module_id=module_id)
        workspace = event_for_entity("workspace_profiles", uuid7())

        await hub.publish(views)
        await hub.publish(workspace)

        assert await view_subscription.queue.get() == views
        assert await view_subscription.queue.get() == workspace
        assert await workspace_subscription.queue.get() == workspace
        await hub.unsubscribe(view_subscription)
        await hub.unsubscribe(workspace_subscription)

    views = event_for_entity("saved_views", uuid7(), module_id=module_id)
    workspace = event_for_entity("workspace_profiles", uuid7())

    assert views is not None and workspace is not None
    assert views.to_payload() == {"entity": "saved_views", "module_id": str(module_id)}
    assert workspace.to_payload() == {"entity": "workspace_profiles"}
    assert workspace.all_authenticated
    asyncio.run(exercise())


def test_file_invalidations_are_entity_only_and_administrator_only() -> None:
    async def exercise() -> None:
        hub = EventHub()
        records_reader = _viewer(modules=(uuid7(),))
        administrator = _viewer("admin")
        reader_subscription = await hub.subscribe(records_reader)
        administrator_subscription = await hub.subscribe(administrator)
        event = event_for_entity("files", uuid7())

        await hub.publish(event)

        assert reader_subscription.queue.empty()
        assert await administrator_subscription.queue.get() == event
        await hub.unsubscribe(reader_subscription)
        await hub.unsubscribe(administrator_subscription)

    file_event = event_for_entity("files", uuid7())

    assert file_event is not None
    assert file_event.to_payload() == {"entity": "files"}
    assert file_event.administrators_only
    asyncio.run(exercise())


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


def test_audience_scoped_entities_are_not_generic_invalidation_subjects() -> None:
    for entity in ("reports", "report_runs", "report_run_rows", "report_schedules", "board_events"):
        assert event_for_entity(entity, uuid7()) is None
        with pytest.raises(ValueError, match="invalid invalidation payload"):
            parse_invalidation_payload({"entity": entity, "entity_id": str(uuid7())})


def test_board_scoped_entities_are_not_generic_invalidation_subjects() -> None:
    for entity in (
        "boards",
        "board_grants",
        "board_record_placements",
        "board_widgets",
        "board_favorites",
        "board_homes",
        "board_templates",
        "board_announcements",
        "board_announcement_revisions",
        "board_announcement_personal_states",
    ):
        assert event_for_entity(entity, uuid7()) is None
        with pytest.raises(ValueError, match="invalid invalidation payload"):
            parse_invalidation_payload({"entity": entity, "entity_id": str(uuid7())})


def test_notification_fanout_targets_only_the_persisted_recipient_even_for_admins() -> None:
    async def exercise() -> None:
        hub = EventHub()
        recipient_id = uuid7()
        recipient = await hub.subscribe(_viewer(user_id=recipient_id))
        other = await hub.subscribe(_viewer())
        admin = await hub.subscribe(_viewer("admin"))
        event = event_for_entity("in_app_notifications", uuid7(), recipient_id=recipient_id)
        assert event is not None

        await hub.publish_notification(event.to_transport_json())

        assert await recipient.queue.get() == event
        assert other.queue.empty()
        assert admin.queue.empty()
        for subscription in (recipient, other, admin):
            await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_group_events_are_entity_only_and_reach_only_administrators() -> None:
    async def exercise() -> None:
        hub = EventHub()
        member = await hub.subscribe(_viewer(modules=(uuid7(),)))
        admin = await hub.subscribe(_viewer("admin"))
        event = event_for_entity("group_access", uuid7())
        assert event is not None

        await hub.publish(event)

        assert member.queue.empty()
        assert await admin.queue.get() == event
        for subscription in (member, admin):
            await hub.unsubscribe(subscription)

    event = event_for_entity("group_access", uuid7())
    assert event is not None
    assert event.to_payload() == {"entity": "group_access"}
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
        assert hub.can_receive(subscription, InvalidationEvent("records", module_id=module_id))
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())
