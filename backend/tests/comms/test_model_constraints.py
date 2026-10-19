"""Stored invariants: real PostgreSQL rejections, not copies of model declarations."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database.base import Base
from tests.comms.conftest import NOW

pytestmark = pytest.mark.integration


def _insert(connection, table, org, **values):
    identity = values.pop("id", uuid7())
    connection.execute(Base.metadata.tables[table].insert().values(
        id=identity, org_id=org.id, **values,
    ))
    return identity


def _message(connection, org, **changes):
    values = {
        "conversation_id": org.conversation, "author_id": org.author, "client_key": uuid7(),
        "seq": 1, "body": "Searchable kumquat", "send_fingerprint": "b" * 64,
    }
    return _insert(connection, "comms_messages", org, **(values | changes))


def _reject(connection, sqlstate, action):
    with pytest.raises(IntegrityError) as raised, connection.begin_nested():
        action()
    assert raised.value.orig.sqlstate == sqlstate
    assert raised.value.orig.diag.constraint_name


def test_unicode_limit_and_generated_vector_follow_body_changes(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        identity = _message(connection, org, body="🪁" * 4000)
        assert connection.scalar(text("SELECT char_length(body) FROM comms_messages WHERE id=:id"),
                                 {"id": identity}) == 4000
        connection.execute(text("UPDATE comms_messages SET body='kumquat' WHERE id=:id"),
                           {"id": identity})
        assert connection.scalar(text(
            "SELECT body_tsv @@ plainto_tsquery('simple','kumquat') "
            "FROM comms_messages WHERE id=:id"
        ), {"id": identity}) is True
        connection.execute(text("UPDATE comms_messages SET body='papaya' WHERE id=:id"),
                           {"id": identity})
        assert connection.execute(text(
            "SELECT body_tsv @@ plainto_tsquery('simple','kumquat'), "
            "body_tsv @@ plainto_tsquery('simple','papaya') FROM comms_messages WHERE id=:id"
        ), {"id": identity}).one() == (False, True)


@pytest.mark.parametrize("changes", [
    pytest.param({"body": "🪁" * 4001}, id="4001-code-points"),
    pytest.param({"seq": 0}, id="zero-sequence"),
    pytest.param({"seq": -1}, id="negative-sequence"),
    pytest.param({"seq": 9007199254740992}, id="unsafe-wire-sequence"),
    pytest.param({"reply_count": -1}, id="negative-replies"),
    pytest.param({"send_fingerprint": "not-a-digest"}, id="invalid-original-fingerprint"),
])
def test_invalid_message_values_are_rejected_by_named_checks(comms_world, changes):
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _message(connection, comms_world.first, **changes))


def test_storage_allows_empty_body_for_later_attachment_only_send_admission(comms_world):
    with comms_world.owner.begin() as connection:
        identity = _message(connection, comms_world.first, body="")
        assert connection.scalar(text(
            "SELECT body FROM comms_messages WHERE id=:id"
        ), {"id": identity}) == ""


def test_sequence_and_author_key_are_lifetime_unique_and_original_fingerprint_is_immutable(
    comms_world,
):
    org = comms_world.first
    key = uuid7()
    with comms_world.owner.begin() as connection:
        identity = _message(connection, org, client_key=key)
        connection.execute(text(
            "UPDATE comms_messages SET is_deleted=true, deleted_at=:now WHERE id=:id"
        ), {"id": identity, "now": NOW})
        _reject(connection, "23505", lambda: _message(connection, org))
        _reject(connection, "23505", lambda: _message(
            connection, org, conversation_id=org.other_conversation, client_key=key,
        ))
        with pytest.raises(IntegrityError) as changed, connection.begin_nested():
            connection.execute(text(
                "UPDATE comms_messages SET send_fingerprint=:digest WHERE id=:id"
            ), {"id": identity, "digest": "c" * 64})
        assert changed.value.orig.sqlstate == "23514"
        _message(connection, org, seq=2, client_key=key, author_id=org.peer)
        _message(connection, comms_world.second, client_key=key)


@pytest.mark.parametrize("owner", ["category_id", "conversation_id"])
@pytest.mark.parametrize("subject", ["everyone", "group"])
def test_access_uniqueness_is_per_owner_and_keeps_soft_deleted_history(comms_world, owner, subject):
    org = comms_world.first
    values = {
        owner: org.category if owner == "category_id" else org.conversation,
        "subject": subject, "group_id": org.group if subject == "group" else None, "level": "read",
    }
    with comms_world.owner.begin() as connection:
        identity = _insert(connection, "comms_conversation_groups", org, **values)
        _reject(connection, "23505", lambda: _insert(
            connection, "comms_conversation_groups", org, **(values | {"level": "post"}),
        ))
        connection.execute(text(
            "UPDATE comms_conversation_groups SET is_deleted=true, deleted_at=:now WHERE id=:id"
        ), {"id": identity, "now": NOW})
        _insert(connection, "comms_conversation_groups", org, **values)


@pytest.mark.parametrize("invalid", ["neither", "both", "group-without-id", "everyone-with-id"])
def test_access_rows_require_one_owner_and_a_consistent_subject(comms_world, invalid):
    org = comms_world.first
    values = {"category_id": org.category, "subject": "everyone", "level": "read"}
    if invalid == "neither":
        values["category_id"] = None
    elif invalid == "both":
        values["conversation_id"] = org.conversation
    elif invalid == "group-without-id":
        values["subject"] = "group"
    else:
        values["group_id"] = org.group
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_conversation_groups", org, **values,
        ))


@pytest.mark.parametrize("category", [True, False])
def test_preferences_have_exclusive_owner_fields_and_one_row_per_person(comms_world, category):
    org = comms_world.first
    values = {"user_id": org.author, "mute": "off"}
    if category:
        values |= {"category_id": org.category, "collapsed": False}
        illegal = {"notify": "all"}
    else:
        values |= {"conversation_id": org.conversation, "notify": "all", "starred": False,
                   "hidden": False, "manual_unread": False}
        illegal = {"collapsed": False}
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_member_preferences", org, **(values | illegal),
        ))
        _insert(connection, "comms_member_preferences", org, **values)
        _reject(connection, "23505", lambda: _insert(
            connection, "comms_member_preferences", org, **values,
        ))
        _insert(connection, "comms_member_preferences", org, **(values | {"user_id": org.peer}))


@pytest.mark.parametrize("changes", [
    pytest.param({"category_id": None}, id="no-owner"),
    pytest.param({"mute": "until", "muted_until": None}, id="until-needs-time"),
    pytest.param({"mute": "off", "muted_until": NOW}, id="off-has-no-time"),
])
def test_category_preference_owner_and_mute_shape(comms_world, changes):
    org = comms_world.first
    values = {"user_id": org.author, "category_id": org.category, "collapsed": False, "mute": "off"}
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_member_preferences", org, **(values | changes),
        ))


def test_revision_update_and_cross_organization_parent_are_refused(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        message = _message(connection, org)
        revision = _insert(connection, "comms_message_revisions", org,
                           message_id=message, author_id=org.author, body="Before")
        with pytest.raises(IntegrityError) as changed, connection.begin_nested():
            connection.execute(text(
                "UPDATE comms_message_revisions SET body='Changed' WHERE id=:id"
            ), {"id": revision})
        assert changed.value.orig.sqlstate == "23514"
        with pytest.raises(IntegrityError), connection.begin_nested():
            _insert(connection, "comms_message_revisions", comms_world.second,
                    message_id=message, author_id=org.author, body="Wrong organization")
        assert connection.scalar(text(
            "SELECT body FROM comms_message_revisions WHERE id=:id"
        ), {"id": revision}) == "Before"


def test_optional_parent_fks_still_reject_cross_org_and_restrict_parent_deletion(comms_world):
    org, other = comms_world.first, comms_world.second
    with comms_world.owner.begin() as connection:
        for values in (
            {"category_id": other.category, "subject": "everyone"},
            {"conversation_id": other.conversation, "subject": "everyone"},
            {"category_id": org.category, "subject": "group", "group_id": other.group},
        ):
            _reject(connection, "23503", lambda values=values: _insert(
                connection, "comms_conversation_groups", org, level="read", **values,
            ))
        _insert(connection, "comms_conversation_groups", org, category_id=org.category,
                subject="group", group_id=org.group, level="read")
        for table, identity in (("groups", org.group), ("comms_categories", org.category)):
            _reject(connection, "23503", lambda table=table, identity=identity: connection.execute(
                text(f"DELETE FROM {table} WHERE id=:id"), {"id": identity},
            ))


@pytest.mark.parametrize("table,field,value", [
    ("comms_conversation_counters", "last_seq", -1),
    ("comms_conversation_counters", "last_seq", 9007199254740992),
    ("comms_categories", "position", -1),
    ("comms_conversations", "position", -1),
    ("comms_conversations", "kind", "unknown"),
    ("comms_conversations", "scope", "unknown"),
    ("comms_conversations", "scope", "department"),
    ("comms_members", "role", "admin"),
])
def test_existing_rows_reject_invalid_scalar_or_missing_scope_parent(
    comms_world, table, field, value,
):
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: connection.execute(text(
            f"UPDATE {table} SET {field}=:value WHERE org_id=:org"
        ), {"value": value, "org": comms_world.first.id}))


@pytest.mark.parametrize("watermark", [-1, 9007199254740992])
def test_read_watermarks_stay_in_safe_nonnegative_range(comms_world, watermark):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_read_states", org, conversation_id=org.conversation,
            user_id=org.author, last_read_seq=watermark,
        ))


def test_preferences_reject_both_owners_and_cross_org_parents(comms_world):
    org, other = comms_world.first, comms_world.second
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_member_preferences", org, category_id=org.category,
            conversation_id=org.conversation, user_id=org.author, collapsed=False, mute="off",
        ))
        _reject(connection, "23503", lambda: _insert(
            connection, "comms_member_preferences", org, category_id=other.category,
            user_id=org.author, collapsed=False, mute="off",
        ))


def test_scope_rows_and_locks_are_null_aware_and_namespaced(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        _insert(connection, "comms_settings", org, scope="workspace", values={})
        _reject(connection, "23505", lambda: _insert(
            connection, "comms_settings", org, scope="workspace", values={},
        ))
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_settings", org, scope="category", values={},
        ))
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_settings", org, scope="workspace", category_id=org.category,
            values={},
        ))
        for namespace, key in (("setting", "mode"), ("capability", "reply")):
            _insert(connection, "comms_setting_locks", org, namespace=namespace, key=key)
            _reject(connection, "23505", lambda namespace=namespace, key=key: _insert(
                connection, "comms_setting_locks", org, namespace=namespace, key=key,
            ))
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_setting_locks", org, namespace="capability", key="manageWorkspace",
        ))
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_setting_locks", org, namespace="setting", key="reply",
        ))


@pytest.mark.parametrize("changes", [
    {"granted": False}, {"capability": "react"}, {"capability": "manageWorkspace"},
    {"capability": "manageChannel"}, {"subject": "everyone", "group_id": None,
                                     "capability": "pin"},
])
def test_capability_storage_refuses_denies_or_ungrantable_d27_shapes(comms_world, changes):
    org = comms_world.first
    values = {"scope": "workspace", "subject": "group", "group_id": org.group,
              "capability": "reply", "granted": True}
    with comms_world.owner.begin() as connection:
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_capability_grants", org, **(values | changes),
        ))


def test_everyone_capability_switch_and_block_pairs_are_scoped_unique(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        _insert(connection, "comms_capability_grants", org, scope="workspace",
                subject="everyone", capability="reply", granted=False)
        _reject(connection, "23505", lambda: _insert(
            connection, "comms_capability_grants", org, scope="workspace",
            subject="everyone", capability="reply", granted=True,
        ))
        _reject(connection, "23514", lambda: _insert(
            connection, "comms_direct_blocks", org, user_id=org.author, blocked_user_id=org.author,
        ))
        _insert(connection, "comms_direct_blocks", org,
                user_id=org.author, blocked_user_id=org.peer)
        _reject(connection, "23505", lambda: _insert(
            connection, "comms_direct_blocks", org, user_id=org.author, blocked_user_id=org.peer,
        ))
        _insert(connection, "comms_direct_blocks", org,
                user_id=org.peer, blocked_user_id=org.author)


def test_links_interactions_and_personal_rows_cannot_duplicate_live_identity(comms_world):
    ids = comms_world.seed_graph(comms_world.first)
    tables = (
        "comms_reactions", "comms_mentions", "comms_threads", "comms_thread_follows",
        "comms_message_attachments", "comms_message_record_links", "comms_personal_preferences",
        "comms_read_states", "comms_members", "comms_conversation_counters",
    )
    with comms_world.owner.begin() as connection:
        for name in tables:
            table = Base.metadata.tables[name]
            original = dict(connection.execute(select(table).where(
                table.c.id == ids[name],
            )).mappings().one())
            duplicate = original | {"id": uuid7()}
            _reject(connection, "23505",
                    lambda table=table, duplicate=duplicate: connection.execute(
                        table.insert().values(**duplicate),
                    ))


def test_unlinked_attachment_keeps_its_lifetime_message_owner(comms_world):
    org = comms_world.first
    ids = comms_world.seed_graph(org)
    with comms_world.owner.begin() as connection:
        connection.execute(text(
            "UPDATE comms_message_attachments SET is_deleted=true,deleted_at=:now WHERE id=:id"
        ), {"id": ids["comms_message_attachments"], "now": NOW})
        other_message = _message(connection, org, seq=2)
        _reject(connection, "23505", lambda: _insert(
            connection, "comms_message_attachments", org, message_id=other_message,
            file_id=org.file,
        ))
