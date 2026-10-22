"""Stored conversation, message and interaction invariants on real PostgreSQL."""

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.base import Base
from app.systems.comms.conversations.models import CommsConversation
from tests.comms.conftest import NOW
from tests.comms.constraint_support import _insert, _reject

pytestmark = pytest.mark.integration


def _message(connection, org, **changes):
    values = {
        "conversation_id": org.conversation,
        "author_id": org.author,
        "client_key": uuid7(),
        "seq": 1,
        "body": "Searchable kumquat",
        "send_fingerprint": "b" * 64,
    }
    return _insert(connection, "comms_messages", org, **(values | changes))


def test_unicode_limit_and_generated_vector_follow_body_changes(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        identity = _message(connection, org, body="🪁" * 4000)
        assert (
            connection.scalar(
                text("SELECT char_length(body) FROM comms_messages WHERE id=:id"), {"id": identity}
            )
            == 4000
        )
        connection.execute(
            text("UPDATE comms_messages SET body='kumquat' WHERE id=:id"), {"id": identity}
        )
        assert (
            connection.scalar(
                text(
                    "SELECT body_tsv @@ plainto_tsquery('simple','kumquat') "
                    "FROM comms_messages WHERE id=:id"
                ),
                {"id": identity},
            )
            is True
        )
        connection.execute(
            text("UPDATE comms_messages SET body='papaya' WHERE id=:id"), {"id": identity}
        )
        assert connection.execute(
            text(
                "SELECT body_tsv @@ plainto_tsquery('simple','kumquat'), "
                "body_tsv @@ plainto_tsquery('simple','papaya') FROM comms_messages WHERE id=:id"
            ),
            {"id": identity},
        ).one() == (False, True)


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"body": "🪁" * 4001}, id="4001-code-points"),
        pytest.param({"seq": 0}, id="zero-sequence"),
        pytest.param({"seq": -1}, id="negative-sequence"),
        pytest.param({"seq": 9007199254740992}, id="unsafe-wire-sequence"),
        pytest.param({"reply_count": -1}, id="negative-replies"),
        pytest.param({"send_fingerprint": "not-a-digest"}, id="invalid-original-fingerprint"),
    ],
)
def test_invalid_message_values_are_rejected_by_named_checks(comms_world, changes):
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _message(connection, comms_world.first, **changes))


def test_storage_allows_empty_body_for_later_attachment_only_send_admission(comms_world):
    with comms_world.owner.begin() as connection:
        identity = _message(connection, comms_world.first, body="")
        assert (
            connection.scalar(
                text("SELECT body FROM comms_messages WHERE id=:id"), {"id": identity}
            )
            == ""
        )


def test_direct_pair_key_is_scoped_lifetime_unique_and_preserves_keyless_fixtures(comms_world):
    org = comms_world.first
    key = f"{org.author}:{org.peer}"
    with comms_world.owner.begin() as connection:
        columns = {
            column["name"]: column
            for column in inspect(connection).get_columns(
                "comms_conversations",
                schema="public",
            )
        }
        assert "direct_key" in columns
        assert columns["direct_key"]["nullable"] is True
        values = {"kind": "direct", "scope": "members", "created_by": org.author, "direct_key": key}
        identity = _insert(connection, "comms_conversations", org, **values)
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_conversations",
                org,
                **values,
            ),
        )
        connection.execute(
            text("UPDATE comms_conversations SET is_deleted=true, deleted_at=:now WHERE id=:id"),
            {"id": identity, "now": NOW},
        )
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_conversations",
                org,
                **values,
            ),
        )
        _insert(connection, "comms_conversations", comms_world.second, **values)
        for _ in range(2):
            _insert(connection, "comms_conversations", org, **(values | {"direct_key": None}))
            _insert(connection, "comms_conversations", org, **(values | {"kind": "group"}))
            _insert(
                connection,
                "comms_conversations",
                org,
                **(
                    values
                    | {
                        "kind": "channel",
                        "scope": "organization",
                        "name": "Not a direct",
                    }
                ),
            )


def test_racing_direct_pair_inserts_commit_only_one_conversation(comms_world):
    org = comms_world.first
    key = f"{org.author}:{org.peer}"
    with comms_world.owner.connect() as connection:
        assert "direct_key" in {
            column["name"]
            for column in inspect(connection).get_columns(
                "comms_conversations",
                schema="public",
            )
        }
    barrier = threading.Barrier(2, timeout=10)

    def create(actor):
        with comms_world.session(org, actor=actor) as db:
            row = CommsConversation(
                org_id=org.id,
                kind="direct",
                scope="members",
                created_by=actor,
                direct_key=key,
            )
            db.add(row)
            barrier.wait()
            try:
                db.commit()
                return row.id
            except IntegrityError as exc:
                db.rollback()
                if exc.orig.sqlstate != "23505":
                    raise
                return None

    with ThreadPoolExecutor(max_workers=2) as workers:
        futures = [workers.submit(create, actor) for actor in (org.author, org.peer)]
        results = [future.result(timeout=20) for future in futures]
    assert results.count(None) == 1
    with comms_world.owner.connect() as connection:
        stored = connection.scalars(
            text(
                "SELECT id FROM comms_conversations WHERE org_id=:org AND kind='direct' "
                "AND direct_key=:key"
            ),
            {"org": org.id, "key": key},
        ).all()
    assert stored == [identity for identity in results if identity is not None]


