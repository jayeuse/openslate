"""Cross-user session collections use actual PostgreSQL paging and transactions."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users import sessions_router
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.access.user_admin_support import UserAdminWorld, add_session
from tests.access.user_admin_support import world as world
from tests.conftest import create_member, create_organization, guarded_create_engine
from tests.organization_scope_support import scoped_override
from tests.race_support import backend_pid, wait_until_blocked_by

pytestmark = pytest.mark.integration


def test_cross_user_session_collection_pages_and_filters_the_same_public_client_labels(
    world: UserAdminWorld,
) -> None:
    timestamp = datetime.now(UTC)
    current, mobile = world.sessions[world.admin.id], world.sessions[world.member.id]
    tablet = add_session(world.db, world.colleague)
    expired, revoked = (add_session(world.db, world.member) for _ in range(2))
    expired.expires_at = timestamp - timedelta(seconds=1)
    revoked.revoked_at = timestamp - timedelta(seconds=1)
    world.admin.display_name, world.member.display_name = "Session Alpha", "session Beta"
    for session in (current, mobile, tablet):
        session.refreshed_at = timestamp
    current.user_agent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0"
    mobile.user_agent = "Mozilla/5.0 (Linux; Android 14; Mobile) Chrome/128.0 Safari/537.36"
    tablet.user_agent = "Mozilla/5.0 (iPad) Version/17.0 Safari/605.1.15"
    world.db.commit()
    client = world.client(world.admin)
    client.app.dependency_overrides[get_current_identity] = scoped_override(
        lambda: CurrentIdentity(world.actor[0], current.id, False, False)
    )
    pages = [client.get(f"/api/auth/admin-sessions?limit=1&offset={offset}") for offset in range(3)]
    assert all(response.status_code == 200 for response in pages)
    assert [response.json()["items"][0]["id"] for response in pages] == [
        str(value) for value in sorted((current.id, mobile.id, tablet.id), reverse=True)
    ]
    assert [response.json()["pagination"]["has_more"] for response in pages] == [True, True, False]
    assert all(response.json()["pagination"]["total"] == 3 for response in pages)
    rows = client.get("/api/auth/admin-sessions?sort_by=person_name&sort_order=asc").json()["items"]
    assert [row["id"] for row in rows] == [str(current.id), str(mobile.id), str(tablet.id)]
    assert [(row["device"], row["browser"]) for row in rows] == [
        ("Desktop", "Firefox"),
        ("Mobile", "Chrome"),
        ("Tablet", "Safari"),
    ]
    assert rows[-1]["person_name"] == world.colleague.username
    assert rows[0]["refreshed_at"] == timestamp.isoformat().replace("+00:00", "Z")
    assert set(rows[0]) == {
        "id",
        "user_id",
        "person_name",
        "created_at",
        "refreshed_at",
        "expires_at",
        "user_agent",
        "ip_address",
        "device",
        "browser",
        "current",
    }
    assert all(row["ip_address"] is None for row in rows)
    current_page = client.get("/api/auth/admin-sessions?status=current").json()
    assert [row["id"] for row in current_page["items"]] == [str(current.id)]
    assert current_page["items"][0]["current"] is True
    remote_page = client.get("/api/auth/admin-sessions?status=remote").json()
    assert {row["id"] for row in remote_page["items"]} == {str(mobile.id), str(tablet.id)}
    for query, expected_id in (("device=Tablet", tablet.id), ("search=fIREFOX", current.id)):
        filtered = client.get(f"/api/auth/admin-sessions?{query}").json()
        assert [row["id"] for row in filtered["items"]] == [str(expected_id)]
    for invalid in ("device=Laptop", "status=ended", "sort_by=secret", "limit=101"):
        assert client.get(f"/api/auth/admin-sessions?{invalid}").status_code == 422


def test_bulk_session_end_rolls_back_then_preserves_current_and_records_events_once(
    world: UserAdminWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    timestamp = datetime.now(UTC)
    current, member = world.sessions[world.admin.id], world.sessions[world.member.id]
    other_admin = add_session(world.db, world.admin)
    expired, revoked = (add_session(world.db, world.member) for _ in range(2))
    expired.expires_at = timestamp - timedelta(seconds=1)
    revoked.revoked_at = timestamp - timedelta(seconds=1)
    world.db.commit()
    client = world.client(world.admin)
    client.app.dependency_overrides[get_current_identity] = scoped_override(
        lambda: CurrentIdentity(world.actor[0], current.id, False, False)
    )
    original_append = sessions_router.append_security_event

    def unavailable(*_args, **_kwargs):
        raise SQLAlchemyError("simulated persistence failure")

    monkeypatch.setattr(sessions_router, "append_security_event", unavailable)
    refused = client.delete("/api/auth/admin-sessions")
    assert refused.status_code == 503
    for session in (current, member, other_admin):
        world.db.refresh(session)
        assert session.revoked_at is None
    monkeypatch.setattr(sessions_router, "append_security_event", original_append)
    ended = client.delete("/api/auth/admin-sessions")
    assert ended.status_code == 204
    for session in (member, other_admin):
        world.db.refresh(session)
        assert session.revoked_at is not None
    ended_at = member.revoked_at, other_admin.revoked_at
    assert client.delete("/api/auth/admin-sessions").status_code == 204
    for session in (current, member, other_admin, expired, revoked):
        world.db.refresh(session)
    assert current.revoked_at is expired.revoked_at is None
    assert revoked.revoked_at == timestamp - timedelta(seconds=1)
    assert (member.revoked_at, other_admin.revoked_at) == ended_at
    events = world.db.scalars(
        select(SecurityEvent).where(
            SecurityEvent.actor_id == world.admin.id,
            SecurityEvent.event_type == "identity.session_revocation",
            SecurityEvent.source == "users.sessions",
        )
    ).all()
    assert len(events) == 2
    assert {event.subject_id for event in events} == {world.admin.id, world.member.id}
    assert all(event.event_metadata == {} for event in events)
    assert {event.labels["scope"] for event in events} == {"all", "others"}


def test_concurrent_bulk_session_end_records_each_target_only_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=3)
    admin_id, member_id, current_id, remote_id = (uuid7() for _ in range(4))
    with Session(owner) as db:
        organization = create_organization(db)
        org_id = organization.id
        for user_id, role in ((admin_id, "admin"), (member_id, "member")):
            create_member(
                    db, organization,
                    id=user_id,
                    email=f"sessions-{user_id.hex}@example.test",
                    username=f"sessions_{user_id.hex[:20]}",
                    role=role,
                    status="active",
            )
        db.flush()
        for session_id, user_id in ((current_id, admin_id), (remote_id, member_id)):
            db.add(
                IdentitySession(
                    id=session_id,
                    user_id=user_id,
                    refresh_token_digest=uuid7().hex * 2,
                    csrf_token_digest=uuid7().hex * 2,
                    expires_at=datetime.now(UTC) + timedelta(days=1),
                )
            )
        db.commit()
    first_paused, release_first, second_query_started, second_query_finished = (
        Event() for _ in range(4)
    )
    holder: list[int] = []
    original_append, original_scalars = sessions_router.append_security_event, AuditSession.scalars

    def paused_append(db, payload):
        if db.info.get("session_test_client") == "first":
            holder.append(backend_pid(db))
            first_paused.set()
            assert release_first.wait(timeout=5)
        return original_append(db, payload)

    def observed_scalars(db, statement, *args, **kwargs):
        is_second = db.info.get("session_test_client") == "second"
        describes_sessions = statement.column_descriptions[0].get("entity") is IdentitySession
        if is_second and describes_sessions:
            second_query_started.set()
        result = original_scalars(db, statement, *args, **kwargs)
        if is_second and describes_sessions:
            second_query_finished.set()
        return result

    monkeypatch.setattr(sessions_router, "append_security_event", paused_append)
    monkeypatch.setattr(AuditSession, "scalars", observed_scalars)
    application = FastAPI()
    application.include_router(sessions_router.auth_router, prefix="/api")

    def database(request: Request):
        with AuditSession(runtime) as db:
            db.info["session_test_client"] = request.headers.get("X-Test-Client")
            yield db

    application.dependency_overrides[get_db] = database
    application.dependency_overrides[get_current_identity] = scoped_override(
        lambda: CurrentIdentity(User(id=admin_id), current_id, False, False)
    )

    def end_sessions(tag: str) -> int:
        with TestClient(application, raise_server_exceptions=False) as client:
            return client.delete(
                "/api/auth/admin-sessions", headers={"X-Test-Client": tag}
            ).status_code

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(end_sessions, "first")
            assert first_paused.wait(timeout=5)
            second = executor.submit(end_sessions, "second")
            try:
                assert second_query_started.wait(timeout=5)
                wait_until_blocked_by(owner, holder[0])
                assert not second_query_finished.is_set()
            finally:
                release_first.set()
            assert first.result(timeout=5) == second.result(timeout=5) == 204
        with Session(owner) as db:
            assert db.get(IdentitySession, current_id).revoked_at is None
            assert db.get(IdentitySession, remote_id).revoked_at is not None
            assert (
                len(
                    db.scalars(
                        select(SecurityEvent).where(
                            SecurityEvent.actor_id == admin_id,
                            SecurityEvent.event_type == "identity.session_revocation",
                        )
                    ).all()
                )
                == 1
            )
    finally:
        release_first.set()
        application.dependency_overrides.clear()
        with Session(owner) as db:
            for event in db.scalars(
                select(SecurityEvent).where(SecurityEvent.actor_id == admin_id)
            ):
                db.delete(event)
            for session_id in (current_id, remote_id):
                session = db.get(IdentitySession, session_id)
                if session is not None:
                    db.delete(session)
            for user_id in (admin_id, member_id):
                for membership in db.scalars(
                    select(Membership).where(Membership.user_id == user_id)
                ):
                    db.delete(membership)
                db.flush()
                user = db.get(User, user_id)
                if user is not None:
                    db.delete(user)
            db.flush()
            db.delete(db.get(WorkspaceProfile, org_id))
            db.commit()
        runtime.dispose()
        owner.dispose()
