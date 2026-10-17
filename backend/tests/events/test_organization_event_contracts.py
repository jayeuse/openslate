"""Organization and account event contracts on owned disposable PostgreSQL data."""

import asyncio
import json
from dataclasses import dataclass
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Membership, PlatformOperator, User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from app.systems.platform.events import publisher
from app.systems.platform.events import router as events_router
from app.systems.platform.events.hub import EventHub
from app.systems.platform.events.models import event_for_entity, parse_invalidation_payload
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import create_member, membership_of
from tests.fake_provider_support import owned_account

pytest_plugins = ("tests.fake_provider_support",)
pytestmark = pytest.mark.integration


@dataclass
class EventWorld:
    owner: Engine
    a_id: UUID
    b_id: UUID
    admin_a: UUID
    shared_b: UUID
    foreign_b: UUID
    client_a: TestClient
    client_b: TestClient

    def principal(self, *, other=False, explicit=True):
        client = self.client_b if other else self.client_a
        return events_router.EventPrincipal(
            client.cookies["openslate_access"], "127.0.0.1",
            (self.b_id if other else self.a_id) if explicit else None,
        )


@pytest.fixture
def other_account(fake_provider):
    yield from owned_account(fake_provider)


@pytest.fixture
def event_world(fake_provider_account, other_account):
    email_a, password_a, provider_a, admin_a, owner = fake_provider_account
    email_b, password_b, provider_b, shared_b, _ = other_account
    with Session(owner) as db:
        password_minimum = db.scalar(select(PlatformSettings)).password_min_length
        a_id, b_id = (membership_of(db, user_id).org_id for user_id in (admin_a, shared_b))
        for user_id, provider_id, org_id in (
            (admin_a, provider_a, a_id), (shared_b, provider_b, b_id),
        ):
            db.get(User, user_id).supabase_user_id = provider_id
            membership_of(db, user_id).role = "admin"
            db.get(WorkspaceProfile, org_id).owner_user_id = user_id
        db.delete(db.scalar(select(PlatformOperator).where(PlatformOperator.user_id == admin_a)))
        _, shared = create_member(db, db.get(WorkspaceProfile, a_id), user=db.get(User, shared_b))
        shared_id = shared.id
        foreign, foreign_membership = create_member(db, db.get(WorkspaceProfile, b_id))
        foreign_id, foreign_membership_id = foreign.id, foreign_membership.id
        db.commit()
    clients = []
    try:
        for email, password, org_id in ((email_a, password_a, a_id), (email_b, password_b, b_id)):
            client = TestClient(
                create_app(), base_url=get_settings().public_origin, client=("127.0.0.1", 50000),
            )
            clients.append(client)
            client.headers["Origin"] = get_settings().public_origin
            login = client.post("/api/auth/login", json={"email": email, "password": password})
            assert login.status_code == 200, login.text
            client.headers["X-CSRF-Token"] = client.cookies["openslate_csrf"]
            client.headers["X-Org"] = str(org_id)
        yield EventWorld(owner, a_id, b_id, admin_a, shared_b, foreign_id, *clients)
    finally:
        for client in clients:
            client.close()
        with Session(owner) as db:
            db.scalar(select(PlatformSettings)).password_min_length = password_minimum
            db.delete(db.get(Membership, shared_id))
            db.delete(db.get(Membership, foreign_membership_id))
            db.flush()
            db.delete(db.get(User, foreign_id))
            for membership in db.scalars(select(Membership).where(
                Membership.user_id == admin_a, Membership.org_id == b_id,
            )):
                db.delete(membership)
            db.commit()


