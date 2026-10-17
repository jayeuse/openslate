"""Personal preference storage guarantees on the fresh organization root."""

import json

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration
DEFAULT_APPEARANCE = {"motion": "system", "keyboard_shortcuts": True}


def _insert(db, identity, theme=None):
    return create_member(
        db, create_organization(db), id=identity,
        email=f"preference-{identity}@example.test", username=str(identity),
        **({"theme_preference": theme} if theme is not None else {}),
    )[0]


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        [],
        "system",
        {},
        {"motion": "system"},
        {"keyboard_shortcuts": True},
        {"motion": None, "keyboard_shortcuts": True},
        {"motion": "system", "keyboard_shortcuts": None},
        {"motion": True, "keyboard_shortcuts": True},
        {"motion": "normal", "keyboard_shortcuts": True},
        {"motion": "reduce", "keyboard_shortcuts": "false"},
        {"motion": "system", "keyboard_shortcuts": 0},
        {"motion": "system", "keyboard_shortcuts": 1},
        {"motion": "system", "keyboard_shortcuts": True, "density": "compact"},
    ],
)
def test_storage_check_is_false_for_invalid_json_and_rejects_it(integration_owner_db, invalid):
    db = integration_owner_db
    identity = uuid7()
    _insert(db, identity, "light")
    expression = db.connection().scalar(
        text("SELECT pg_get_expr(conbin,conrelid) FROM pg_constraint WHERE conname=:name"),
        {"name": "ck_users_appearance"},
    )
    assert isinstance(expression, str)
    parameters = {"appearance": json.dumps(invalid), "id": identity}
    # Evaluate the trusted catalog expression to distinguish FALSE from SQL UNKNOWN.
    assert (
        db.connection().scalar(
            text(
                f"SELECT {expression} FROM "
                "(SELECT CAST(:appearance AS jsonb) AS appearance) candidate"
            ),
            parameters,
        )
        is False
    )
    with pytest.raises(IntegrityError) as rejected, db.begin_nested():
        db.connection().execute(
            text("UPDATE users SET appearance=CAST(:appearance AS jsonb) WHERE id=:id"), parameters
        )
    assert rejected.value.orig.diag.constraint_name == "ck_users_appearance"


def test_storage_defaults_and_not_null_match_orm(integration_owner_db):
    db = integration_owner_db
    identity = uuid7()
    _insert(db, identity)
    row = (
        db.connection()
        .execute(
            text("SELECT theme_preference,appearance FROM users WHERE id=:id"), {"id": identity}
        )
        .one()
    )
    assert row == ("system", DEFAULT_APPEARANCE)
    user, membership = create_member(
        None, create_organization(db), email=f"orm-{uuid7()}@example.test", username=str(uuid7())
    )
    db.add(user)
    db.flush()
    db.add(membership)
    db.flush()
    assert user.theme_preference == "system" and user.appearance == DEFAULT_APPEARANCE
    with pytest.raises(IntegrityError) as rejected, db.begin_nested():
        db.connection().execute(
            text("UPDATE users SET appearance=NULL WHERE id=:id"), {"id": identity}
        )
    assert rejected.value.orig.sqlstate == "23502"
    db.connection().execute(
        text("UPDATE users SET appearance=:appearance WHERE id=:id"),
        {
            "appearance": json.dumps({"motion": "reduce", "keyboard_shortcuts": False}),
            "id": identity,
        },
    )
    assert db.connection().scalar(
        text("SELECT appearance FROM users WHERE id=:id"), {"id": identity}
    ) == {"motion": "reduce", "keyboard_shortcuts": False}
