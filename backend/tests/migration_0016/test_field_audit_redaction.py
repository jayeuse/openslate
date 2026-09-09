import ast
import os
import re
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

MIGRATIONS = Path(__file__).parents[2] / "migrations" / "versions"


def _audit_redaction_migration_path() -> Path:
    matches: list[Path] = []
    for path in MIGRATIONS.glob("*.py"):
        values = _revision_values_for(ast.parse(path.read_text(encoding="utf-8")))
        if values.get("down_revision") == "2c5bf7bc78fe":
            matches.append(path)
    assert len(matches) == 1
    return matches[0]


def _audit_redaction_tree() -> ast.Module:
    return ast.parse(_audit_redaction_migration_path().read_text(encoding="utf-8"))


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


def _keyword_value(call: ast.Call, name: str) -> object | None:
    for keyword in call.keywords:
        if keyword.arg == name:
            return ast.literal_eval(keyword.value)
    return None


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


def test_field_audit_redaction_migration_is_the_single_revision_after_identity_snapshot() -> None:
    migration = _audit_redaction_tree()
    assert _revision_values_for(migration)["down_revision"] == "2c5bf7bc78fe"

    following_revisions: list[Path] = []
    for path in MIGRATIONS.glob("*.py"):
        values = _revision_values_for(ast.parse(path.read_text(encoding="utf-8")))
        if values.get("down_revision") == "2c5bf7bc78fe":
            following_revisions.append(path)
    assert sorted(following_revisions) == [_audit_redaction_migration_path()]


def test_field_audit_redaction_migration_adds_only_the_nonnull_false_default_column() -> None:
    tree = _audit_redaction_tree()
    upgrade_calls = _function_calls(tree, "upgrade")
    assert [_call_name(call) for call in upgrade_calls] == ["op.add_column"]

    add_column = upgrade_calls[0]
    assert ast.literal_eval(add_column.args[0]) == "fields"
    column = add_column.args[1]
    assert isinstance(column, ast.Call) and _call_name(column) == "sa.Column"
    assert ast.literal_eval(column.args[0]) == "audit_redacted"
    assert _call_name(column.args[1]) == "sa.Boolean"
    assert _keyword_value(column, "nullable") is False
    server_default = next(
        keyword.value for keyword in column.keywords if keyword.arg == "server_default"
    )
    assert isinstance(server_default, ast.Call) and _call_name(server_default) == "sa.text"
    assert ast.literal_eval(server_default.args[0]) == "false"

    source = re.sub(r"\s+", " ", _audit_redaction_migration_path().read_text(encoding="utf-8"))
    assert "audit_logs" not in source.casefold()
    assert "update" not in source.casefold()
    assert "create_index" not in source.casefold()
    assert "constraint" not in source.casefold()

    downgrade_calls = _function_calls(tree, "downgrade")
    assert [_call_name(call) for call in downgrade_calls] == ["op.drop_column"]
    assert [ast.literal_eval(call.args[0]) for call in downgrade_calls] == ["fields"]
    assert [ast.literal_eval(call.args[1]) for call in downgrade_calls] == ["audit_redacted"]


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_field_audit_redaction_column_matches_runtime_catalog(integration_db: Session) -> None:
    connection = integration_db.connection()
    column = connection.execute(
        text(
            """
            SELECT is_nullable, data_type, udt_name, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'fields'
              AND column_name = 'audit_redacted'
            """
        )
    ).mappings().one()
    assert dict(column) == {
        "is_nullable": "NO",
        "data_type": "boolean",
        "udt_name": "bool",
        "column_default": "false",
    }

    assert connection.execute(
        text(
            """
            SELECT indexname
            FROM pg_catalog.pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'fields'
              AND indexdef ILIKE '%audit_redacted%'
            """
        )
    ).scalars().all() == []

    assert connection.execute(
        text(
            """
            SELECT conname
            FROM pg_catalog.pg_constraint
            WHERE conrelid = 'public.fields'::regclass
              AND pg_get_constraintdef(oid, true) ILIKE '%audit_redacted%'
            """
        )
    ).scalars().all() == []

