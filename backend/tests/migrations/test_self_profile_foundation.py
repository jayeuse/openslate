"""Profile constraints on the fresh organization root."""

import json

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration
LEGACY = {"motion": "reduce", "keyboard_shortcuts": False}
REGIONAL = {
    "timezone": "Europe/London",
    "date_format": "dmy",
    "time_format": "24h",
    "week_start": "sunday",
    "start_page": "sandbox",
}


def insert_user(db, identity):
    create_member(
        db, create_organization(db), id=identity,
        email=f"profile-{identity}@example.test", username=str(identity),
        theme_preference="dark", appearance=LEGACY,
    )


def insert_avatar(connection, identity, user_id):
    connection.execute(
        text(
            "INSERT INTO files(id,purpose,creator_id,filename,expected_size,object_key,state) "
            "VALUES(:id,'user_avatar',:owner,'avatar.png',100,:key,'awaiting_upload')"
        ),
        {"id": identity, "owner": user_id, "key": uuid7().hex},
    )


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
    db = integration_owner_db
    connection = db.connection()
    identity = uuid7()
    insert_user(db, identity)
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
    insert_user(db, user_id)
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
