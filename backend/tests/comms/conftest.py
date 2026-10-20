"""Committed, run-owned data for Comms persistence tests, never a provider fixture."""

import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import Engine, bindparam, func, inspect, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from app.core import base_model
from app.core.database.base import Base
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from tests.conftest import alembic_heads, create_member, create_organization, guarded_create_engine
from tests.migrations.test_organization_root import COMMS_TABLES
from tests.organization_scope_support import organization_bindings

NOW = datetime(2026, 10, 19, 12, tzinfo=UTC)
COMMS_DELETE_ORDER = (
    "in_app_notifications",
    "comms_message_attachments", "comms_message_record_links", "comms_message_revisions",
    "comms_reactions", "comms_mentions", "comms_thread_follows", "comms_threads",
    "comms_read_states", "comms_member_preferences", "comms_members",
    "comms_conversation_counters", "comms_messages", "comms_capability_grants",
    "comms_setting_locks", "comms_settings", "comms_conversation_groups",
    "comms_conversations", "comms_categories", "comms_personal_preferences",
    "comms_direct_blocks",
)


@pytest.fixture
def budget_clock(comms_world, monkeypatch, record_property):
    clock = [NOW]

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0].astimezone(tz) if tz else clock[0].replace(tzinfo=None)

    monkeypatch.setattr(base_model, "datetime", FrozenDateTime)
    with comms_world.runtime.connect() as connection:
        isolation = connection.scalar(text("SHOW transaction_isolation"))
        default = connection.scalar(text("SHOW default_transaction_isolation"))
        role = connection.scalar(text("SELECT current_user"))
        version = connection.scalar(text("SHOW server_version"))
    record_property("send_budget_isolation", isolation)
    record_property("send_budget_default_isolation", default)
    record_property("send_budget_runtime_role", role)
    record_property("send_budget_postgres_version", version)
    assert isolation == default == "read committed"
    assert role == "openslate_runtime"
    buckets = _bucket_count(comms_world)
    yield clock
    assert _bucket_count(comms_world) == buckets, "send attempts must not persist bucket rows"


def _bucket_count(world):
    with world.owner.connect() as connection:
        return connection.scalar(select(func.count()).select_from(IdentityRateLimitBucket))


@dataclass(frozen=True)
class CommsOrganization:
    id: UUID = field(default_factory=uuid7)
    author: UUID = field(default_factory=uuid7)
    peer: UUID = field(default_factory=uuid7)
    conversation: UUID = field(default_factory=uuid7)
    other_conversation: UUID = field(default_factory=uuid7)
    category: UUID = field(default_factory=uuid7)
    group: UUID = field(default_factory=uuid7)
    department: UUID = field(default_factory=uuid7)
    module: UUID = field(default_factory=uuid7)
    record: UUID = field(default_factory=uuid7)
    file: UUID = field(default_factory=uuid7)


