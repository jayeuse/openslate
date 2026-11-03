"""S4: a signed-in person lists their own sign-in history and nobody else's (PostgreSQL)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.identity.models import IdentitySession
from tests.route_app_support import route_app
from tests.security_events.event_support import append_committed

pytest_plugins = ("tests.security_events.event_support",)
pytestmark = pytest.mark.integration


def _event(event_type: str, subject: UUID, occurred_at: datetime, **metadata) -> UUID:
    return append_committed(
        event_type=event_type,
        outcome="failure" if event_type == "identity.sign_in_failure" else "denied",
        source="identity.login",
        operation_id=uuid4(),
        occurred_at=occurred_at,
        subject_id=subject,
        metadata=metadata,
    )


def test_s4_c1_own_history_lists_every_kind_newest_first_in_pages(event_world):
    world = event_world
    now = datetime.now(UTC)
    failed = _event("identity.sign_in_failure", world.actor_id, now - timedelta(hours=2),
                    ip_address="192.0.2.31", user_agent="Agent-Failed/1.0")
    locked = _event("identity.lockout", world.actor_id, now - timedelta(hours=1),
                    ip_address="192.0.2.32")
    # Another person's failure at the same address never appears.
    _event("identity.sign_in_failure", uuid4(), now - timedelta(minutes=30),
           ip_address="192.0.2.31")
    with world.anonymous("192.0.2.33") as second:
        second.headers["User-Agent"] = "Agent-Second/2.0"
        assert second.post(
            "/api/auth/login", json={"email": world.email, "password": world.password}
        ).status_code == 200
    with Session(world.owner) as db:
        sessions = list(db.scalars(
            select(IdentitySession).where(IdentitySession.user_id == world.actor_id)
            .order_by(IdentitySession.created_at)
        ))
        first, ended = sessions
        ended.revoked_at = ended.created_at + timedelta(seconds=5)
        db.commit()
        ended_id, ended_at, first_id = ended.id, ended.revoked_at, first.id

    # An organization that the person does not belong to binds nothing here.
    world.client.headers["X-Org"] = str(uuid4())
    page = world.client.get("/api/auth/sign-in-events", params={"limit": 3})
    rest = world.client.get("/api/auth/sign-in-events", params={"limit": 3, "offset": 3})

    assert page.status_code == rest.status_code == 200, page.text
    assert page.headers["cache-control"] == "no-store"
    assert page.json()["pagination"] == {
        "limit": 3, "offset": 0, "count": 3, "total": 5, "has_more": True,
    }
    rows = page.json()["items"] + rest.json()["items"]
    assert [(row["kind"], row["id"]) for row in rows] == [
        ("session_ended", str(ended_id)),
        ("signed_in", str(ended_id)),
        ("signed_in", str(first_id)),
        ("locked_out", str(locked)),
        ("sign_in_failed", str(failed)),
    ]
    assert rows[0]["occurred_at"] == ended_at.isoformat().replace("+00:00", "Z")
    assert rows[0]["user_agent"] == rows[1]["user_agent"] == "Agent-Second/2.0"
    assert rows[0]["ip_address"] == rows[1]["ip_address"] == "192.0.2.33"
    assert rows[3]["user_agent"] is None and rows[3]["ip_address"] == "192.0.2.32"
    assert rows[4]["user_agent"] == "Agent-Failed/1.0" and rows[4]["ip_address"] == "192.0.2.31"
    assert set(rows[4]) == {"id", "kind", "occurred_at", "user_agent", "ip_address"}


@pytest.mark.parametrize("params", [{"search": "Agent"}, {"deleted": "include"}])
def test_s4_c1_own_history_has_no_search_or_deleted_filter(event_world, params):
    assert event_world.client.get("/api/auth/sign-in-events", params=params).status_code == 422


def test_s4_c1_own_history_needs_a_session():
    client = TestClient(route_app(), base_url=get_settings().public_origin)
    response = client.get("/api/auth/sign-in-events")

    assert response.status_code == 401
    assert response.json() == {
        "detail": "Invalid authentication credentials",
        "request_id": response.headers["X-Request-ID"],
    }

