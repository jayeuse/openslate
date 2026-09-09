import ast
import os
import re
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

MIGRATIONS = Path(__file__).parents[2] / "migrations" / "versions"
EXPECTED_COLUMNS = {
    "id": ("sa.UUID", None, None, False),
    "occurred_at": ("sa.DateTime", None, True, False),
    "event_type": ("sa.String", 100, None, False),
    "outcome": ("sa.String", 20, None, False),
    "source": ("sa.String", 100, None, False),
    "operation_id": ("sa.UUID", None, None, False),
    "actor_id": ("sa.UUID", None, None, True),
    "subject_id": ("sa.UUID", None, None, True),
    "labels": ("postgresql.JSONB", None, None, False),
    "fingerprint": ("sa.String", 128, None, True),
    "reason": ("sa.String", 500, None, True),
    "request_id": ("sa.UUID", None, None, True),
    "request_method": ("sa.String", 10, None, True),
    "request_path": ("sa.Text", None, None, True),
    "metadata": ("postgresql.JSONB", None, None, False),
}


def _migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_0016_*.py"))
    assert len(matches) == 1
    return matches[0]


def _identity_snapshot_migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_drop_security_event_user_foreign_keys.py"))
    assert len(matches) == 1
    return matches[0]


def _audit_redaction_migration_path() -> Path:
    matches: list[Path] = []
    for path in MIGRATIONS.glob("*.py"):
        values = _revision_values_for(ast.parse(path.read_text(encoding="utf-8")))
        if values.get("down_revision") == "2c5bf7bc78fe":
            matches.append(path)
    assert len(matches) == 1
    return matches[0]


def _source() -> str:
    return re.sub(r"\s+", " ", _migration_path().read_text(encoding="utf-8")).casefold()


def _tree() -> ast.Module:
    return ast.parse(_migration_path().read_text(encoding="utf-8"))


def _identity_snapshot_tree() -> ast.Module:
    return ast.parse(_identity_snapshot_migration_path().read_text(encoding="utf-8"))


def _audit_redaction_tree() -> ast.Module:
    return ast.parse(_audit_redaction_migration_path().read_text(encoding="utf-8"))


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


def _create_table_call() -> ast.Call:
    calls = [
        node
        for node in ast.walk(_tree())
        if isinstance(node, ast.Call) and _call_name(node) == "op.create_table"
    ]
    assert len(calls) == 1
    assert ast.literal_eval(calls[0].args[0]) == "security_events"
    return calls[0]


def _column_contract() -> dict[str, tuple[str, object | None, object | None, bool]]:
    columns: dict[str, tuple[str, object | None, object | None, bool]] = {}
    for argument in _create_table_call().args[1:]:
        if not isinstance(argument, ast.Call) or _call_name(argument) != "sa.Column":
            continue
        name = ast.literal_eval(argument.args[0])
        column_type = argument.args[1]
        assert isinstance(column_type, ast.Call)
        nullable = _keyword_value(argument, "nullable")
        assert isinstance(nullable, bool)
        columns[name] = (
            _call_name(column_type),
            _keyword_value(column_type, "length"),
            _keyword_value(column_type, "timezone"),
            nullable,
        )
    return columns


def _revision_values() -> dict[str, object]:
    values: dict[str, object] = {}
    for node in _tree().body:
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


def _foreign_key_contract() -> dict[str, tuple[object, ...]]:
    constraints: dict[str, tuple[object, ...]] = {}
    for node in ast.walk(_tree()):
        if not isinstance(node, ast.Call) or _call_name(node) != "op.create_foreign_key":
            continue
        constraints[ast.literal_eval(node.args[0])] = (
            ast.literal_eval(node.args[1]),
            ast.literal_eval(node.args[2]),
            tuple(ast.literal_eval(node.args[3])),
            tuple(ast.literal_eval(node.args[4])),
            _keyword_value(node, "ondelete"),
        )
    return constraints


def _index_contract() -> dict[str, tuple[object, ...]]:
    indexes: dict[str, tuple[object, ...]] = {}
    for node in ast.walk(_tree()):
        if not isinstance(node, ast.Call) or _call_name(node) != "op.create_index":
            continue
        indexes[ast.literal_eval(node.args[0])] = (
            ast.literal_eval(node.args[1]),
            tuple(ast.literal_eval(node.args[2])),
            _keyword_value(node, "unique"),
        )
    return indexes


def test_security_events_migration_is_chained_after_decimal_normalization() -> None:
    assert _revision_values() == {
        "revision": "20260902_0016",
        "down_revision": "20260831_0015",
    }