def test_sequence_and_author_key_are_lifetime_unique_and_original_fingerprint_is_immutable(
    comms_world,
):
    org = comms_world.first
    key = uuid7()
    with comms_world.owner.begin() as connection:
        identity = _message(connection, org, client_key=key)
        connection.execute(
            text("UPDATE comms_messages SET is_deleted=true, deleted_at=:now WHERE id=:id"),
            {"id": identity, "now": NOW},
        )
        _reject(connection, "23505", lambda: _message(connection, org))
        _reject(
            connection,
            "23505",
            lambda: _message(
                connection,
                org,
                conversation_id=org.other_conversation,
                client_key=key,
            ),
        )
        with pytest.raises(IntegrityError) as changed, connection.begin_nested():
            connection.execute(
                text("UPDATE comms_messages SET send_fingerprint=:digest WHERE id=:id"),
                {"id": identity, "digest": "c" * 64},
            )
        assert changed.value.orig.sqlstate == "23514"
        _message(connection, org, seq=2, client_key=key, author_id=org.peer)
        _message(connection, comms_world.second, client_key=key)


def test_revision_update_and_cross_organization_parent_are_refused(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        message = _message(connection, org)
        revision = _insert(
            connection,
            "comms_message_revisions",
            org,
            message_id=message,
            author_id=org.author,
            body="Before",
        )
        with pytest.raises(IntegrityError) as changed, connection.begin_nested():
            connection.execute(
                text("UPDATE comms_message_revisions SET body='Changed' WHERE id=:id"),
                {"id": revision},
            )
        assert changed.value.orig.sqlstate == "23514"
        with pytest.raises(IntegrityError), connection.begin_nested():
            _insert(
                connection,
                "comms_message_revisions",
                comms_world.second,
                message_id=message,
                author_id=org.author,
                body="Wrong organization",
            )
        assert (
            connection.scalar(
                text("SELECT body FROM comms_message_revisions WHERE id=:id"), {"id": revision}
            )
            == "Before"
        )


@pytest.mark.parametrize(
    "table,field,value",
    [
        ("comms_conversation_counters", "last_seq", -1),
        ("comms_conversation_counters", "last_seq", 9007199254740992),
        ("comms_categories", "position", -1),
        ("comms_conversations", "position", -1),
        ("comms_conversations", "kind", "unknown"),
        ("comms_conversations", "scope", "unknown"),
        ("comms_conversations", "scope", "department"),
        # D44: a live channel is organization or department; hand-picked people use a group.
        ("comms_conversations", "scope", "groups"),
        ("comms_conversations", "scope", "members"),
        ("comms_members", "role", "admin"),
    ],
)
def test_existing_rows_reject_invalid_scalar_or_missing_scope_parent(
    comms_world,
    table,
    field,
    value,
):
    with comms_world.owner.begin() as connection:
        _reject(
            connection,
            "23514",
            lambda: connection.execute(
                text(f"UPDATE {table} SET {field}=:value WHERE org_id=:org"),
                {"value": value, "org": comms_world.first.id},
            ),
        )


@pytest.mark.parametrize("watermark", [-1, 9007199254740992])
def test_read_watermarks_stay_in_safe_nonnegative_range(comms_world, watermark):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_read_states",
                org,
                conversation_id=org.conversation,
                user_id=org.author,
                last_read_seq=watermark,
            ),
        )


def test_links_interactions_and_personal_rows_cannot_duplicate_live_identity(comms_world):
    ids = comms_world.seed_graph(comms_world.first)
    tables = (
        "comms_reactions",
        "comms_mentions",
        "comms_threads",
        "comms_thread_follows",
        "comms_message_attachments",
        "comms_message_record_links",
        "comms_personal_preferences",
        "comms_read_states",
        "comms_members",
        "comms_conversation_counters",
    )
    with comms_world.owner.begin() as connection:
        for name in tables:
            table = Base.metadata.tables[name]
            original = dict(
                connection.execute(
                    select(table).where(
                        table.c.id == ids[name],
                    )
                )
                .mappings()
                .one()
            )
            duplicate = original | {"id": uuid7()}
            _reject(
                connection,
                "23505",
                lambda table=table, duplicate=duplicate: connection.execute(
                    table.insert().values(**duplicate),
                ),
            )


def test_unlinked_attachment_keeps_its_lifetime_message_owner(comms_world):
    org = comms_world.first
    ids = comms_world.seed_graph(org)
    with comms_world.owner.begin() as connection:
        connection.execute(
            text(
                "UPDATE comms_message_attachments SET is_deleted=true,deleted_at=:now WHERE id=:id"
            ),
            {"id": ids["comms_message_attachments"], "now": NOW},
        )
        other_message = _message(connection, org, seq=2)
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_message_attachments",
                org,
                message_id=other_message,
                file_id=org.file,
            ),
        )
