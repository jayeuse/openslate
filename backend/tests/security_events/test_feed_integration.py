"""Collection contracts through genuine authenticated HTTP and committed runtime rows."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from tests.security_events.event_support import append_committed

pytest_plugins = ("tests.security_events.event_support",)
pytestmark = pytest.mark.integration


def test_conjunctive_filters_count_page_and_historical_person_boundaries(event_world):
    world = event_world
    person = uuid4()  # A recorded historical ID has no User row.
    start = datetime(2030, 4, 5, tzinfo=UTC)
    ids = []
    tie_base = uuid4().int & ~3
    for index, (offset, outcome, actor, subject, kind) in enumerate(
        [
            (0, "failure", person, None, "internal.example"),
            (1, "failure", None, person, "internal.example"),
            (1, "failure", person, None, "internal.example"),
            (3, "failure", person, None, "internal.example"),
            (1, "success", person, None, "internal.example"),
            (1, "failure", person, None, "other.example"),
            (1, "failure", None, None, "internal.example"),
        ]
    ):
        ids.append(
            append_committed(
                event_type=kind,
                outcome=outcome,
                source="feed.fixture",
                operation_id=world.operation_id,
                actor_id=actor,
                subject_id=subject,
                occurred_at=start + timedelta(hours=offset),
                identity=UUID(int=tie_base + (2 if index == 1 else 1)) if index in [1, 2] else None,
            )
        )
    params = {
        "operation_id": str(world.operation_id),
        "event_type": "internal.example",
        "outcome": "failure",
        "person_id": str(person),
        "occurred_after": start.isoformat(),
        "occurred_before": (start + timedelta(hours=3)).isoformat(),
        "sort_by": "occurred_at",
        "sort_order": "asc",
        "limit": 2,
    }
    first = world.client.get("/api/security-events", params=params)
    assert first.status_code == 200
    body = first.json()
    assert body["pagination"]["total"] == 3
    assert [row["id"] for row in body["items"]] == [str(ids[0]), str(ids[2])]
    assert body["pagination"]["has_more"] is True
    second = world.client.get("/api/security-events", params={**params, "offset": 2})
    assert second.status_code == 200
    assert [row["id"] for row in second.json()["items"]] == [str(ids[1])]
    assert second.json()["pagination"]["total"] == 3
    assert second.json()["pagination"]["has_more"] is False
    searched = world.client.get("/api/security-events", params={**params, "search": "absent"})
    assert searched.status_code == 200 and searched.json()["pagination"]["total"] == 0


def test_feed_rejects_invalid_filters(event_world):
    # The other refused filters are stack-free rows of
    # tests/security_events/test_api.py::test_feed_rejects_invalid_filters_before_reading_events.
    params = {"occurred_after": "2030-04-06T00:00:00Z", "occurred_before": "2030-04-05T00:00:00Z"}
    result = event_world.client.get("/api/security-events", params=params)
    assert result.status_code == 422
    assert result.json() == {"detail": "Security event date range is inverted"}


def test_privileged_collection_detail_and_export_are_not_cached(event_world):
    world = event_world
    identity = append_committed(
        event_type="cache.fixture",
        outcome="success",
        source="feed.fixture",
        operation_id=world.operation_id,
    )
    for path in [
        "/api/security-events",
        "/api/security-events/export",
        f"/api/security-events/{identity}",
    ]:
        result = world.client.get(path)
        assert result.status_code == 200
        assert result.headers.get("cache-control") == "no-store"


@pytest.mark.parametrize("role", ["member", "guest"])
def test_real_account_without_admin_role_cannot_read_filtered_feed_detail_or_export(
    event_world, role
):
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.systems.access.users.membership import sole_active_membership
    from app.systems.access.users.models import Membership, User
    from app.systems.manage.workspace.models import WorkspaceProfile
    from tests.conftest import create_member

    world = event_world
    identity = append_committed(
        event_type="private.fixture",
        outcome="success",
        source="feed.fixture",
        operation_id=world.operation_id,
    )
    sponsor_id = uuid4()
    with Session(world.owner) as db:
        actor = db.get(User, world.actor_id)
        membership = sole_active_membership(db, actor.id)
        if role == "guest":
            create_member(
                    db, db.get(WorkspaceProfile, membership.org_id),
                    id=sponsor_id,
                    email=f"sponsor-{sponsor_id}@example.test",
                    username=f"sponsor-{sponsor_id.hex}",
                    status="active",
                    role="member",
                    supabase_user_id=uuid4(),
            )
            db.flush()
            membership.sponsor_user_id = sponsor_id
            membership.expires_at = datetime.now(UTC) + timedelta(days=1)
        membership.role = role
        db.commit()
    try:
        for path in [
            "/api/security-events?event_type=private.fixture",
            f"/api/security-events/{identity}",
            "/api/security-events/export",
        ]:
            response = world.client.get(path)
            assert response.status_code == 403
            assert "private.fixture" not in response.text
    finally:
        with Session(world.owner) as db:
            membership = sole_active_membership(db, world.actor_id)
            membership.role, membership.sponsor_user_id, membership.expires_at = "admin", None, None
            db.flush()
            if role == "guest":
                db.delete(db.scalar(select(Membership).where(
                    Membership.user_id == sponsor_id
                )))
                db.flush()
                db.delete(db.get(User, sponsor_id))
            db.commit()
