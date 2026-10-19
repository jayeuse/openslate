"""Stored access, preference and settings invariants on real PostgreSQL."""

import re

import pytest
from sqlalchemy import inspect, text

from app.systems.comms.capabilities import CAPABILITIES, GROUP_SCOPES
from app.systems.comms.settings.resolution import SettingsValues
from tests.comms.conftest import NOW
from tests.comms.constraint_support import _insert, _reject

pytestmark = pytest.mark.integration


def test_settings_and_group_capability_keys_match_database_constraints(integration_owner_db):
    connection = integration_owner_db.connection()
    schema = inspect(connection)
    locks = schema.get_check_constraints("comms_setting_locks")
    grants = schema.get_check_constraints("comms_capability_grants")
    lock = next(c["sqltext"] for c in locks if c["name"] == "ck_comms_setting_locks_key")
    grant = next(
        c["sqltext"] for c in grants if c["name"] == "ck_comms_capability_grants_subject_capability"
    )
    lock_query = text(f"SELECT {lock} FROM (SELECT :namespace AS namespace, :key AS key) candidate")
    grant_query = text(
        f"SELECT {grant} FROM (SELECT 'group' AS subject, true AS granted, "
        "'present' AS group_id, :scope AS scope, :capability AS capability) candidate"
    )
    keys = (
        set(re.findall(r"'([^']+)'", lock)) | set(SettingsValues.model_fields) | set(CAPABILITIES)
    )
    for namespace, expected in (
        ("setting", set(SettingsValues.model_fields) - {"dm_rule"}),
        ("capability", set(CAPABILITIES) - {"manageWorkspace"}),
    ):
        for key in keys:
            allowed = connection.scalar(lock_query, {"namespace": namespace, "key": key})
            assert allowed is (key in expected)
    capabilities = set(re.findall(r"'([^']+)'", grant)) | set(CAPABILITIES)
    for capability in capabilities:
        for scope in ("workspace", "category", "channel"):
            allowed = connection.scalar(grant_query, {"scope": scope, "capability": capability})
            assert allowed is (scope in GROUP_SCOPES.get(capability, ()))


@pytest.mark.parametrize("owner", ["category_id", "conversation_id"])
@pytest.mark.parametrize("subject", ["everyone", "group"])
def test_access_uniqueness_is_per_owner_and_keeps_soft_deleted_history(comms_world, owner, subject):
    org = comms_world.first
    values = {
        owner: org.category if owner == "category_id" else org.conversation,
        "subject": subject,
        "group_id": org.group if subject == "group" else None,
        "level": "read",
    }
    with comms_world.owner.begin() as connection:
        identity = _insert(connection, "comms_conversation_groups", org, **values)
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_conversation_groups",
                org,
                **(values | {"level": "post"}),
            ),
        )
        connection.execute(
            text(
                "UPDATE comms_conversation_groups SET is_deleted=true, deleted_at=:now WHERE id=:id"
            ),
            {"id": identity, "now": NOW},
        )
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
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_conversation_groups",
                org,
                **values,
            ),
        )


@pytest.mark.parametrize("category", [True, False])
def test_preferences_have_exclusive_owner_fields_and_one_row_per_person(comms_world, category):
    org = comms_world.first
    values = {"user_id": org.author, "mute": "off"}
    if category:
        values |= {"category_id": org.category, "collapsed": False}
        illegal = {"notify": "all"}
    else:
        values |= {
            "conversation_id": org.conversation,
            "notify": "all",
            "starred": False,
            "hidden": False,
            "manual_unread": False,
        }
        illegal = {"collapsed": False}
    with comms_world.owner.begin() as connection:
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_member_preferences",
                org,
                **(values | illegal),
            ),
        )
        _insert(connection, "comms_member_preferences", org, **values)
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_member_preferences",
                org,
                **values,
            ),
        )
        _insert(connection, "comms_member_preferences", org, **(values | {"user_id": org.peer}))


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"category_id": None}, id="no-owner"),
        pytest.param({"mute": "until", "muted_until": None}, id="until-needs-time"),
        pytest.param({"mute": "off", "muted_until": NOW}, id="off-has-no-time"),
    ],
)
def test_category_preference_owner_and_mute_shape(comms_world, changes):
    org = comms_world.first
    values = {"user_id": org.author, "category_id": org.category, "collapsed": False, "mute": "off"}
    with comms_world.owner.begin() as connection:
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_member_preferences",
                org,
                **(values | changes),
            ),
        )


