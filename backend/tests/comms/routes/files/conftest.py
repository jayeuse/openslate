"""Real Storage fixture; retains the reviewed S18 packet's bounded cleanup exception."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import (
    CurrentIdentity,
    get_account_identity,
    get_account_user,
    get_current_membership,
    get_current_user,
)
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.link_models import CommsMessageAttachment
from app.systems.manage.audit.models import SecurityEvent
from app.systems.platform.files.models import File
from app.systems.platform.files.storage import get_storage
from app.systems.platform.files.supabase_storage import SupabaseStorage
from tests.comms.conftest import NOW, CommsOrganization
from tests.comms.routes.conftest import MessageRoutes
from tests.files.test_provider_storage_recovery import (
    live_provider_storage as live_provider_storage,
)
from tests.files.test_workspace_policy_integration import _png


@dataclass(repr=False)
class FileRoutes:
    routes: MessageRoutes
    storage: SupabaseStorage
    content: bytes = field(default_factory=_png)
    setup_keys: set[str] = field(default_factory=set)

    @property
    def world(self):
        return self.routes.world

    def client(self, actor: UUID, org: UUID) -> TestClient:
        client = self.routes.client(actor, org)
        client.app.dependency_overrides[get_storage] = lambda: self.storage

        def scoped_user(
            identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
            membership: Annotated[Membership, Depends(get_current_membership)],
        ) -> User:
            return get_account_user(identity)

        # Generic platform routes bind organization through get_current_user rather
        # than the Comms router dependency. Keep the same supplied-principal boundary,
        # but run the real membership resolver on both route families.
        client.app.dependency_overrides[get_current_user] = scoped_user
        return client

    def arrange_private_channels(self) -> None:
        for org in (self.world.first, self.world.second):
            with self.world.session(org) as db:
                for identity in (org.conversation, org.other_conversation):
                    row = db.get(CommsConversation, identity)
                    assert row is not None
                    # D44: member-only conversations are group messages, never channels.
                    row.kind, row.scope, row.category_id = "group", "members", None
                db.commit()
        for org, visitor in (
            (self.world.second, self.world.first.peer),
            (self.world.first, self.world.second.peer),
        ):
            with self.world.session(org) as db:
                db.add(Membership(org_id=org.id, user_id=visitor, role="member", status="active"))
                db.commit()

    def remove_second_peer(self) -> None:
        org = self.world.second
        with self.world.session(org) as db:
            member = db.scalars(
                select(CommsMember).where(
                    CommsMember.org_id == org.id,
                    CommsMember.conversation_id == org.conversation,
                    CommsMember.user_id == org.peer,
                    CommsMember.is_deleted.is_(False),
                )
            ).one()
            member.is_deleted, member.deleted_at = True, NOW
            db.commit()

    def object_key(self, org: CommsOrganization, file_id: UUID) -> str:
        with self.world.session(org) as db:
            row = db.get(File, file_id)
            assert row is not None and row.org_id == org.id
            key = row.object_key
        assert key.startswith(f"org/{org.id}/")
        return key

    def stored_state(self, org: CommsOrganization):
        with self.world.owner.connect() as connection:
            return {
                table: connection.execute(
                    text(f"SELECT * FROM public.{table} WHERE org_id=:org ORDER BY id"),
                    {"org": org.id},
                ).all()
                for table in (
                    "files",
                    "comms_messages",
                    "comms_conversation_counters",
                    "comms_message_attachments",
                    "comms_mentions",
                    "audit_logs",
                )
            }

    def ready_library_fixture(self, org: CommsOrganization) -> UUID:
        """Negative reference setup, not evidence of platform upload behavior."""
        from hashlib import sha256

        identity = uuid7()
        key = f"org/{org.id}/{uuid7().hex}"
        self.setup_keys.add(key)
        self.storage.upload(key, self.content, "image/png")
        with self.world.session(org) as db:
            db.add(
                File(
                    id=identity,
                    org_id=org.id,
                    purpose="library_document",
                    department_id=org.department,
                    creator_id=org.author,
                    filename="library-only.png",
                    expected_size=len(self.content),
                    actual_size=len(self.content),
                    media_type="image/png",
                    digest=sha256(self.content).hexdigest(),
                    object_key=key,
                    state="ready",
                )
            )
            db.commit()
        return identity

    def clean_files(self) -> None:
        orgs = [self.world.first.id, self.world.second.id]
        with self.world.owner.connect() as connection:
            keys = self.setup_keys | set(
                connection.scalars(select(File.object_key).where(File.org_id.in_(orgs)))
            )
        errors = []
        for key in sorted(keys):
            try:
                if not any(key.startswith(f"org/{org}/") for org in orgs):
                    raise AssertionError("Refusing cleanup outside the owned organization keys")
                self.storage.delete(key)  # Real adapter verifies NoSuchKey.
            except Exception as exc:
                errors.append(exc)
        for org in (self.world.first, self.world.second):
            try:
                with self.world.session(org) as db:
                    for attachment in db.scalars(
                        select(CommsMessageAttachment).where(
                            CommsMessageAttachment.org_id == org.id,
                        )
                    ).all():
                        db.delete(attachment)
                    db.flush()
                    for file in db.scalars(select(File).where(File.org_id == org.id)).all():
                        db.delete(file)
                    db.commit()
            except Exception as exc:
                errors.append(exc)
        # Parent-authorized packet correction: plain owner Session ONLY for individual
        # SecurityEvent teardown in these two generated orgs. AuditSession is append-only,
        # and the event's RESTRICT org FK otherwise blocks fixture cleanup. No app exception.
        try:
            with Session(self.world.owner) as db:
                for event in db.scalars(
                    select(SecurityEvent).where(SecurityEvent.org_id.in_(orgs))
                ).all():
                    if event.org_id not in orgs:
                        raise AssertionError("Refusing cleanup outside the owned organizations")
                    db.delete(event)
                db.commit()
        except Exception as exc:
            errors.append(exc)
        if errors:
            raise ExceptionGroup("Owned Storage or database cleanup was not confirmed", errors)


@pytest.fixture
def file_routes(message_routes, live_provider_storage) -> Iterator[FileRoutes]:
    _settings, storage, _provider_client = live_provider_storage
    case = FileRoutes(message_routes, storage)
    try:
        case.arrange_private_channels()
        yield case
    finally:
        case.clean_files()
