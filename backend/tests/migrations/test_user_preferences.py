"""Personal preference storage and upgrade guarantees on guarded PostgreSQL."""

import json
import subprocess

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users.models import User
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
PREVIOUS_HEAD = "32182dce4bf8"
DEFAULT_APPEARANCE = {"motion": "system", "keyboard_shortcuts": True}


def _insert(connection, identity, theme=None, *, archived=False):
    parameters = {
        "id": identity,
        "email": f"preference-{identity}@example.test",
        "username": str(identity),
        "archived": archived,
        "theme": theme,
    }
    connection.execute(
        text(
            "INSERT INTO users(id,email,username,status,role,is_deleted"
            + (",theme_preference" if theme is not None else "")
            + ") VALUES(:id,:email,:username,'active','member',:archived"
            + (",:theme" if theme is not None else "")
            + ")"
        ),
        parameters,
    )


def test_upgrade_preserves_existing_modes_and_defaults_new_users_to_system():
    environment = guarded_migration_environment()
    run_alembic(environment, "downgrade", PREVIOUS_HEAD)
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identities = [uuid7() for _ in range(3)]
    try:
        with engine.begin() as connection:
            _insert(connection, identities[0], "light")
            _insert(connection, identities[1], "dark", archived=True)
            before = connection.execute(
                text(
                    "SELECT id,theme_preference,email,username,status,role,is_deleted,"
                    "created_at,updated_at FROM users WHERE id IN (:light,:dark) ORDER BY id"
                ),
                {"light": identities[0], "dark": identities[1]},
            ).all()
        run_alembic(environment, "upgrade", "head")
        with engine.begin() as connection:
            _insert(connection, identities[2])
            # Observable first red precedes any reference to the new column.
            assert (
                connection.scalar(
                    text("SELECT theme_preference FROM users WHERE id=:id"),
                    {"id": identities[2]},
                )
                == "system"
            )
            assert (
                connection.execute(
                    text(
                        "SELECT id,theme_preference,email,username,status,role,is_deleted,"
                        "created_at,updated_at FROM users WHERE id IN (:light,:dark) ORDER BY id"
                    ),
                    {"light": identities[0], "dark": identities[1]},
                ).all()
                == before
            )
            assert (
                connection.execute(
                    text("SELECT to_jsonb(u)->'appearance' FROM users u WHERE id IN (:a,:b,:c)"),
                    dict(zip(("a", "b", "c"), identities, strict=True)),
                )
                .scalars()
                .all()
                == [DEFAULT_APPEARANCE] * 3
            )
    finally:
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM users WHERE id IN (:a,:b,:c)"),
                dict(zip(("a", "b", "c"), identities, strict=True)),
            )
        engine.dispose()
        run_alembic(environment, "upgrade", "head")


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
    _insert(db.connection(), identity, "light")
    expression = db.connection().scalar(
        text("SELECT pg_get_expr(conbin,conrelid) FROM pg_constraint WHERE conname=:name"),
        {"name": "ck_users_appearance"},
    )
    assert isinstance(expression, str)
    parameters = {"appearance": json.dumps(invalid), "id": identity}
    # The catalog expression is trusted schema, not request text. Inspecting its
    # result distinguishes a FALSE check from SQL UNKNOWN that would admit null.
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
    _insert(db.connection(), identity)
    row = (
        db.connection()
        .execute(
            text("SELECT theme_preference,appearance FROM users WHERE id=:id"), {"id": identity}
        )
        .one()
    )
    assert row == ("system", DEFAULT_APPEARANCE)
    user = User(email=f"orm-{uuid7()}@example.test", username=str(uuid7()), role="member")
    db.add(user)
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


@pytest.mark.parametrize("meaningful", ["system", "reduce", "shortcuts-off"])
def test_downgrade_refuses_unrepresentable_preferences_without_changes(meaningful):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity = uuid7()
    try:
        with engine.begin() as connection:
            _insert(connection, identity, "system" if meaningful == "system" else "light")
            appearance = {
                "motion": "reduce" if meaningful == "reduce" else "system",
                "keyboard_shortcuts": meaningful != "shortcuts-off",
            }
            connection.execute(
                text("UPDATE users SET appearance=CAST(:appearance AS jsonb) WHERE id=:id"),
                {"appearance": json.dumps(appearance), "id": identity},
            )
            revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", PREVIOUS_HEAD)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == revision
            assert (
                connection.scalar(
                    text("SELECT appearance FROM users WHERE id=:id"), {"id": identity}
                )
                == appearance
            )
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
        engine.dispose()
        run_alembic(environment, "upgrade", "head")


def test_representable_preferences_round_trip_without_mode_changes():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity = uuid7()
    try:
        with engine.begin() as connection:
            _insert(connection, identity, "dark")
        run_alembic(environment, "downgrade", PREVIOUS_HEAD)
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT theme_preference FROM users WHERE id=:id"), {"id": identity}
                )
                == "dark"
            )
        run_alembic(environment, "upgrade", "head")
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT theme_preference,appearance FROM users WHERE id=:id"), {"id": identity}
            ).one() == ("dark", DEFAULT_APPEARANCE)
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
        engine.dispose()
        run_alembic(environment, "upgrade", "head")