def test_optional_parent_fks_still_reject_cross_org_and_restrict_parent_deletion(comms_world):
    org, other = comms_world.first, comms_world.second
    with comms_world.owner.begin() as connection:
        for values in (
            {"category_id": other.category, "subject": "everyone"},
            {"conversation_id": other.conversation, "subject": "everyone"},
            {"category_id": org.category, "subject": "group", "group_id": other.group},
        ):
            _reject(
                connection,
                "23503",
                lambda values=values: _insert(
                    connection,
                    "comms_conversation_groups",
                    org,
                    level="read",
                    **values,
                ),
            )
        _insert(
            connection,
            "comms_conversation_groups",
            org,
            category_id=org.category,
            subject="group",
            group_id=org.group,
            level="read",
        )
        for table, identity in (("groups", org.group), ("comms_categories", org.category)):
            _reject(
                connection,
                "23503",
                lambda table=table, identity=identity: connection.execute(
                    text(f"DELETE FROM {table} WHERE id=:id"),
                    {"id": identity},
                ),
            )


def test_preferences_reject_both_owners_and_cross_org_parents(comms_world):
    org, other = comms_world.first, comms_world.second
    with comms_world.owner.begin() as connection:
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_member_preferences",
                org,
                category_id=org.category,
                conversation_id=org.conversation,
                user_id=org.author,
                collapsed=False,
                mute="off",
            ),
        )
        _reject(
            connection,
            "23503",
            lambda: _insert(
                connection,
                "comms_member_preferences",
                org,
                category_id=other.category,
                user_id=org.author,
                collapsed=False,
                mute="off",
            ),
        )


def test_scope_rows_and_locks_are_null_aware_and_namespaced(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        _insert(connection, "comms_settings", org, scope="workspace", values={})
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_settings",
                org,
                scope="workspace",
                values={},
            ),
        )
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_settings",
                org,
                scope="category",
                values={},
            ),
        )
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_settings",
                org,
                scope="workspace",
                category_id=org.category,
                values={},
            ),
        )
        for namespace, key in (("setting", "mode"), ("capability", "reply")):
            _insert(connection, "comms_setting_locks", org, namespace=namespace, key=key)
            _reject(
                connection,
                "23505",
                lambda namespace=namespace, key=key: _insert(
                    connection,
                    "comms_setting_locks",
                    org,
                    namespace=namespace,
                    key=key,
                ),
            )
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_setting_locks",
                org,
                namespace="capability",
                key="manageWorkspace",
            ),
        )
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_setting_locks",
                org,
                namespace="setting",
                key="reply",
            ),
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"granted": False},
        {"capability": "react"},
        {"capability": "manageWorkspace"},
        {"capability": "manageChannel"},
        {"subject": "everyone", "group_id": None, "capability": "pin"},
    ],
)
def test_capability_storage_refuses_denies_or_ungrantable_d27_shapes(comms_world, changes):
    org = comms_world.first
    values = {
        "scope": "workspace",
        "subject": "group",
        "group_id": org.group,
        "capability": "reply",
        "granted": True,
    }
    with comms_world.owner.begin() as connection:
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_capability_grants",
                org,
                **(values | changes),
            ),
        )


def test_everyone_capability_switch_and_block_pairs_are_scoped_unique(comms_world):
    org = comms_world.first
    with comms_world.owner.begin() as connection:
        _insert(
            connection,
            "comms_capability_grants",
            org,
            scope="workspace",
            subject="everyone",
            capability="reply",
            granted=False,
        )
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_capability_grants",
                org,
                scope="workspace",
                subject="everyone",
                capability="reply",
                granted=True,
            ),
        )
        _reject(
            connection,
            "23514",
            lambda: _insert(
                connection,
                "comms_direct_blocks",
                org,
                user_id=org.author,
                blocked_user_id=org.author,
            ),
        )
        _insert(
            connection, "comms_direct_blocks", org, user_id=org.author, blocked_user_id=org.peer
        )
        _reject(
            connection,
            "23505",
            lambda: _insert(
                connection,
                "comms_direct_blocks",
                org,
                user_id=org.author,
                blocked_user_id=org.peer,
            ),
        )
        _insert(
            connection, "comms_direct_blocks", org, user_id=org.peer, blocked_user_id=org.author
        )
