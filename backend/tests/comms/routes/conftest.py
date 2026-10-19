"""Shared committed-data fixtures for Comms route integration tests."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from threading import Barrier
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends, Request
from fastapi.testclient import TestClient
from sqlalchemy import select
from uuid6 import uuid7

from app.common.dependencies.auth import (
    CurrentIdentity,
    get_account_identity,
    get_account_user,
    get_current_user,
)
from app.core.config import get_settings
from app.core.database.session import AuditSession, get_db
from app.core.integrations.supabase_auth import ProviderUser
from app.main import create_app
from app.systems.access.identity.provider_user_cache import remember_provider_user
from app.systems.access.policy.models import GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsConversationGroup,
    CommsMember,
)
from app.systems.comms.messages.interaction_models import CommsMention, CommsThread
from app.systems.comms.messages.models import (
    CommsConversationCounter,
    CommsMessage,
    CommsReadState,
)
from app.systems.comms.settings.models import (
    CommsCapabilityGrant,
    CommsMemberPreferences,
    CommsSettings,
)
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext, set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.comms.conftest import NOW, CommsWorld
from tests.conftest import create_member

FUTURE = datetime(2100, 1, 1, tzinfo=UTC)


@dataclass
class MessageRoutes:
    world: CommsWorld
    clients: list[TestClient] = field(default_factory=list)

    def anonymous_client(self, org: UUID) -> TestClient:
        client = TestClient(create_app(), base_url=get_settings().public_origin)
        client.headers["X-Org"] = str(org)
        self.clients.append(client)
        return client

    def client(
        self, actor: UUID, org: UUID, *, request_gate: Barrier | None = None,
    ) -> TestClient:
        application = create_app()

        def database(request: Request) -> Iterator[AuditSession]:
            # No prebound org, shared Session, savepoint, commit or forced rollback.
            # The real membership dependency must bind X-Org before domain access.
            with AuditSession(self.world.runtime) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=uuid7(), request_method=request.method,
                    request_path=request.url.path,
                )
                yield db

        def account(db: Annotated[AuditSession, Depends(get_db)]) -> CurrentIdentity:
            user = db.get(User, actor, populate_existing=True)
            assert user is not None and user.supabase_user_id is not None
            # Only the authenticated-principal boundary is supplied, NOT membership
            # or policy. Refresh the positive cache per request; no provider traffic.
            remember_provider_user(ProviderUser(user.supabase_user_id, None, user.email))
            set_audit_actor(db, user.id)
            if request_gate is not None:
                # The real User SELECT has opened this request's DB transaction.
                # Rendezvous before real membership/route work; no write or XID assignment.
                request_gate.wait(timeout=20)
            return CurrentIdentity(user, uuid7(), False, False)

        def current_user(
            identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
        ) -> User:
            return get_account_user(identity)

        application.dependency_overrides[get_db] = database
        application.dependency_overrides[get_account_identity] = account
        application.dependency_overrides[get_current_user] = current_user
        # No context-manager entry: do not start production background workers.
        client = TestClient(application, base_url=get_settings().public_origin)
        client.headers["X-Org"] = str(org)
        self.clients.append(client)
        return client

    def seed_roots(self, count: int = 3) -> None:
        """Incoming messages; only seq2 mentions the peer. Fixture, not send evidence."""
        org = self.world.first
        conversation = org.conversation
        identities = {seq: uuid7() for seq in range(1, count + 1)}
        with self.world.session(org) as db:
            for seq, identity in identities.items():
                db.add(CommsMessage(
                    id=identity, org_id=org.id, conversation_id=conversation,
                    author_id=org.author, client_key=uuid7(), seq=seq,
                    body=f"Private bootstrap body {seq}", send_fingerprint="a" * 64,
                    created_at=NOW + timedelta(seconds=seq),
                ))
            db.flush()
            db.add(CommsMention(org_id=org.id, message_id=identities[2], user_id=org.peer))
            counter = db.scalars(select(CommsConversationCounter).where(
                CommsConversationCounter.org_id == org.id,
                CommsConversationCounter.conversation_id == conversation,
            )).one()
            counter.last_seq = count
            db.commit()

    def seed_timeline(self) -> dict[int, UUID]:
        org = self.world.first
        identities = {seq: uuid7() for seq in (1, 3, 7, 9, 12)}
        with self.world.session(org) as db:
            for seq, identity in identities.items():
                row = CommsMessage(
                    id=identity, org_id=org.id, conversation_id=org.conversation,
                    author_id=org.author, client_key=uuid7(), seq=seq,
                    body=f"Timeline body {seq}", send_fingerprint="b" * 64,
                    created_at=NOW + timedelta(seconds=seq),
                    parent_id=identities[1] if seq in (9, 12) else None,
                    also_send_to_channel=seq == 9,
                )
                if seq == 1:
                    row.reply_count, row.last_reply_at = 2, NOW + timedelta(seconds=12)
                if seq == 7:
                    row.is_deleted, row.deleted_at, row.deleted_by = True, NOW, org.author
                db.add(row)
                db.flush()  # Root exists before its reply references.
                db.add(CommsMention(org_id=org.id, message_id=identity, user_id=org.peer))
            db.add(CommsThread(
                org_id=org.id, conversation_id=org.conversation, root_message_id=identities[1],
            ))
            counter = db.scalars(select(CommsConversationCounter).where(
                CommsConversationCounter.org_id == org.id,
                CommsConversationCounter.conversation_id == org.conversation,
            )).one()
            counter.last_seq = 12
            db.commit()
        return identities

    def seed_read_state(self, actor: UUID, seq: int, *, manual_unread: bool = False) -> None:
        org = self.world.first
        with self.world.session(org) as db:
            db.add(CommsReadState(
                org_id=org.id, conversation_id=org.conversation, user_id=actor, last_read_seq=seq,
            ))
            db.add(CommsMemberPreferences(
                org_id=org.id, conversation_id=org.conversation, user_id=actor,
                notify="all", mute="off", starred=False, hidden=False, manual_unread=manual_unread,
            ))
            db.commit()

    def seed_more_conversations(self, count: int = 25) -> list[UUID]:
        """Cross the ordinary 25-item page boundary without creating S17 category APIs."""
        org = self.world.first
        identities = [uuid7() for _ in range(count)]
        with self.world.session(org) as db:
            for index, identity in enumerate(identities):
                db.add(CommsConversation(
                    id=identity, org_id=org.id, kind="channel", scope="organization",
                    name=f"More {index}", position=index + 2, created_by=org.author,
                    category_id=org.category, created_at=NOW, updated_at=NOW,
                ))
                db.flush()
                db.add(CommsConversationCounter(
                    org_id=org.id, conversation_id=identity, last_seq=0,
                ))
                for actor in (org.author, org.peer):
                    db.add(CommsMember(
                        org_id=org.id, conversation_id=identity, user_id=actor, joined_at=NOW,
                    ))
            db.commit()
        return identities

    def seed_large_history(self, count: int = 100_000) -> dict[int, UUID]:
        org, identities = self.world.first, {}
        with self.world.owner.begin() as connection:
            for start in range(1, count + 1, 1000):
                rows = []
                for seq in range(start, min(start + 1000, count + 1)):
                    identity = uuid7()
                    if seq > count - 50:
                        identities[seq] = identity
                    rows.append({
                        "id": identity, "org_id": org.id, "conversation_id": org.conversation,
                        "author_id": org.author, "client_key": uuid7(), "seq": seq,
                        "body": "Large history sample", "send_fingerprint": "c" * 64,
                        "created_at": NOW - timedelta(seconds=count - seq),
                    })
                connection.execute(CommsMessage.__table__.insert(), rows)
            connection.execute(CommsConversationCounter.__table__.update().where(
                CommsConversationCounter.org_id == org.id,
                CommsConversationCounter.conversation_id == org.conversation,
            ).values(last_seq=count))
        return identities

    def hide_other_conversation(self) -> None:
        org = self.world.first
        with self.world.session(org) as db:
            conversation = db.get(CommsConversation, org.other_conversation)
            assert conversation is not None
            conversation.scope = "members"
            member = db.scalars(select(CommsMember).where(
                CommsMember.org_id == org.id,
                CommsMember.conversation_id == org.other_conversation,
                CommsMember.user_id == org.peer,
            )).one()
            member.is_deleted, member.deleted_at = True, NOW
            db.commit()

    def add_visited_guest(self) -> None:
        first, second = self.world.first, self.world.second
        with self.world.session(second) as db:
            organization, user = db.get(WorkspaceProfile, second.id), db.get(User, first.author)
            assert organization is not None and user is not None
            create_member(
                db, organization, "guest", user=user,
                sponsor_user_id=second.author, expires_at=FUTURE,
            )
            db.add(CommsMember(
                org_id=second.id, conversation_id=second.conversation,
                user_id=first.author, joined_at=NOW,
            ))
            db.commit()

    def revoke_peer_membership(self) -> None:
        org = self.world.first
        with self.world.session(org) as db:
            membership = db.scalars(select(Membership).where(
                Membership.org_id == org.id, Membership.user_id == org.peer,
            )).one()
            membership.status = "disabled"
            db.commit()

    def settings(self, values: dict, conversation: UUID | None = None) -> None:
        org = self.world.first
        with self.world.session(org) as db:
            scope = "channel" if conversation else "workspace"
            row = db.scalar(select(CommsSettings).where(
                CommsSettings.org_id == org.id, CommsSettings.scope == scope,
                CommsSettings.conversation_id == conversation,
            ))
            if row is None:
                db.add(CommsSettings(
                    org_id=org.id, scope=scope, conversation_id=conversation, values=values,
                ))
            else:
                row.values = values
            db.commit()

    def private_conversations(self) -> dict[str, tuple[UUID, UUID]]:
        org = self.world.first
        self.add_home_members(self.world.second.author, self.world.second.peer)
        people = [org.peer, self.world.second.author, self.world.second.peer]
        identities = {}
        with self.world.session(org) as db:
            for kind, count in (("channel", 1), ("direct", 2), ("group", 3)):
                conversation = CommsConversation(
                    org_id=org.id, kind=kind, scope="members", name=f"Private {kind}",
                    category_id=org.category if kind == "channel" else None,
                    created_by=org.author,
                )
                db.add(conversation)
                db.flush()
                for actor in people[:count]:
                    db.add(CommsMember(
                        org_id=org.id, conversation_id=conversation.id, user_id=actor,
                    ))
                message = CommsMessage(
                    org_id=org.id, conversation_id=conversation.id, author_id=org.peer,
                    client_key=uuid7(), seq=1, body=f"Private {kind} content",
                    send_fingerprint="a" * 64,
                )
                db.add(message)
                db.add(CommsConversationCounter(
                    org_id=org.id, conversation_id=conversation.id, last_seq=1,
                ))
                db.flush()
                identities[kind] = conversation.id, message.id
            db.commit()
        return identities

    def add_home_members(self, *actors: UUID) -> None:
        """Reuse existing run-owned accounts; never create untracked cleanup users."""
        org = self.world.first
        assert set(actors) <= {self.world.second.author, self.world.second.peer}
        with self.world.session(org) as db:
            organization = db.get(WorkspaceProfile, org.id)
            assert organization is not None
            for actor in actors:
                user = db.get(User, actor)
                assert user is not None
                create_member(db, organization, "member", user=user)
            db.commit()

    def structure_state(self):
        """Committed business state plus audit identity; no SQL-layout assertions."""
        org = self.world.first
        with self.world.session(org) as db:
            return {
                "categories": db.execute(select(
                    CommsCategory.id, CommsCategory.name, CommsCategory.position,
                    CommsCategory.department_id, CommsCategory.is_deleted,
                ).where(CommsCategory.org_id == org.id).order_by(CommsCategory.id)).all(),
                "conversations": db.execute(select(
                    CommsConversation.id, CommsConversation.kind, CommsConversation.scope,
                    CommsConversation.name, CommsConversation.topic, CommsConversation.category_id,
                    CommsConversation.department_id, CommsConversation.position,
                    CommsConversation.archived_at, CommsConversation.is_deleted,
                ).where(CommsConversation.org_id == org.id)
                    .order_by(CommsConversation.id)).all(),
                "members": db.execute(select(
                    CommsMember.id, CommsMember.conversation_id, CommsMember.user_id,
                    CommsMember.role, CommsMember.is_deleted,
                ).where(CommsMember.org_id == org.id).order_by(CommsMember.id)).all(),
                "access": db.execute(select(
                    CommsConversationGroup.id, CommsConversationGroup.category_id,
                    CommsConversationGroup.conversation_id, CommsConversationGroup.subject,
                    CommsConversationGroup.group_id, CommsConversationGroup.level,
                    CommsConversationGroup.is_deleted,
                ).where(CommsConversationGroup.org_id == org.id)
                    .order_by(CommsConversationGroup.id)).all(),
                "audit": list(db.scalars(select(AuditLog.id).where(
                    AuditLog.org_id == org.id,
                ).order_by(AuditLog.id))),
            }


@pytest.fixture
def message_routes(comms_world) -> Iterator[MessageRoutes]:
    # Only the existing four owned accounts; CommsWorld.clean owns every added row.
    for org in (comms_world.first, comms_world.second):
        with comms_world.session(org) as db:
            for actor in (org.author, org.peer):
                user = db.get(User, actor)
                assert user is not None
                user.supabase_user_id = uuid7()
            for index, identity in enumerate((org.conversation, org.other_conversation)):
                conversation = db.get(CommsConversation, identity)
                assert conversation is not None
                conversation.category_id = org.category
                conversation.name, conversation.position = f"Channel {index}", index
                conversation.created_at = NOW
            db.commit()
    case = MessageRoutes(comms_world)
    try:
        yield case
    finally:
        for client in case.clients:
            client.close()
            client.app.dependency_overrides.clear()
        # Parent fixture cleans both owned orgs after all request sessions close.


@pytest.fixture
def structure_routes(message_routes) -> Iterator[MessageRoutes]:
    """No duplicate auth fixture. Adds cleanup for the two new setup row families."""
    try:
        yield message_routes
    finally:
        for org in (message_routes.world.first, message_routes.world.second):
            with message_routes.world.session(org) as db:
                for model in (GroupAccess, GroupMember):
                    for row in db.scalars(select(model).where(model.org_id == org.id)):
                        db.delete(row)
                db.commit()
        # message_routes then closes clients; CommsWorld removes owned domain rows,
        # added memberships, audit, groups/orgs and the original four accounts.


@pytest.fixture
def duplicate_source(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    case.seed_roots()
    with case.world.session(org) as db:
        source = db.get(CommsConversation, org.conversation)
        source.scope, source.name, source.topic = "groups", "Copy source", "Source topic"
        destination = CommsCategory(org_id=org.id, name="Copy destination", position=1)
        db.add(destination)
        db.flush()
        destination_id = destination.id
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(CommsConversationGroup(
            org_id=org.id, conversation_id=org.conversation,
            subject="group", group_id=org.group, level="read",
        ))
        db.add(CommsSettings(
            org_id=org.id, scope="channel", conversation_id=org.conversation,
            values={"edit_window_minutes": 17},
        ))
        db.add(CommsSettings(
            org_id=org.id, scope="category", category_id=destination_id,
            values={"formatting": False},
        ))
        db.add(CommsCapabilityGrant(
            org_id=org.id, scope="channel", conversation_id=org.conversation,
            subject="group", group_id=org.group, capability="manageChannel", granted=True,
        ))
        db.add(CommsCapabilityGrant(
            org_id=org.id, scope="category", category_id=destination_id,
            subject="group", group_id=org.group, capability="createChannel", granted=True,
        ))
        db.commit()
    return case, destination_id
