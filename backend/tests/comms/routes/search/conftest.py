"""Promoted S19 fixtures over the existing real principal/membership route boundary."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import GroupAccess, GroupMember
from app.systems.access.users.models import User
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.interaction_models import CommsThread
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.platform.files.models import File
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.comms.conftest import NOW

if TYPE_CHECKING:
    from tests.comms.routes.conftest import MessageRoutes


@dataclass
class SearchCase:
    routes: MessageRoutes

    @property
    def world(self):
        return self.routes.world

    def client(self, actor, org):
        return self.routes.client(actor, org)

    def seed_search_filters(self, root_id):
        org = self.world.first
        ids = {
            name: uuid7()
            for name in ("earlier", "reply", "file", "link", "record", "decoy", "elsewhere")
        }
        ids["root"] = root_id
        rows = (
            ("earlier", 2, "kumquat earlier", "2026-10-19T01:59:59.999999+02:00"),
            ("reply", 3, "kumquat reply", "2026-10-19T01:00:00+00:00"),
            ("file", 4, "kumquat file", "2026-10-19T12:00:00+00:00"),
            ("link", 5, "kumquat https://example.test", "2026-10-20T01:59:59.999999+02:00"),
            ("record", 6, "kumquat record", "2026-10-19T20:00:00-04:00"),
            ("decoy", 7, "papaya", "2026-10-19T03:00:00+00:00"),
            ("elsewhere", 1, "kumquat elsewhere", "2026-10-19T06:00:00+00:00"),
        )
        # Synthetic profile labels, like CommsWorld's owner setup; not audited API writes.
        # No global audit rows are manufactured by renaming these two owned fixture users.
        with Session(self.world.owner) as db:
            db.get(User, org.author).display_name = "S19 author"
            db.get(User, org.peer).display_name = "S19 reader"
            db.commit()
        with self.world.session(org) as db:
            root = db.get(CommsMessage, root_id)
            root.created_at = datetime(2026, 10, 19, tzinfo=UTC)
            root.reply_count = 1
            root.last_reply_at = datetime(2026, 10, 19, 1, tzinfo=UTC)
            for label, seq, body, at in rows:
                message = CommsMessage(
                    id=ids[label],
                    org_id=org.id,
                    conversation_id=org.other_conversation
                    if label == "elsewhere"
                    else org.conversation,
                    author_id=org.peer if label in ("file", "link") else org.author,
                    client_key=uuid7(),
                    seq=seq,
                    body=body,
                    send_fingerprint="c" * 64,
                    created_at=datetime.fromisoformat(at),
                    parent_id=root_id if label == "reply" else None,
                )
                if label == "file":
                    message.pinned_at, message.pinned_by = NOW, org.author
                db.add(message)
            db.flush()
            db.add(
                CommsThread(
                    org_id=org.id, conversation_id=org.conversation, root_message_id=root_id
                )
            )
            db.add(
                Module(
                    id=org.module,
                    org_id=org.id,
                    department_id=org.department,
                    module_name="S19 record links",
                )
            )
            db.flush()
            db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
            db.add(
                GroupAccess(
                    org_id=org.id,
                    group_id=org.group,
                    department_id=org.department,
                    module_id=org.module,
                    level="read",
                )
            )
            db.add(Record(id=org.record, org_id=org.id, module_id=org.module, data={}))
            # Search metadata only, not another upload/Storage test. Use the real S18
            # purpose/parent shape; never weaken production checks for a legacy fixture.
            db.add(
                File(
                    id=org.file,
                    org_id=org.id,
                    purpose="comms_attachment",
                    conversation_id=org.conversation,
                    creator_id=org.peer,
                    filename="s19.pdf",
                    expected_size=1,
                    actual_size=1,
                    media_type="application/pdf",
                    digest="d" * 64,
                    state="ready",
                    object_key=f"org/{org.id}/{org.file.hex}",
                )
            )
            db.flush()
            db.add(CommsMessageAttachment(org_id=org.id, message_id=ids["file"], file_id=org.file))
            db.add(
                CommsMessageRecordLink(
                    org_id=org.id,
                    message_id=ids["record"],
                    record_id=org.record,
                    module_id=org.module,
                )
            )
            for conversation, seq in ((org.conversation, 7), (org.other_conversation, 1)):
                counter = db.scalars(
                    select(CommsConversationCounter).where(
                        CommsConversationCounter.org_id == org.id,
                        CommsConversationCounter.conversation_id == conversation,
                    )
                ).one()
                counter.last_seq = seq
            db.commit()
        return ids

    def revoke_search_record_access(self):
        org = self.world.first
        with self.world.session(org) as db:
            row = db.scalars(
                select(GroupAccess).where(
                    GroupAccess.org_id == org.id,
                    GroupAccess.group_id == org.group,
                    GroupAccess.department_id == org.department,
                    GroupAccess.module_id == org.module,
                    GroupAccess.is_deleted.is_(False),
                    GroupAccess.deleted_at.is_(None),
                )
            ).one()
            row.is_deleted, row.deleted_at = True, NOW
            db.commit()

    def seed_search_ties(self):
        org = self.world.first
        namespace = (uuid7().int >> 32) << 32
        ids = {number: UUID(int=namespace | number) for number in range(1, 103)}
        with self.world.session(org) as db:
            for seq, number in enumerate(range(102, 0, -1), start=1):
                db.add(
                    CommsMessage(
                        id=ids[number],
                        org_id=org.id,
                        conversation_id=org.conversation,
                        author_id=org.author,
                        client_key=uuid7(),
                        seq=seq,
                        body="kumquat",
                        send_fingerprint="e" * 64,
                        created_at=NOW,
                    )
                )
            db.scalars(
                select(CommsConversationCounter).where(
                    CommsConversationCounter.org_id == org.id,
                    CommsConversationCounter.conversation_id == org.conversation,
                )
            ).one().last_seq = 102
            db.commit()
        return ids

    def seed_search_visibility(self):
        first, second = self.world.first, self.world.second
        ids = {
            name: uuid7()
            for name in ("tombstone", "reply", "revocable", "private", "foreign", "private_room")
        }
        with self.world.session(first) as db:
            db.add(
                CommsConversation(
                    id=ids["private_room"],
                    org_id=first.id,
                    # D44: hand-picked people are a group message, never a channel.
                    kind="group",
                    scope="members",
                    name="S19 private",
                    created_by=first.author,
                )
            )
            db.flush()
            db.add(
                CommsMember(
                    org_id=first.id,
                    conversation_id=ids["private_room"],
                    user_id=first.author,
                    joined_at=NOW,
                )
            )
            db.add(
                CommsConversationCounter(
                    org_id=first.id, conversation_id=ids["private_room"], last_seq=1
                )
            )
            for label, conversation, seq, body, hour in (
                ("tombstone", first.conversation, 1, "kumquat removed", 9),
                ("reply", first.conversation, 2, "kumquat surviving", 10),
                ("revocable", first.other_conversation, 1, "kumquat revocable", 8),
                ("private", ids["private_room"], 1, "kumquat private", 12),
            ):
                message = CommsMessage(
                    id=ids[label],
                    org_id=first.id,
                    conversation_id=conversation,
                    author_id=first.author,
                    client_key=uuid7(),
                    seq=seq,
                    body=body,
                    send_fingerprint="f" * 64,
                    created_at=datetime(2026, 10, 19, hour, tzinfo=UTC),
                    parent_id=ids["tombstone"] if label == "reply" else None,
                )
                if label == "tombstone":
                    message.is_deleted, message.deleted_at, message.deleted_by = (
                        True,
                        NOW,
                        first.author,
                    )
                    message.reply_count = 1
                    message.last_reply_at = datetime(2026, 10, 19, 10, tzinfo=UTC)
                db.add(message)
                db.flush()
            db.add(
                CommsThread(
                    org_id=first.id,
                    conversation_id=first.conversation,
                    root_message_id=ids["tombstone"],
                )
            )
            for conversation, seq in ((first.conversation, 2), (first.other_conversation, 1)):
                db.scalars(
                    select(CommsConversationCounter).where(
                        CommsConversationCounter.org_id == first.id,
                        CommsConversationCounter.conversation_id == conversation,
                    )
                ).one().last_seq = seq
            db.commit()
        with self.world.session(second) as db:
            db.add(
                CommsMessage(
                    id=ids["foreign"],
                    org_id=second.id,
                    conversation_id=second.conversation,
                    author_id=second.author,
                    client_key=uuid7(),
                    seq=1,
                    body="kumquat foreign",
                    send_fingerprint="f" * 64,
                    created_at=datetime(2026, 10, 19, 13, tzinfo=UTC),
                )
            )
            db.scalars(
                select(CommsConversationCounter).where(
                    CommsConversationCounter.org_id == second.id,
                    CommsConversationCounter.conversation_id == second.conversation,
                )
            ).one().last_seq = 1
            db.commit()
        return ids

    def cleanup(self):
        org = self.world.first
        with self.world.session(org) as db:
            for row in db.scalars(
                select(CommsMessageAttachment).where(
                    CommsMessageAttachment.org_id == org.id,
                    CommsMessageAttachment.file_id == org.file,
                )
            ):
                db.delete(row)
            db.flush()
            row = db.scalar(select(File).where(File.org_id == org.id, File.id == org.file))
            if row is not None:
                db.delete(row)
            db.commit()


@pytest.fixture
def search_case(structure_routes):
    case = SearchCase(structure_routes)
    try:
        yield case
    finally:
        # The inherited structure fixture removes owned group access/member rows,
        # including revoked rows, before CommsWorld removes modules/groups/orgs.
        case.cleanup()