def test_security_events_migration_defines_exact_columns_and_types() -> None:
    assert _column_contract() == EXPECTED_COLUMNS


def test_security_events_migration_defines_outcome_check_foreign_keys_and_indexes() -> None:
    check_constraints = [
        node
        for node in ast.walk(_create_table_call())
        if isinstance(node, ast.Call) and _call_name(node) == "sa.CheckConstraint"
    ]
    assert len(check_constraints) == 1
    check = check_constraints[0]
    assert ast.literal_eval(check.args[0]) == (
        "outcome IN ('attempt', 'success', 'denied', 'failure', 'partial')"
    )
    assert _keyword_value(check, "name") == "ck_security_events_outcome"

    assert _foreign_key_contract() == {
        "fk_security_events_actor_id_users": (
            "security_events",
            "users",
            ("actor_id",),
            ("id",),
            "SET NULL",
        ),
        "fk_security_events_subject_id_users": (
            "security_events",
            "users",
            ("subject_id",),
            ("id",),
            "SET NULL",
        ),
    }
    assert _index_contract() == {
        "ix_security_events_occurred_at_id": (
            "security_events",
            ("occurred_at", "id"),
            False,
        ),
        "ix_security_events_operation_id": (
            "security_events",
            ("operation_id",),
            False,
        ),
    }


def test_security_events_migration_defines_exact_rls_and_privilege_contract() -> None:
    source = _source()

    assert "alter table public.security_events enable row level security" in source
    assert re.search(
        r"create policy openslate_app_security_events_select on public\.security_events "
        r"as permissive for select to openslate_app using \(true\)",
        source,
    )
    assert re.search(
        r"create policy openslate_app_security_events_insert on public\.security_events "
        r"as permissive for insert to openslate_app with check \(true\)",
        source,
    )

    grants = re.findall(
        r"grant\s+([^;]+?)\s+on table public\.security_events\s+to openslate_app",
        source,
    )
    assert grants == ["select, insert"]
    assert not re.search(
        r"grant\s+[^;]*\b(?:update|delete)\b[^;]*security_events", source
    )

    policies = re.findall(
        r"create policy\s+\S+\s+on public\.security_events\s+"
        r"as permissive\s+for\s+(select|insert|update|delete)\s+to\s+openslate_app",
        source,
    )
    assert policies == ["select", "insert"]
    assert not re.search(
        r"create policy\s+[^;]*on public\.security_events\s+"
        r"as permissive\s+for\s+(?:update|delete)\b",
        source,
    )

    assert re.search(
        r"revoke all privileges on table public\.security_events\s+"
        r"from public, anon, authenticated, service_role",
        source,
    )


def test_security_events_downgrade_contract_explicitly_discards_event_evidence() -> None:
    """The downgrade is destructive and must not pretend to restore audit evidence."""
    downgrade = _source().split("def downgrade()", maxsplit=1)[1]

    assert re.search(r"op\.drop_table\(\s*['\"]security_events['\"]\s*\)", downgrade)
    assert "insert into" not in downgrade
    assert "security_events" in downgrade


