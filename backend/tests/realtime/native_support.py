"""Owned provider identities and real HTTP clients for S20 native proofs."""

import os
from dataclasses import dataclass
from secrets import token_urlsafe
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.config import get_settings
from app.core.config.instance import instance_identity_for_process
from app.core.database.organization_scope import scope_session
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.models import CommsConversationCounter
from tests.conftest import create_member, create_organization, guarded_create_engine


@dataclass(repr=False)
class NativePerson:
    id: UUID
    email: str
    password: str
    org: UUID


@dataclass(repr=False)
class NativeRoom:
    client: httpx.Client
    owner: object
    org: UUID
    other_org: UUID
    conversation: UUID
    conversations: list[UUID]
    people: list[NativePerson]
    headers: list[dict[str, str]]


def authenticate(client: httpx.Client, person: NativePerson) -> dict[str, str]:
    response = client.post(
        "/api/auth/token", json={"email": person.email, "password": person.password}
    )
    if response.status_code != 200:
        raise AssertionError("Owned native principal could not sign in")
    return {"Authorization": "Bearer " + response.json()["access_token"], "X-Org": str(person.org)}


@pytest.fixture
def native_room(request):
    if os.environ.get("OPENSLATE_COMMS_NATIVE_API") != "http://127.0.0.1:8008":
        raise RuntimeError("Use the guarded --comms-realtime-only runner")
    settings = get_settings()
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    client = httpx.Client(
        base_url=os.environ["OPENSLATE_COMMS_NATIVE_API"], timeout=15, trust_env=False
    )
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.headers["X-OpenSlate-Instance"] == instance_identity_for_process(dict(os.environ))
    provider = httpx.Client(
        base_url=settings.supabase_url + "/auth/v1/",
        timeout=15,
        trust_env=False,
        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
    )
    provider_ids, people, orgs = [], [], []
    count = getattr(request, "param", 7)
    assert count in (7, 300)
    conversations = [uuid7() for _ in range(18 if count == 300 else 1)]
    conversation = conversations[0]
    try:
        with Session(owner) as db:
            orgs = [create_organization(db).id, create_organization(db).id]
            db.commit()
        for index in range(count):
            email, password = f"native-{uuid4().hex}@example.test", "Native8!" + token_urlsafe(32)
            response = provider.post(
                "admin/users", json={"email": email, "password": password, "email_confirm": True}
            )
            assert response.status_code in {200, 201}, "Owned provider fixture creation failed"
            provider_ids.append(response.json()["id"])
            org = orgs[1] if count == 7 and index == 6 else orgs[0]
            with Session(owner) as db:
                from app.systems.manage.workspace.models import WorkspaceProfile

                user, _ = create_member(
                    db,
                    db.get(WorkspaceProfile, org),
                    "admin" if index == 0 else "member",
                    email=email,
                    username=f"native-{uuid4().hex}",
                    supabase_user_id=UUID(provider_ids[-1]),
                )
                people.append(NativePerson(user.id, email, password, org))
                db.commit()
        with Session(owner) as db:
            scope_session(db, orgs[0])
            for position, identity in enumerate(conversations):
                db.add(
                    CommsConversation(
                        id=identity,
                        org_id=orgs[0],
                        kind="channel",
                        scope="organization" if count == 300 else "members",
                        name=f"Native room {position}",
                        created_by=people[0].id,
                    )
                )
                db.flush()
                db.add(
                    CommsConversationCounter(org_id=orgs[0], conversation_id=identity, last_seq=0)
                )
                for index in (0, 1, 2, 4, 5):  # person3 is a nonmember in the private-room proof.
                    db.add(
                        CommsMember(
                            org_id=orgs[0], conversation_id=identity, user_id=people[index].id
                        )
                    )
            db.commit()
        headers = [authenticate(client, person) for person in people] if count == 7 else []
        yield NativeRoom(
            client, owner, orgs[0], orgs[1], conversation, conversations, people, headers
        )
    finally:
        client.close()
        for identity in provider_ids:
            assert provider.delete(f"admin/users/{identity}").status_code in {200, 204, 404}
        provider.close()
        with owner.begin() as connection:
            params = {"orgs": orgs, "users": [person.id for person in people]}
            for table in (
                "comms_templates",
                "comms_export_entries",
                "comms_export_sources",
                "scheduled_work",
                "comms_exports",
                "comms_schedules",
                "comms_retention_sweeps",
                "comms_retention_policies",
                "comms_expired_sends",
                "security_events",
                "in_app_notifications",
                "comms_reports",
                "comms_message_attachments",
                "comms_message_record_links",
                "comms_message_revisions",
                "comms_mentions",
                "comms_read_states",
                "comms_presence",
                "comms_typing",
                "comms_realtime_grants",
                "comms_realtime_admissions",
                "comms_messages",
                "files",
                "comms_settings",
                "comms_channel_access",
                "comms_capability_grants",
                "comms_setting_locks",
                "comms_members",
                "comms_conversation_counters",
                "comms_conversations",
                "comms_categories",
            ):
                connection.execute(text(f"DELETE FROM {table} WHERE org_id=ANY(:orgs)"), params)
            for sql in (
                "DELETE FROM lifecycle_rate_limit_failures WHERE org_id=ANY(:orgs)",
                "DELETE FROM lifecycle_rate_limit_buckets WHERE org_id=ANY(:orgs)",
                "DELETE FROM lifecycle_confirmation_challenges WHERE org_id=ANY(:orgs)",
                "DELETE FROM identity_sessions WHERE user_id=ANY(:users)",
                "DELETE FROM memberships WHERE org_id=ANY(:orgs)",
                "DELETE FROM audit_logs WHERE org_id=ANY(:orgs)",
                "DELETE FROM users WHERE id=ANY(:users)",
                "DELETE FROM organizations WHERE id=ANY(:orgs)",
            ):
                connection.execute(text(sql), params)
        owner.dispose()
