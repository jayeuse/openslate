import ast
import os
from collections.abc import Generator
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from tests.api_integration_support import create_owned_admin, delete_owned_admin
from tests.conftest import _assert_alembic_head, _guard_integration_database

MIGRATIONS = Path(__file__).parents[2] / "migrations" / "versions"


def _identity_snapshot_migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_drop_security_event_user_foreign_keys.py"))
    assert len(matches) == 1
    return matches[0]


def _identity_snapshot_tree() -> ast.Module:
    return ast.parse(_identity_snapshot_migration_path().read_text(encoding="utf-8"))


def _revision_values_for(tree: ast.Module) -> dict[str, object]:
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target = node.target
            value = node.value
        else:
            continue
        if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}:
            assert value is not None
            values[target.id] = ast.literal_eval(value)
    return values


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Call):
        return _call_name(node.func)
    if isinstance(node, ast.Attribute):
        return f"{_call_name(node.value)}.{node.attr}"
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _op_f_name(node: ast.AST) -> str:
    assert isinstance(node, ast.Call) and _call_name(node) == "op.f"
    assert len(node.args) == 1
    return ast.literal_eval(node.args[0])


def _keyword_value(call: ast.Call, name: str) -> object | None:
    for keyword in call.keywords:
        if keyword.arg == name:
            return ast.literal_eval(keyword.value)
    return None


def _user_timestamps_migration_path() -> Path:
    matches: list[Path] = []
    for path in MIGRATIONS.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        values: dict[str, object] = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
                value = node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                target = node.target
                value = node.value
            else:
                continue
            if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}:
                assert value is not None
                values[target.id] = ast.literal_eval(value)
        if values.get("down_revision") == "20260902_0016":
            matches.append(path)
    assert len(matches) == 1
    return matches[0]


def _user_timestamps_tree() -> ast.Module:
    return ast.parse(_user_timestamps_migration_path().read_text(encoding="utf-8"))


def _function_calls(tree: ast.Module, name: str) -> list[ast.Call]:
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == name
    ]
    assert len(functions) == 1
    return [
        statement.value
        for statement in functions[0].body
        if isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Call)
        and _call_name(statement.value).startswith("op.")
    ]


@pytest.fixture
def owned_identity_user() -> Generator[UUID, None, None]:
    runtime_url = os.getenv("DATABASE_URL") or os.environ["TEST_DATABASE_URL"]
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if owner_url is None:
        pytest.skip("MIGRATION_DATABASE_URL is required for owned identity setup")
    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    owner_engine = create_engine(owner_url)
    try:
        with owner_engine.connect() as connection:
            _assert_alembic_head(connection)
            connection.rollback()
    finally:
        owner_engine.dispose()
    actor = create_owned_admin(runtime_url, owner_url, "identity_snapshot")
    try:
        yield actor.id
    finally:
        delete_owned_admin(owner_url, actor.id)


def test_identity_snapshot_migration_is_the_single_revision_after_user_timestamps() -> None:
    migration = _identity_snapshot_tree()
    assert _revision_values_for(migration) == {
        "revision": "2c5bf7bc78fe",
        "down_revision": "a8873943bf48",
    }

    following_revisions: list[Path] = []
    for path in MIGRATIONS.glob("*.py"):
        values = _revision_values_for(ast.parse(path.read_text(encoding="utf-8")))
        if values.get("down_revision") == "a8873943bf48":
            following_revisions.append(path)
    assert sorted(following_revisions) == [_identity_snapshot_migration_path()]


def test_identity_snapshot_migration_drops_only_the_security_event_user_foreign_keys() -> None:
    upgrade_calls = _function_calls(_identity_snapshot_tree(), "upgrade")
    assert [_call_name(call) for call in upgrade_calls] == [
        "op.drop_constraint",
        "op.drop_constraint",
    ]
    assert [
        (
            _op_f_name(call.args[0]),
            ast.literal_eval(call.args[1]),
            _keyword_value(call, "type_"),
        )
        for call in upgrade_calls
    ] == [
        ("fk_security_events_actor_id_users", "security_events", "foreignkey"),
        ("fk_security_events_subject_id_users", "security_events", "foreignkey"),
    ]

    downgrade_calls = _function_calls(_identity_snapshot_tree(), "downgrade")
    assert [_call_name(call) for call in downgrade_calls] == [
        "op.create_foreign_key",
        "op.create_foreign_key",
    ]
    assert {
        (
            _op_f_name(call.args[0]),
            ast.literal_eval(call.args[1]),
            ast.literal_eval(call.args[2]),
            tuple(ast.literal_eval(call.args[3])),
            tuple(ast.literal_eval(call.args[4])),
            _keyword_value(call, "ondelete"),
        )
        for call in downgrade_calls
    } == {
        (
            "fk_security_events_actor_id_users",
            "security_events",
            "users",
            ("actor_id",),
            ("id",),
            "SET NULL",
        ),
        (
            "fk_security_events_subject_id_users",
            "security_events",
            "users",
            ("subject_id",),
            ("id",),
            "SET NULL",
        ),
    }

