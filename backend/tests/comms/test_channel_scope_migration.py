"""D44 upgrade over every stored pre-D44 channel shape, on the disposable database."""

import pytest
from sqlalchemy import text
from uuid6 import uuid7

from app.core.database.base import Base
from tests.comms.conftest import NOW
from tests.conftest import alembic_heads
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BEFORE_D44 = "e03383c56cde"


def _old_shapes(connection, org) -> dict[str, object]:
    tables = Base.metadata.tables
    ids = {
        name: uuid7()
        for name in (
            "open_category",
            "shared",
            "read_only",
            "grouped",
            "private",
            "direct",
            "admission",
            "grant",
        )
    }
    connection.execute(
        tables["comms_categories"]
        .insert()
        .values(
            id=ids["open_category"],
            org_id=org.id,
            name="No department",
            position=1,
        )
    )
    for key, kind, scope, category in (
        ("shared", "channel", "groups", org.category),
        ("read_only", "channel", "groups", ids["open_category"]),
        ("grouped", "channel", "groups", ids["open_category"]),
        ("private", "channel", "members", org.category),
        ("direct", "direct", "members", None),
    ):
        connection.execute(
            tables["comms_conversations"]
            .insert()
            .values(
                id=ids[key],
                org_id=org.id,
                kind=kind,
                scope=scope,
                category_id=category,
                name="" if kind == "direct" else f"Old {key}",
                topic="",
                position=0,
                created_by=org.author,
            )
        )
        connection.execute(
            tables["comms_conversation_counters"]
            .insert()
            .values(
                org_id=org.id,
                conversation_id=ids[key],
                last_seq=0,
            )
        )
    for conversation, user, role in (
        (ids["private"], org.author, "member"),
        (ids["private"], org.peer, "member"),
        (ids["direct"], org.author, "member"),
        (ids["direct"], org.peer, "member"),
        (ids["shared"], org.author, "member"),
        (ids["shared"], org.peer, "manager"),
    ):
        connection.execute(
            tables["comms_members"]
            .insert()
            .values(
                org_id=org.id,
                conversation_id=conversation,
                user_id=user,
                role=role,
                joined_at=NOW,
            )
        )
    # The fixture's two organization channels: the peer is a manager in one, a member in both.
    connection.execute(
        text("UPDATE comms_members SET role='manager' WHERE conversation_id=:id AND user_id=:peer"),
        {"id": org.other_conversation, "peer": org.peer},
    )
    for owner, conversation, category, subject, group, level in (
        ("shared", ids["shared"], None, "everyone", None, "post"),
        ("read_only", ids["read_only"], None, "everyone", None, "read"),
        ("grouped", ids["grouped"], None, "group", org.group, "post"),
        ("grant", None, org.category, "everyone", None, "read"),
    ):
        connection.execute(
            text(
                "INSERT INTO comms_conversation_groups"
                "(id,org_id,conversation_id,category_id,subject,group_id,level) "
                "VALUES(:id,:org,:conversation,:category,:subject,:group,:level)"
            ),
            {
                "id": uuid7() if owner != "grant" else ids["grant"],
                "org": org.id,
                "conversation": conversation,
                "category": category,
                "subject": subject,
                "group": group,
                "level": level,
            },
        )
    connection.execute(
        text(
            "INSERT INTO comms_admissions(id,org_id,conversation_id,user_id,kind,status) "
            "VALUES(:id,:org,:conversation,:user,'request','pending')"
        ),
        {"id": ids["admission"], "org": org.id, "conversation": ids["private"], "user": org.peer},
    )
    for key in ("join_rule", "default_member_ids", "mode"):
        connection.execute(
            tables["comms_setting_locks"]
            .insert()
            .values(
                org_id=org.id,
                namespace="setting",
                key=key,
            )
        )
    connection.execute(
        tables["comms_settings"]
        .insert()
        .values(
            org_id=org.id,
            scope="workspace",
            values={
                "join_rule": "request",
                "default_member_ids": [str(org.peer)],
                "formatting": False,
            },
        )
    )
    return ids


def test_d44_upgrade_converts_shared_channels_and_retires_hand_picked_access(comms_world):
    org, environment = comms_world.first, guarded_migration_environment()
    [head] = alembic_heads()
    # No pooled fixture connection may hold locks across the schema changes.
    comms_world.runtime.dispose()
    dispose_process_engines()
    run_alembic(environment, "downgrade", BEFORE_D44)
    try:
        with comms_world.owner.begin() as connection:
            ids = _old_shapes(connection, org)
    finally:
        run_alembic(environment, "upgrade", head)
    run_alembic(environment, "check")
    with comms_world.owner.connect() as connection:
        conversations = {
            row.id: row
            for row in connection.execute(
                text(
                    "SELECT id,scope,category_id,archived_at,is_deleted,deleted_at "
                    "FROM comms_conversations WHERE org_id=:org"
                ),
                {"org": org.id},
            )
        }
        live_members = set(
            connection.execute(
                text(
                    "SELECT conversation_id,user_id,role FROM comms_members "
                    "WHERE org_id=:org AND NOT is_deleted"
                ),
                {"org": org.id},
            ).tuples()
        )
        tables = connection.execute(
            text(
                "SELECT to_regclass('public.comms_admissions'), "
                "to_regclass('public.comms_conversation_groups')"
            )
        ).one()
        locks = set(
            connection.scalars(
                text("SELECT key FROM comms_setting_locks WHERE org_id=:org"), {"org": org.id}
            )
        )
        values = connection.scalar(
            text("SELECT values FROM comms_settings WHERE org_id=:org AND scope='workspace'"),
            {"org": org.id},
        )
    shared = conversations[ids["shared"]]
    assert (shared.scope, shared.category_id, shared.archived_at, shared.is_deleted) == (
        "organization",
        None,
        None,
        False,
    )
    # Only a channel where everyone could post converts; read-only sharing never widens.
    for key, scope in (("read_only", "groups"), ("grouped", "groups"), ("private", "members")):
        retired = conversations[ids[key]]
        assert (retired.scope, retired.is_deleted, retired.archived_at) == (scope, True, None)
        assert retired.deleted_at is not None
    assert conversations[ids["direct"]].is_deleted is False
    assert live_members == {
        (org.conversation, org.author, "member"),
        (org.other_conversation, org.author, "member"),
        (org.other_conversation, org.peer, "manager"),
        (ids["shared"], org.author, "member"),
        (ids["shared"], org.peer, "manager"),
        (ids["private"], org.author, "member"),
        (ids["direct"], org.author, "member"),
        (ids["direct"], org.peer, "member"),
    }
    assert tables == (None, None)
    assert locks == {"mode"}
    assert values == {"formatting": False}
