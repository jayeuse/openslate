"""Profile migration preservation and constraints on guarded disposable PostgreSQL."""

import json
import subprocess

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
PREVIOUS_HEAD = "c64062dacada"
LEGACY = {"motion": "reduce", "keyboard_shortcuts": False}
REGIONAL = {
    "timezone": "Europe/London",
    "date_format": "dmy",
    "time_format": "24h",
    "week_start": "sunday",
    "start_page": "sandbox",
}


def insert_user(connection, identity, *, archived=False):
    connection.execute(
        text(
            "INSERT INTO users(id,email,username,status,role,"
            "theme_preference,appearance,is_deleted) "
            "VALUES(:id,:email,:username,'active','member','dark',"
            "CAST(:appearance AS jsonb),:archived)"
        ),
        {
            "id": identity,
            "email": f"profile-{identity}@example.test",
            "username": str(identity),
            "appearance": json.dumps(LEGACY),
            "archived": archived,
        },
    )


def insert_avatar(connection, identity, user_id):
    connection.execute(
        text(
            "INSERT INTO files(id,purpose,creator_id,filename,expected_size,object_key,state) "
            "VALUES(:id,'user_avatar',:owner,'avatar.png',100,:key,'awaiting_upload')"
        ),
        {"id": identity, "owner": user_id, "key": uuid7().hex},
    )


def test_upgrade_preserves_identity_and_legacy_preferences_and_safe_roundtrip():
    environment = guarded_migration_environment()
    run_alembic(environment, "downgrade", PREVIOUS_HEAD)
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    ids = [uuid7(), uuid7()]
    query = text(
        "SELECT id,email,username,status,role,theme_preference,appearance,is_deleted,"
        "created_at,updated_at FROM users WHERE id IN (:a,:b) ORDER BY id"
    )
    parameters = dict(zip(("a", "b"), ids, strict=True))
    try:
        with engine.begin() as connection:
            for identity, archived in zip(ids, (False, True), strict=True):
                insert_user(connection, identity, archived=archived)
            before = connection.execute(query, parameters).all()
        run_alembic(environment, "upgrade", "head")
        with engine.connect() as connection:
            assert connection.execute(query, parameters).all() == before
            assert (
                connection.execute(
                    text("SELECT phone,bio,avatar_file_id FROM users WHERE id IN (:a,:b)"),
                    parameters,
                ).all()
                == [(None, None, None)] * 2
            )
        run_alembic(environment, "downgrade", PREVIOUS_HEAD)
        run_alembic(environment, "upgrade", "head")
        with engine.connect() as connection:
            assert connection.execute(query, parameters).all() == before
    finally:
        run_alembic(environment, "upgrade", "head")
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id IN (:a,:b)"), parameters)
        engine.dispose()


@pytest.mark.parametrize(
    "invalid",
    [
        {"timezone": 1},
        {"date_format": None},
        {"date_format": "locale"},
        {"time_format": False},
        {"week_start": "tuesday"},
        {"start_page": "profile"},
        {"start_page": None},
        {"new_key": True},
    ],
)
def test_new_appearance_check_refuses_invalid_types_enums_and_unknown_keys(
    integration_owner_db, invalid
):
    connection = integration_owner_db.connection()
    identity = uuid7()
    insert_user(connection, identity)
    with pytest.raises(IntegrityError) as refused, connection.begin_nested():
        connection.execute(
            text("UPDATE users SET appearance=CAST(:value AS jsonb) WHERE id=:id"),
            {"id": identity, "value": json.dumps({**LEGACY, **invalid})},
        )
    assert refused.value.orig.diag.constraint_name == "ck_users_appearance"


def test_avatar_fk_catalogue_bounds_parent_constraint_and_set_null(integration_owner_db):
    db = integration_owner_db
    connection = db.connection()
    user_id, file_id = uuid7(), uuid7()
    insert_user(connection, user_id)
    columns = {column["name"]: column for column in inspect(connection).get_columns("users")}
    assert columns["phone"]["nullable"] and columns["phone"]["type"].length == 32
    assert columns["bio"]["nullable"] and columns["bio"]["type"].length == 280
    fk = next(
        fk
        for fk in inspect(connection).get_foreign_keys("users")
        if fk["constrained_columns"] == ["avatar_file_id"]
    )
    assert fk["referred_table"] == "files" and fk["options"]["ondelete"] == "SET NULL"
    insert_avatar(connection, file_id, user_id)
    connection.execute(
        text("UPDATE users SET avatar_file_id=:file WHERE id=:id"), {"file": file_id, "id": user_id}
    )
    for assignment in ("expected_size=2097153", "actual_size=2097153", "record_id=:record"):
        with pytest.raises(IntegrityError), connection.begin_nested():
            connection.execute(
                text(f"UPDATE files SET {assignment} WHERE id=:id"),
                {"id": file_id, "record": uuid7()},
            )
    connection.execute(text("DELETE FROM files WHERE id=:id"), {"id": file_id})
    assert (
        connection.scalar(text("SELECT avatar_file_id FROM users WHERE id=:id"), {"id": user_id})
        is None
    )
    connection.execute(
        text("UPDATE users SET appearance=CAST(:value AS jsonb) WHERE id=:id"),
        {"id": user_id, "value": json.dumps({**LEGACY, **REGIONAL})},
    )


@pytest.mark.parametrize("unrepresentable", ["text", "appearance", "avatar"])
def test_downgrade_refuses_new_data_without_changing_revision_or_rows(unrepresentable):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    user_id, file_id = uuid7(), uuid7()
    try:
        with engine.begin() as connection:
            insert_user(connection, user_id)
            if unrepresentable == "text":
                connection.execute(
                    text("UPDATE users SET phone='owned',bio='retained' WHERE id=:id"),
                    {"id": user_id},
                )
            elif unrepresentable == "appearance":
                connection.execute(
                    text("UPDATE users SET appearance=CAST(:value AS jsonb) WHERE id=:id"),
                    {"id": user_id, "value": json.dumps({**LEGACY, **REGIONAL})},
                )
            else:
                insert_avatar(connection, file_id, user_id)
            before = connection.execute(
                text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": user_id}
            ).scalar_one()
            revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", PREVIOUS_HEAD)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == revision
            assert (
                connection.scalar(
                    text("SELECT to_jsonb(u) FROM users u WHERE id=:id"), {"id": user_id}
                )
                == before
            )
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM files WHERE id=:id"), {"id": file_id})
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": user_id})
        engine.dispose()
