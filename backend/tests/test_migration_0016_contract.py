import ast
import os
import re
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session
from uuid6 import uuid7

MIGRATIONS = Path(__file__).parents[1] / "migrations" / "versions"
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
    integration_db: Session,
) -> None:
    connection = integration_db.connection()
    user_id = connection.scalar(text("SELECT id FROM public.users ORDER BY id LIMIT 1"))
    if user_id is None:
        pytest.skip("A local test user is required for the guarded hard-delete check")
    assert isinstance(user_id, UUID)

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
            "id": uuid7(),
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
            WHERE actor_id = :user_id AND subject_id = :user_id
            ORDER BY occurred_at DESC, id DESC
            LIMIT 1
            """
        ),
        {"user_id": user_id},
    ).mappings().one()
    assert stored_snapshot["actor_id"] == user_id
    assert stored_snapshot["subject_id"] == user_id


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
