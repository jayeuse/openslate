"""Strict list-only directory projections and local inventory through real signed HTTP."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users import router as users_router
from app.systems.access.users.models import User
from app.systems.sandbox.departments.models import Department

pytest_plugins = ("tests.security_events.event_support",)
pytestmark = pytest.mark.integration


@pytest.fixture
def directory_world(event_world, monkeypatch):
    world = event_world
    monkeypatch.setattr(users_router, "utc_now", lambda: world.clock, raising=False)
    marker = f"directory-{uuid4().hex}"
    people = {}
    with Session(world.owner) as db:
        for key in (
            "active",
            "pending",
            "disabled",
            "expired",
            "deleted",
            "false",
            "unknown",
            "stale",
        ):
            user = User(
                id=uuid4(),
                email=f"{marker}-{key}@example.test",
                username=f"{marker}-{key}",
                display_name="Same" if key in {"active", "pending"} else key,
                job_title="Distinct searchable title" if key == "active" else None,
                role="admin" if key in {"false", "unknown", "stale"} else "member",
                status=key if key in {"pending", "disabled"} else "active",
                supabase_user_id=uuid4(),
                is_deleted=key == "deleted",
                deleted_at=world.clock if key == "deleted" else None,
                expires_at=world.clock
                if key == "expired"
                else None
                if key in {"false", "unknown", "stale"}
                else world.clock + timedelta(days=7),
            )
            db.add(user)
            people[key] = user.id
        group = Group(id=uuid4(), name=marker)
        department = Department(id=uuid4(), department_name=marker)
        db.add_all([group, department])
        db.flush()
        db.add(GroupAccess(group_id=group.id, department_id=department.id, level="read"))
        for key in ("active", "pending", "false"):
            db.add(GroupMember(group_id=group.id, user_id=people[key]))
        for key in ("false", "stale"):
            user = db.get(User, people[key])
            db.add(
                IdentityMfaObservation(
                    user_id=user.id,
                    observed_provider_user_id=user.supabase_user_id if key == "false" else uuid4(),
                    verified_totp=False,
                    observed_at=world.clock,
                )
            )
        db.commit()
        group_id, department_id = group.id, department.id
    try:
        yield SimpleNamespace(
            world=world,
            marker=marker,
            people=people,
            group_id=group_id,
            department_id=department_id,
        )
    finally:
        with Session(world.owner) as db:
            for row in db.scalars(select(GroupMember).where(GroupMember.group_id == group_id)):
                db.delete(row)
            for row in db.scalars(select(GroupAccess).where(GroupAccess.group_id == group_id)):
                db.delete(row)
            db.delete(db.get(Group, group_id))
            db.delete(db.get(Department, department_id))
            for row in db.scalars(select(User).where(User.id.in_(people.values()))):
                db.delete(row)
            db.commit()


def get_rows(context, **params):
    response = context.world.client.get(
        "/api/users", params={"search": context.marker, "deleted": "include", **params}
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_list_projection_counts_local_admission_rules_at_one_query_instant(directory_world):
    context = directory_world
    world = context.world
    world.policy(session_absolute_lifetime_minutes=120, mfa_require_member=True)
    with Session(world.owner) as db:
        person = db.get(User, context.people["active"])
        for kind in (
            "active",
            "pending_mfa",
            "revoked",
            "idle_boundary",
            "absolute_boundary",
            "expired",
            "wrong_binding",
        ):
            db.add(
                IdentitySession(
                    user_id=person.id,
                    provider_user_id=uuid4()
                    if kind == "wrong_binding"
                    else person.supabase_user_id,
                    provider_session_id=uuid4(),
                    refresh_token_digest=uuid4().hex * 2,
                    csrf_token_digest=uuid4().hex * 2,
                    created_at=world.clock
                    - timedelta(minutes=120 if kind == "absolute_boundary" else 1),
                    refreshed_at=world.clock
                    - timedelta(minutes=60 if kind == "idle_boundary" else 1),
                    expires_at=world.clock
                    if kind == "expired"
                    else world.clock + timedelta(hours=1),
                    revoked_at=world.clock if kind == "revoked" else None,
                )
            )
        for key in ("pending", "disabled", "expired", "deleted"):
            person = db.get(User, context.people[key])
            db.add(
                IdentitySession(
                    user_id=person.id,
                    provider_user_id=person.supabase_user_id,
                    provider_session_id=uuid4(),
                    refresh_token_digest=uuid4().hex * 2,
                    csrf_token_digest=uuid4().hex * 2,
                    created_at=world.clock,
                    refreshed_at=world.clock,
                    expires_at=world.clock + timedelta(hours=1),
                )
            )
        db.commit()
    items = {UUID(row["id"]): row for row in get_rows(context)["items"]}
    assert items[context.people["active"]].get("active_session_count") == 2
    for key in ("pending", "disabled", "expired", "deleted"):
        assert items[context.people[key]]["active_session_count"] == 0
    assert items[context.people["false"]]["mfa_verified_totp"] is False
    assert items[context.people["unknown"]]["mfa_verified_totp"] is None
    assert items[context.people["stale"]]["mfa_verified_totp"] is None
    assert items[context.people["stale"]]["mfa_observed_at"] is None
    assert all("observed_provider_user_id" not in row for row in items.values())
    detail = world.client.get(f"/api/users/{context.people['active']}").json()
    assert not {"active_session_count", "mfa_verified_totp", "mfa_observed_at"} & detail.keys()


@pytest.mark.parametrize(
    "status,expected",
    [
        ("active", {"active", "false", "unknown", "stale"}),
        ("pending", {"pending"}),
        ("disabled", {"disabled"}),
        ("expired", {"expired"}),
        ("ending", {"active", "pending"}),
    ],
)
def test_server_status_precedence_and_ending_match_the_designed_directory(
    directory_world, status, expected
):
    context = directory_world
    body = get_rows(context, status=status, limit=1)
    assert body["pagination"]["total"] == len(expected)
    complete = get_rows(context, status=status, limit=100)
    assert {UUID(row["id"]) for row in complete["items"]} == {
        context.people[key] for key in expected
    }


def test_membership_filters_search_stable_pages_and_deleted_complete_catalog(directory_world):
    context = directory_world
    for params in (
        {"group_id": str(context.group_id)},
        {"department_id": str(context.department_id)},
    ):
        body = get_rows(context, limit=1, **params)
        assert body["pagination"]["total"] == 2  # Administrators project no group/department rows.
        rows = get_rows(context, limit=100, **params)["items"]
        assert {UUID(row["id"]) for row in rows} == {
            context.people["active"],
            context.people["pending"],
        }
    no_group = get_rows(context, group_id="none")["items"]
    assert {UUID(row["id"]) for row in no_group} == {
        context.people[key] for key in ("disabled", "expired", "deleted")
    }
    search = context.world.client.get("/api/users", params={"search": "Distinct searchable title"})
    assert [UUID(row["id"]) for row in search.json()["items"]] == [context.people["active"]]
    pages = [
        get_rows(context, limit=1, offset=i, sort_by="name")["items"][0]["id"] for i in range(8)
    ]
    assert len(set(pages)) == 8
    expected = sorted(
        context.people,
        key=lambda key: (
            "same" if key in {"active", "pending"} else key,
            f"{context.marker}-{key}",
            str(context.people[key]),
        ),
    )
    assert pages == [str(context.people[key]) for key in expected]
    deleted = get_rows(context, deleted="only")
    assert [row["id"] for row in deleted["items"]] == [str(context.people["deleted"])]
    assert context.world.client.get(f"/api/users/{context.people['deleted']}").status_code == 404
    # Preserved same-binding soft deletion is not evidence of factor removal.
    with Session(context.world.owner) as db:
        user = db.get(User, context.people["false"])
        row = db.get(IdentityMfaObservation, user.id)
        before = row.observed_provider_user_id, row.verified_totp, row.observed_at
        user.is_deleted, user.deleted_at = True, context.world.clock
        db.commit()
    archived = next(
        row for row in get_rows(context)["items"] if UUID(row["id"]) == context.people["false"]
    )
    assert archived["mfa_verified_totp"] is False and archived["mfa_observed_at"] is not None
    with Session(context.world.owner) as db:
        user = db.get(User, context.people["false"])
        user.is_deleted, user.deleted_at = False, None
        db.commit()
        row = db.get(IdentityMfaObservation, user.id)
        assert (row.observed_provider_user_id, row.verified_totp, row.observed_at) == before


def test_mfa_summary_is_global_and_its_card_predicates_are_the_same_rows(directory_world):
    context = directory_world
    client = context.world.client
    summary = client.get("/api/users/summary")
    assert summary.status_code == 200
    assert summary.headers["cache-control"] == "no-store"
    assert set(summary.json()) == {
        "admins_without_mfa",
        "admins_mfa_unknown",
        "no_recorded_sign_in",
        "inactive_people",
        "as_of",
        "inactive_days",
    }
    for kind, field, expected in (
        ("without", "admins_without_mfa", {"false"}),
        ("unknown", "admins_mfa_unknown", {"unknown", "stale"}),
    ):
        global_rows = client.get("/api/users", params={"mfa": kind, "limit": 1}).json()
        assert summary.json()[field] == global_rows["pagination"]["total"]
        filtered = get_rows(context, mfa=kind)
        assert {UUID(row["id"]) for row in filtered["items"]} == {
            context.people[key] for key in expected
        }


@pytest.mark.parametrize(
    "params",
    [
        {"status": "invented"},
        {"group_id": "invalid"},
        {"department_id": "invalid"},
        {"mfa": "invented"},
        {"sort_by": "last_active_at"},
    ],
)
def test_directory_rejects_unlisted_filters_without_history_fields(directory_world, params):
    assert directory_world.world.client.get("/api/users", params=params).status_code == 422


def test_all_session_readers_serialize_actual_driver_ip_values(event_world):
    client = event_world.client
    self_rows = client.get("/api/auth/sessions").json()
    current = next(row for row in self_rows if row["current"])
    assert current.get("ip_address") == "127.0.0.1"
    with Session(event_world.owner) as db:
        row = db.get(IdentitySession, UUID(current["id"]))
        row.ip_address = "2001:db8::5"
        db.commit()
    routes = (
        "/api/auth/sessions",
        f"/api/users/{event_world.actor_id}/sessions",
        "/api/auth/admin-sessions",
    )
    for path in routes:
        response = client.get(path)
        assert response.status_code == 200
        rows = response.json() if isinstance(response.json(), list) else response.json()["items"]
        assert (
            next(row for row in rows if row["id"] == current["id"])["ip_address"] == "2001:db8::5"
        )


@pytest.mark.parametrize(
    "peer,expected",
    [
        ("192.0.2.21", "192.0.2.21"),
        ("2001:db8::21", "2001:db8::21"),
        ("::ffff:192.0.2.21", "192.0.2.21"),
        (None, None),
    ],
)
def test_committed_signin_records_only_the_canonical_transport_peer(event_world, peer, expected):
    with event_world.anonymous(peer) as client:
        client.headers["X-Forwarded-For"] = "198.51.100.99"
        response = client.post(
            "/api/auth/login", json={"email": event_world.email, "password": event_world.password}
        )
        assert response.status_code == 200
        rows = client.get("/api/auth/sessions").json()
        assert next(row for row in rows if row["current"])["ip_address"] == expected


def test_recorded_history_summary_and_drilldowns_use_the_same_known_population(directory_world):
    from datetime import datetime

    context = directory_world
    world = context.world
    values = {
        "active": (-45, -31),
        "false": (None, None),
        "unknown": (None, -2),
        "stale": (-1, -30),
        "pending": (None, -60),
        "disabled": (None, -60),
        "expired": (None, -60),
        "deleted": (None, -60),
    }
    with Session(world.owner) as db:
        for key, (signin, active) in values.items():
            row = db.get(IdentityMfaObservation, context.people[key])
            if row is None:
                row = IdentityMfaObservation(user_id=context.people[key])
                db.add(row)
            row.last_sign_in_at = None if signin is None else world.clock + timedelta(days=signin)
            row.last_active_at = None if active is None else world.clock + timedelta(days=active)
        db.commit()
    response = world.client.get("/api/users/summary")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    summary = response.json()
    assert summary.get("inactive_days") == 30
    assert datetime.fromisoformat(summary["as_of"].replace("Z", "+00:00")) == world.clock
    for kind, field, expected in [
        ("no-recorded-sign-in", "no_recorded_sign_in", {"false", "unknown"}),
        ("inactive", "inactive_people", {"active"}),
    ]:
        global_rows = world.client.get("/api/users", params={"history": kind, "limit": 1}).json()
        assert global_rows["pagination"]["total"] == summary[field]
        page = get_rows(context, history=kind, limit=1)
        assert page["pagination"]["total"] == len(expected)
        complete = get_rows(context, history=kind, limit=100)
        assert {UUID(row["id"]) for row in complete["items"]} == {
            context.people[key] for key in expected
        }
    row = next(
        item for item in get_rows(context)["items"] if item["id"] == str(context.people["stale"])
    )
    assert {"last_sign_in_at", "last_active_at"} <= row.keys()
    assert row["mfa_verified_totp"] is None and row["last_active_at"] is not None
    assert "last_sign_in_at" in row
    # Threshold is echoed, cutoff is exclusive, and null activity is never inactive.
    assert get_rows(context, history="inactive", inactive_days=31)["items"] == []
    shorter = world.client.get("/api/users/summary", params={"inactive_days": "1"}).json()
    assert shorter["inactive_days"] == 1
    assert (
        shorter["inactive_people"]
        == world.client.get(
            "/api/users", params={"history": "inactive", "inactive_days": "1", "limit": 1}
        ).json()["pagination"]["total"]
    )
    detail = world.client.get(f"/api/users/{context.people['active']}").json()
    assert not {"last_sign_in_at", "last_active_at"} & detail.keys()
    assert (
        not {"last_sign_in_at", "last_active_at"} & world.client.get("/api/auth/me").json().keys()
    )


@pytest.mark.parametrize("path", ["/api/users", "/api/users/summary"])
@pytest.mark.parametrize("value", ["0", "3651", "true", "false", "1.5", "30.0"])
def test_recorded_history_days_reject_noninteger_and_out_of_range_queries(
    directory_world, path, value
):
    assert (
        directory_world.world.client.get(path, params={"inactive_days": value}).status_code == 422
    )


def test_recorded_history_endpoints_retain_exact_admin_admission(directory_world):
    world = directory_world.world
    with Session(world.owner) as db:
        actor = db.get(User, world.actor_id)
        actor.role = "member"
        db.commit()
    try:
        for path in ("/api/users", "/api/users/summary"):
            response = world.client.get(
                path,
                params={"history": "inactive", "inactive_days": "30"}
                if path.endswith("users")
                else {"inactive_days": "30"},
            )
            assert response.status_code == 403
    finally:
        with Session(world.owner) as db:
            db.get(User, world.actor_id).role = "admin"
            db.commit()
