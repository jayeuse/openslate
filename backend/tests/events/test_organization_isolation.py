"""S09: an event in one organization never reaches a stream bound to another (D16)."""

import asyncio
from uuid import uuid4

import pytest

from app.systems.platform.events.hub import EventHub, EventSubscription, EventViewer
from app.systems.platform.events.models import (
    InvalidationEvent,
    event_for_entity,
    parse_invalidation_payload,
)

HOME, OTHER = uuid4(), uuid4()
MODULE, BOARD, RECIPIENT = uuid4(), uuid4(), uuid4()


def _subscription(org_id, *, role="admin", user_id=RECIPIENT) -> EventSubscription:
    viewer = EventViewer(
        user_id=user_id, role=role, module_ids=None if role == "admin" else frozenset({MODULE}),
        board_ids=None if role == "admin" else frozenset({BOARD}), org_id=org_id,
    )
    return EventSubscription(asyncio.Queue(), viewer, (), user_id)


EVENTS = {
    "module": event_for_entity("records", uuid4(), module_id=MODULE, org_id=HOME),
    "board": event_for_entity("board_posts", board_id=BOARD, org_id=HOME),
    "all_authenticated": event_for_entity("departments", uuid4(), org_id=HOME),
    "administrators_only": event_for_entity("files", uuid4(), org_id=HOME),
    "notification": event_for_entity(
        "in_app_notifications", recipient_id=RECIPIENT, org_id=HOME
    ),
}


@pytest.mark.parametrize("kind", sorted(EVENTS))
@pytest.mark.parametrize("role", ["admin", "member"])
def test_an_event_reaches_only_its_own_organization(kind: str, role: str) -> None:
    event = EVENTS[kind]
    assert isinstance(event, InvalidationEvent)
    hub = EventHub()
    if kind == "administrators_only" and role != "admin":
        assert hub.can_receive(_subscription(HOME, role=role), event) is False
    else:
        assert hub.can_receive(_subscription(HOME, role=role), event) is True
    assert hub.can_receive(_subscription(OTHER, role=role), event) is False


def test_the_organization_routes_inside_notify_but_never_reaches_a_browser() -> None:
    event = EVENTS["module"]
    assert "org_id" not in event.to_payload()
    assert event.to_transport_payload()["org_id"] == str(HOME)
    assert parse_invalidation_payload(event.to_transport_json()) == event