@dataclass(repr=False)
class CommsWorld:
    owner: Engine
    runtime: Engine
    first: CommsOrganization = field(default_factory=CommsOrganization)
    second: CommsOrganization = field(default_factory=CommsOrganization)
    additional_users: list[UUID] = field(default_factory=list)

    @contextmanager
    def session(
        self, org: CommsOrganization, *, actor: UUID | None = None,
    ) -> Iterator[AuditSession]:
        with AuditSession(self.runtime) as db:
            scope_session(db, org.id)
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=actor or org.author, request_id=uuid7(),
                request_method="POST", request_path="/api/test/comms",
            )
            yield db

    def seed_organization(self, org: CommsOrganization, *, role: str) -> None:
        # Setup is Core/owner SQL, not manufactured application audit or policy evidence.
        with organization_bindings(), Session(self.owner) as db:
            organization = create_organization(db, id=org.id)
            create_member(db, organization, id=org.author, role=role)
            create_member(db, organization, id=org.peer)
            connection = db.connection()
            connection.execute(Base.metadata.tables["departments"].insert().values(
                id=org.department, org_id=org.id, department_name="Comms fixture",
            ))
            connection.execute(Base.metadata.tables["groups"].insert().values(
                id=org.group, org_id=org.id, name="Comms fixture group",
            ))
            connection.execute(Base.metadata.tables["comms_categories"].insert().values(
                id=org.category, org_id=org.id, name="Category", position=0,
                department_id=org.department,
            ))
            for conversation in (org.conversation, org.other_conversation):
                connection.execute(Base.metadata.tables["comms_conversations"].insert().values(
                    id=conversation, org_id=org.id, kind="channel", scope="organization",
                    name="Conversation", topic="", position=0, created_by=org.author,
                ))
                connection.execute(
                    Base.metadata.tables["comms_conversation_counters"].insert().values(
                        org_id=org.id, conversation_id=conversation, last_seq=0,
                    )
                )
                for user in (org.author, org.peer):
                    connection.execute(Base.metadata.tables["comms_members"].insert().values(
                        org_id=org.id, conversation_id=conversation, user_id=user,
                        role="member", joined_at=NOW,
                    ))
            db.commit()

    def seed_graph(self, org: CommsOrganization) -> dict[str, UUID]:
        """One stored row in each approved table; no send/upload/policy is simulated."""
        tables = Base.metadata.tables
        ids = {name: uuid7() for name in COMMS_TABLES}
        ids["comms_categories"] = org.category
        ids["comms_conversations"] = org.conversation
        message = ids["comms_messages"]
        with self.owner.begin() as connection:
            for name in ("comms_members", "comms_conversation_counters"):
                table = tables[name]
                ids[name] = connection.scalar(select(table.c.id).where(
                    table.c.org_id == org.id, table.c.conversation_id == org.conversation,
                ).order_by(table.c.id).limit(1))
            connection.execute(tables["modules"].insert().values(
                id=org.module, org_id=org.id, department_id=org.department, module_name="Links",
            ))
            connection.execute(tables["records"].insert().values(
                id=org.record, org_id=org.id, module_id=org.module, data={},
            ))
            # Structural FK fixture only. Comms file reservation/ownership is S18, not
            # proved by linking this existing platform-library metadata row.
            connection.execute(tables["files"].insert().values(
                id=org.file, org_id=org.id, purpose="library_document",
                department_id=org.department, creator_id=org.author, filename="fixture.txt",
                expected_size=1, object_key=f"org/{org.id}/{org.file.hex}", state="awaiting_upload",
            ))
            rows = {
                "comms_conversation_groups": {
                    "category_id": org.category, "subject": "everyone", "level": "read",
                },
                "comms_direct_blocks": {"user_id": org.author, "blocked_user_id": org.peer},
                "comms_settings": {"scope": "workspace", "values": {}},
                "comms_setting_locks": {"namespace": "capability", "key": "pin"},
                "comms_capability_grants": {
                    "scope": "workspace", "subject": "group", "group_id": org.group,
                    "capability": "reply", "granted": True,
                },
                "comms_personal_preferences": {"user_id": org.author, "values": {}},
                "comms_member_preferences": {
                    "conversation_id": org.conversation, "user_id": org.author,
                    "notify": "all", "mute": "off", "starred": False,
                    "hidden": False, "manual_unread": False,
                },
                "comms_read_states": {
                    "conversation_id": org.conversation, "user_id": org.author, "last_read_seq": 0,
                },
                "comms_messages": {
                    "conversation_id": org.conversation, "author_id": org.author,
                    "seq": 1, "client_key": uuid7(), "body": "Stored message",
                    "send_fingerprint": "a" * 64,
                },
                "comms_message_revisions": {
                    "message_id": message, "author_id": org.author, "body": "Earlier message",
                },
                "comms_threads": {"conversation_id": org.conversation, "root_message_id": message},
                "comms_thread_follows": {"root_message_id": message, "user_id": org.author},
                "comms_reactions": {"message_id": message, "user_id": org.author, "emoji": "👍"},
                "comms_mentions": {"message_id": message, "user_id": org.peer},
                "comms_message_attachments": {"message_id": message, "file_id": org.file},
                "comms_message_record_links": {
                    "message_id": message, "record_id": org.record, "module_id": org.module,
                },
            }
            for name, values in rows.items():
                connection.execute(tables[name].insert().values(
                    id=ids[name], org_id=org.id, **values,
                ))
            connection.execute(tables["comms_conversation_counters"].update().where(
                tables["comms_conversation_counters"].c.id == ids["comms_conversation_counters"],
            ).values(last_seq=1))
        return ids

    def clean(self) -> None:
        owned = {"orgs": [self.first.id, self.second.id]}
        with self.owner.begin() as connection:
            for name in (*COMMS_DELETE_ORDER, "audit_logs", "files", "records", "modules",
                         "groups", "departments", "memberships"):
                connection.execute(text(f"DELETE FROM public.{name} WHERE org_id IN :orgs")
                                   .bindparams(bindparam("orgs", expanding=True)), owned)
            connection.execute(text("DELETE FROM public.organizations WHERE id IN :orgs")
                               .bindparams(bindparam("orgs", expanding=True)), owned)
            connection.execute(
                text("DELETE FROM public.users WHERE id IN :users").bindparams(
                    bindparam("users", expanding=True)
                ),
                {
                    "users": [
                        self.first.author,
                        self.first.peer,
                        self.second.author,
                        self.second.peer,
                        *self.additional_users,
                    ]
                },
            )