def test_user_timestamp_migration_is_the_single_revision_after_security_events() -> None:
    tree = _user_timestamps_tree()
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target = node.target
            value = node.value
        else:
            continue
        if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}:
            assert value is not None
            values[target.id] = ast.literal_eval(value)

    assert values["revision"] != "20260902_0016"
    assert values["down_revision"] == "20260902_0016"


def test_user_timestamp_migration_adds_only_nullable_timestamptz_columns() -> None:
    tree = _user_timestamps_tree()
    upgrade_calls = _function_calls(tree, "upgrade")
    assert [_call_name(call) for call in upgrade_calls] == [
        "op.add_column",
        "op.add_column",
        "op.add_column",
    ]

    columns: dict[str, tuple[str, object | None, object | None, bool]] = {}
    for call in upgrade_calls:
        assert len(call.args) == 2
        assert ast.literal_eval(call.args[0]) == "users"
        column = call.args[1]
        assert isinstance(column, ast.Call) and _call_name(column) == "sa.Column"
        column_name = ast.literal_eval(column.args[0])
        column_type = column.args[1]
        assert isinstance(column_type, ast.Call)
        columns[column_name] = (
            _call_name(column_type),
            _keyword_value(column_type, "timezone"),
            _keyword_value(column, "server_default"),
            _keyword_value(column, "nullable") is True,
        )

    assert columns == {
        "invitation_sent_at": ("sa.DateTime", True, None, True),
        "invitation_accepted_at": ("sa.DateTime", True, None, True),
        "tokens_valid_after": ("sa.DateTime", True, None, True),
    }

    downgrade_calls = _function_calls(tree, "downgrade")
    assert [_call_name(call) for call in downgrade_calls] == [
        "op.drop_column",
        "op.drop_column",
        "op.drop_column",
    ]
    assert [
        (ast.literal_eval(call.args[0]), ast.literal_eval(call.args[1]))
        for call in downgrade_calls
    ] == [
        ("users", "tokens_valid_after"),
        ("users", "invitation_accepted_at"),
        ("users", "invitation_sent_at"),
    ]


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_user_timestamp_migration_matches_runtime_catalog(integration_db: Session) -> None:
    columns = integration_db.connection().execute(
        text(
            """
            SELECT column_name, is_nullable, data_type, udt_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name IN (
                  'invitation_sent_at',
                  'invitation_accepted_at',
                  'tokens_valid_after'
              )
            ORDER BY column_name
            """
        )
    ).mappings().all()

    assert [
        (
            row["column_name"],
            row["is_nullable"],
            row["data_type"],
            row["udt_name"],
        )
        for row in columns
    ] == [
        ("invitation_accepted_at", "YES", "timestamp with time zone", "timestamptz"),
        ("invitation_sent_at", "YES", "timestamp with time zone", "timestamptz"),
        ("tokens_valid_after", "YES", "timestamp with time zone", "timestamptz"),
    ]


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_security_event_identity_snapshots_survive_hard_deleted_user(
    owned_identity_user: UUID,
    integration_db: Session,
) -> None:
    connection = integration_db.connection()
    user_id = owned_identity_user

    event_id = uuid7()
    connection.execute(
        text(
            """
            INSERT INTO public.security_events (
                id, occurred_at, event_type, outcome, source, operation_id,
                actor_id, subject_id, labels, metadata
            )
            VALUES (
                :id, CURRENT_TIMESTAMP, 'migration.identity_snapshot', 'success',
                'migration-test', :operation_id, :actor_id, :subject_id,
                '{}'::jsonb, '{}'::jsonb
            )
            """
        ),
        {
                "id": event_id,
            "operation_id": uuid7(),
            "actor_id": user_id,
            "subject_id": user_id,
        },
    )
    connection.execute(
        text("DELETE FROM public.users WHERE id = :user_id"),
        {"user_id": user_id},
    )

    stored_snapshot = connection.execute(
        text(
            """
            SELECT actor_id, subject_id
            FROM public.security_events
            WHERE id = :event_id
            """
        ),
        {"event_id": event_id},
    ).mappings().one()
    assert stored_snapshot["actor_id"] == user_id
    assert stored_snapshot["subject_id"] == user_id