def _assert_security_events_catalog_contract(connection, *, require_runtime_role: bool) -> None:
    relation = connection.execute(
        text(
            """
            SELECT current_user AS database_role,
                   pg_get_userbyid(c.relowner) AS owner_role,
                   c.relrowsecurity AS rls_enabled
            FROM pg_catalog.pg_class AS c
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'security_events'
            """
        )
    ).mappings().one()
    if require_runtime_role:
        assert relation["database_role"] == "openslate_runtime"
    assert relation["owner_role"] not in {"openslate_runtime", "openslate_app"}
    assert relation["rls_enabled"] is True

    columns = connection.execute(
        text(
            """
            SELECT column_name, is_nullable, data_type, udt_name,
                   character_maximum_length
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'security_events'
            ORDER BY ordinal_position
            """
        )
    ).mappings().all()
    expected_columns = (
        ("id", "NO", "uuid", "uuid", None),
        ("occurred_at", "NO", "timestamp with time zone", "timestamptz", None),
        ("event_type", "NO", "character varying", "varchar", 100),
        ("outcome", "NO", "character varying", "varchar", 20),
        ("source", "NO", "character varying", "varchar", 100),
        ("operation_id", "NO", "uuid", "uuid", None),
        ("actor_id", "YES", "uuid", "uuid", None),
        ("subject_id", "YES", "uuid", "uuid", None),
        ("labels", "NO", "jsonb", "jsonb", None),
        ("fingerprint", "YES", "character varying", "varchar", 128),
        ("reason", "YES", "character varying", "varchar", 500),
        ("request_id", "YES", "uuid", "uuid", None),
        ("request_method", "YES", "character varying", "varchar", 10),
        ("request_path", "YES", "text", "text", None),
        ("metadata", "NO", "jsonb", "jsonb", None),
    )
    assert [
        (
            row["column_name"],
            row["is_nullable"],
            row["data_type"],
            row["udt_name"],
            row["character_maximum_length"],
        )
        for row in columns
    ] == list(expected_columns)

    constraints = connection.execute(
        text(
            """
            SELECT conname, contype, pg_get_constraintdef(oid, true) AS definition
            FROM pg_catalog.pg_constraint
            WHERE conrelid = 'public.security_events'::regclass
            """
        )
    ).mappings().all()
    checks = [row for row in constraints if row["contype"] == "c"]
    assert {row["conname"] for row in checks} == {"ck_security_events_outcome"}
    check_definition = checks[0]["definition"].casefold()
    assert all(
        value in check_definition
        for value in ("attempt", "success", "denied", "failure", "partial")
    )

    foreign_keys = [row for row in constraints if row["contype"] == "f"]
    assert foreign_keys == []

    indexes = {
        row["indexname"]: re.sub(r"\s+", " ", row["indexdef"]).casefold()
        for row in connection.execute(
            text(
                "SELECT indexname, indexdef FROM pg_catalog.pg_indexes "
                "WHERE schemaname = 'public' AND tablename = 'security_events'"
            )
        ).mappings()
    }
    assert {
        "ix_security_events_occurred_at_id",
        "ix_security_events_operation_id",
    } <= indexes.keys()
    assert "(occurred_at, id)" in indexes["ix_security_events_occurred_at_id"]
    assert "(operation_id)" in indexes["ix_security_events_operation_id"]

    policies = connection.execute(
        text(
            """
            SELECT policyname, permissive, roles::text AS roles, cmd, qual, with_check
            FROM pg_catalog.pg_policies
            WHERE schemaname = 'public' AND tablename = 'security_events'
            ORDER BY policyname
            """
        )
    ).mappings().all()
    assert {
        (
            row["policyname"],
            row["permissive"],
            row["roles"],
            row["cmd"],
            row["qual"],
            row["with_check"],
        )
        for row in policies
    } == {
        (
            "openslate_app_security_events_insert",
            "PERMISSIVE",
            "{openslate_app}",
            "INSERT",
            None,
            "true",
        ),
        (
            "openslate_app_security_events_select",
            "PERMISSIVE",
            "{openslate_app}",
            "SELECT",
            "true",
            None,
        ),
    }

    privileges = connection.execute(
        text(
            """
            SELECT has_table_privilege(
                       'openslate_app', 'public.security_events', 'SELECT'
                   ) AS app_select,
                   has_table_privilege(
                       'openslate_app', 'public.security_events', 'INSERT'
                   ) AS app_insert,
                   has_table_privilege(
                       'openslate_app', 'public.security_events', 'UPDATE'
                   ) AS app_update,
                   has_table_privilege(
                       'openslate_app', 'public.security_events', 'DELETE'
                   ) AS app_delete
            """
        )
    ).mappings().one()
    assert dict(privileges) == {
        "app_select": True,
        "app_insert": True,
        "app_update": False,
        "app_delete": False,
    }

    for role in ("anon", "authenticated", "service_role"):
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert connection.scalar(
                text(
                    "SELECT has_table_privilege(:role, "
                    "'public.security_events', :privilege)"
                ),
                {"role": role, "privilege": privilege},
            ) is False

    acl_rows = connection.execute(
        text(
            """
            SELECT COALESCE(grantee_role.rolname, 'PUBLIC') AS grantee,
                   acl.privilege_type, acl.is_grantable
            FROM pg_catalog.pg_class AS table_row
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = table_row.relnamespace
            CROSS JOIN LATERAL aclexplode(table_row.relacl) AS acl
            LEFT JOIN pg_catalog.pg_roles AS grantee_role
              ON grantee_role.oid = acl.grantee
            WHERE namespace.nspname = 'public'
              AND table_row.relname = 'security_events'
              AND (acl.grantee = 0 OR grantee_role.rolname IN (
                  'openslate_app', 'anon', 'authenticated', 'service_role'
              ))
            """
        )
    ).mappings().all()
    assert {
        (row["grantee"], row["privilege_type"], row["is_grantable"])
        for row in acl_rows
    } == {
        ("openslate_app", "INSERT", False),
        ("openslate_app", "SELECT", False),
    }


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_security_events_migration_matches_runtime_catalog(integration_db: Session) -> None:
    _assert_security_events_catalog_contract(
        integration_db.connection(),
        require_runtime_role=True,
    )