@pytest.fixture
def send_api():
    # Missing future imports are setup failures, NOT a meaningful red test.
    from app.systems.comms.messages.service import (
        InvalidSend,
        SendConflict,
        SendMessageCommand,
        send_message,
    )

    return SendMessageCommand, send_message, SendConflict, InvalidSend


@pytest.fixture
def comms_links(comms_world):
    """Unowned structural link targets, not S18 upload/purpose authorization evidence."""
    org = comms_world.first
    files = (org.file, uuid7())
    records = (org.record, uuid7())
    tables = Base.metadata.tables
    with comms_world.owner.begin() as connection:
        connection.execute(tables["modules"].insert().values(
            id=org.module, org_id=org.id, department_id=org.department, module_name="Send links",
        ))
        for identity in records:
            connection.execute(tables["records"].insert().values(
                id=identity, org_id=org.id, module_id=org.module, data={},
            ))
        for identity in files:
            # Metadata only: no Storage object, upload route or permission is simulated.
            connection.execute(tables["files"].insert().values(
                id=identity, org_id=org.id, purpose="library_document",
                department_id=org.department, creator_id=org.author, filename="fixture.txt",
                expected_size=1, actual_size=1, digest="a" * 64, state="ready",
                object_key=f"org/{org.id}/{identity.hex}",
            ))
    return files, records


@pytest.fixture
def comms_world():
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    runtime = guarded_create_engine(
        os.environ["TEST_DATABASE_URL"], pool_size=5, max_overflow=5, pool_timeout=5,
        connect_args={"connect_timeout": 3, "options": "-c statement_timeout=15000"},
    )
    world = CommsWorld(owner, runtime)
    schema_ready = False
    try:
        with owner.connect() as connection:
            assert set(connection.scalars(text("SELECT version_num FROM alembic_version"))) == (
                alembic_heads()
            )
            assert COMMS_TABLES <= set(inspect(connection).get_table_names(schema="public"))
        assert COMMS_TABLES <= set(Base.metadata.tables)
        schema_ready = True
        world.seed_organization(world.first, role="admin")
        world.seed_organization(world.second, role="member")
        yield world
    finally:
        try:
            if schema_ready:
                world.clean()
        finally:
            runtime.dispose()
            owner.dispose()