def _capture_notifies(monkeypatch):
    """Keep real runtime-role publication and membership reads; capture only NOTIFY bytes."""
    connect = publisher.psycopg.connect
    payloads = []

    class Connection:
        def __init__(self, *args, **kwargs):
            self.connection = connect(*args, **kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def execute(self, query, parameters=None):
            if query == "SELECT pg_notify(%s, %s)":
                payloads.append(json.loads(parameters[1]))
            return self.connection.execute(query, parameters)

    monkeypatch.setattr(publisher.psycopg, "connect", Connection)
    return payloads


def test_account_invalidations_fan_out_at_publish_time_only_to_member_organizations(
    event_world, monkeypatch,
):
    world = event_world
    payloads = _capture_notifies(monkeypatch)
    with AuditSession(get_engine()) as db:
        db.get(User, world.shared_b).display_name = "Shared account changed"
        db.commit()
    shared_payloads = [payload for payload in payloads if payload["entity"] == "users"]
    assert {payload.get("org_id") for payload in shared_payloads} == {
        str(world.a_id), str(world.b_id),
    }
    assert len(shared_payloads) == 2
    # Memberships are resolved during publication, not cached on the audit event.
    payloads.clear()
    with AuditSession(get_engine()) as db:
        db.get(User, world.admin_a).display_name = "A-only account changed"
        db.commit()
    account_payloads = [payload for payload in payloads if payload["entity"] == "users"]
    assert len(account_payloads) == 1 and account_payloads[0]["org_id"] == str(world.a_id)
    payloads.clear()
    with AuditSession(get_engine()) as db:
        db.get(User, world.foreign_b).display_name = "B-only account changed"
        db.commit()
    foreign_payloads = [payload for payload in payloads if payload["entity"] == "users"]
    assert foreign_payloads == [{
        "entity": "users", "entity_id": str(world.foreign_b), "org_id": str(world.b_id),
    }]

    async def exercise():
        hub = EventHub()
        admin_a = await events_router.reauthorize_event_principal(world.principal())
        admin_b = await events_router.reauthorize_event_principal(world.principal(other=True))
        assert admin_a is not None and admin_a.role == "admin"
        assert admin_b is not None and admin_b.role == "admin"
        a, b = await hub.subscribe(admin_a), await hub.subscribe(admin_b)
        for payload in shared_payloads + account_payloads + foreign_payloads:
            await hub.publish_notification(payload)
        assert [a.queue.get_nowait().entity_id for _ in range(a.queue.qsize())] == [
            world.shared_b, world.admin_a,
        ]
        assert [b.queue.get_nowait().entity_id for _ in range(b.queue.qsize())] == [
            world.shared_b, world.foreign_b,
        ]
        raw = event_for_entity("users", world.shared_b)
        assert raw is not None
        assert not hub.can_receive(a, raw)
        assert not hub.can_receive(b, raw)
        for subscription in (a, b):
            await hub.unsubscribe(subscription)

    asyncio.run(exercise())


def test_installation_invalidations_are_operator_only_and_recipient_routing_is_unchanged(
    event_world,
):
    async def exercise():
        hub = EventHub()
        a = await hub.subscribe(await events_router.reauthorize_event_principal(
            event_world.principal(),
        ))
        b = await hub.subscribe(await events_router.reauthorize_event_principal(
            event_world.principal(other=True),
        ))
        for entity in ("platform_settings", "backup_policies", "backup_runs"):
            event = event_for_entity(entity)
            await hub.publish_notification(event.to_transport_json())
            assert a.queue.empty()
            assert b.queue.get_nowait().entity == entity
        notice = event_for_entity("in_app_notifications", recipient_id=event_world.admin_a)
        await hub.publish_notification(notice.to_transport_json())
        assert a.queue.get_nowait().to_payload() == {"entity": "in_app_notifications"}
        assert b.queue.empty()
        await hub.publish_resync()
        assert a.queue.get_nowait() is None and b.queue.get_nowait() is None
        with Session(event_world.owner) as db:
            db.delete(db.scalar(select(PlatformOperator).where(
                PlatformOperator.user_id == event_world.shared_b,
            )))
            db.commit()
        refreshed = await events_router.reauthorize_event_principal(
            event_world.principal(other=True),
        )
        assert refreshed is not None and refreshed.operator is False
        assert hub.refresh_subscription(b, refreshed)
        await hub.publish_notification(event_for_entity("backup_runs").to_transport_json())
        assert a.queue.empty() and b.queue.empty()
        await hub.unsubscribe(a)
        await hub.unsubscribe(b)

    asyncio.run(exercise())


def test_account_file_invalidations_use_creator_memberships_without_exposing_the_creator(
    event_world, monkeypatch,
):
    payloads = _capture_notifies(monkeypatch)
    file_id = None
    try:
        with AuditSession(get_engine()) as db:
            file = File(
                creator_id=event_world.admin_a, purpose="user_avatar", filename="avatar.png",
                expected_size=10, object_key=f"user/{event_world.admin_a}/test-event",
            )
            db.add(file)
            db.flush()
            file_id = file.id
            db.commit()
        assert payloads == [{"entity": "files", "org_id": str(event_world.a_id)}]
        assert parse_invalidation_payload(payloads[0]).to_payload() == {"entity": "files"}
    finally:
        if file_id is not None:
            with Session(event_world.owner) as db:
                db.delete(db.get(File, file_id))
                db.commit()


def test_organization_settings_keep_the_workspace_wire_name_for_members(event_world, monkeypatch):
    world = event_world
    payloads = _capture_notifies(monkeypatch)
    with Session(world.owner) as db:
        membership_of(db, world.admin_a).role = "member"
        db.commit()
    with AuditSession(get_engine()) as db:
        db.get(WorkspaceProfile, world.a_id).week_start = "sunday"
        db.commit()
    assert payloads == [{"entity": "workspace_profiles", "org_id": str(world.a_id)}]

    async def exercise():
        viewer = await events_router.reauthorize_event_principal(world.principal())
        assert viewer is not None and viewer.role == "member"
        hub = EventHub()
        subscription = await hub.subscribe(viewer)
        await hub.publish_notification(payloads[0])
        assert subscription.queue.get_nowait().to_payload() == {"entity": "workspace_profiles"}
        await hub.unsubscribe(subscription)

    asyncio.run(exercise())


@pytest.mark.parametrize("change", ["organization", "platform", "mixed", "export"])
def test_shared_actor_events_keep_their_producer_scope_across_all_read_surfaces(
    event_world, change,
):
    world = event_world
    # A is admitted as its own administrator, with no membership in B.
    assert world.client_a.get("/api/workspace/security").status_code == 200
    module_id = None
    department_id = None
    try:
        if change == "export":
            with Session(world.owner) as db:
                department = Department(org_id=world.b_id, department_name="Private B exports")
                db.add(department)
                db.flush()
                module = Module(org_id=world.b_id, department_id=department.id, module_name="B")
                db.add(module)
                db.commit()
                module_id, department_id = module.id, department.id
            result = world.client_b.post("/api/records/export", json={
                "module_id": str(module_id), "definition": {"columns": []},
                "include_record_id": True,
            })
            event_type = "records.export.authorized"
        else:
            initial = world.client_b.get("/api/workspace/security").json()
            fields = {}
            if change in {"organization", "mixed"}:
                fields["mfa_grace_days"] = 3
            if change in {"platform", "mixed"}:
                fields["password_min_length"] = initial["password_min_length"] + 1
            result = world.client_b.patch("/api/workspace/security", json={
                "revision": initial["revision"], **fields,
            })
            event_type = "workspace.security_policy_change"
        assert result.status_code == 200, result.text
        with Session(world.owner) as db:
            rows = list(db.scalars(select(SecurityEvent).where(
                SecurityEvent.actor_id == world.shared_b, SecurityEvent.event_type == event_type,
            )))
        assert len(rows) == (2 if change == "mixed" else 1)
        expected_scopes = ({None, world.b_id} if change == "mixed" else
                           {None} if change == "platform" else {world.b_id})
        assert {row.org_id for row in rows} == expected_scopes
        for row in rows:
            if change == "mixed":
                assert row.event_metadata["changed_fields"] == (
                    ["password_min_length"] if row.org_id is None else ["mfa_grace_days"]
                )
            query = f"operation_id={row.operation_id}"
            for client, visible in ((world.client_a, False), (world.client_b, True)):
                listed = client.get(f"/api/security-events?{query}")
                exported = client.get(f"/api/security-events/export?{query}")
                detail = client.get(f"/api/security-events/{row.id}")
                assert listed.status_code == exported.status_code == 200
                assert (str(row.id) in {item["id"] for item in listed.json()["items"]}) is visible
                assert (str(row.id) in {item["id"] for item in exported.json()}) is visible
                assert detail.status_code == (200 if visible else 404), detail.text
    finally:
        with Session(world.owner) as db:
            if module_id is not None:
                db.delete(db.get(Module, module_id))
                db.flush()
                db.delete(db.get(Department, department_id))
            db.commit()


def test_implicit_stream_stays_in_its_initial_org_and_closes_if_that_membership_is_lost(
    event_world,
):
    world = event_world
    with Session(world.owner) as db:
        create_member(db, db.get(WorkspaceProfile, world.b_id), "admin",
                      user=db.get(User, world.admin_a))
        identity = db.scalar(select(IdentitySession).where(
            IdentitySession.user_id == world.admin_a,
        ))
        identity.active_org_id = world.a_id
        identity_id = identity.id
        db.commit()

    async def exercise():
        hub = EventHub()

        async def connected():
            return False

        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(events_hub=hub)), is_disconnected=connected,
        )
        response = await events_router.events(request, world.principal(explicit=False))
        stream = response.body_iterator
        try:
            assert await anext(stream) == b"event: resync\ndata: {}\n\n"
            with Session(world.owner) as db:
                db.get(IdentitySession, identity_id).active_org_id = world.b_id
                db.commit()
            await hub.publish_resync()
            assert await anext(stream) == b"event: resync\ndata: {}\n\n"
            await hub.publish(event_for_entity("departments", org_id=world.a_id))
            await hub.publish_resync()  # deterministic end marker if A's event was wrongly filtered
            assert await asyncio.wait_for(anext(stream), 5) == (
                b'event: invalidate\ndata: {"entity":"departments"}\n\n'
            )
            with Session(world.owner) as db:
                member = db.scalar(select(Membership).where(
                    Membership.user_id == world.admin_a, Membership.org_id == world.a_id,
                ))
                member.status = "disabled"
                db.commit()
            with pytest.raises(StopAsyncIteration):
                await asyncio.wait_for(anext(stream), 5)
        finally:
            await stream.aclose()
        assert hub.subscriber_count == 0

    asyncio.run(exercise())
