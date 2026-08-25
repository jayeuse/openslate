import ast
import importlib.util
import re
from pathlib import Path
from types import ModuleType

import pytest

MIGRATIONS = Path(__file__).parents[1] / "migrations" / "versions"
ALEMBIC_ENV = Path(__file__).parents[1] / "migrations" / "env.py"
DOMAIN_TABLES = ("users", "roles", "departments", "modules", "fields", "records")


def _migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_0010_*.py"))
    assert matches, "Alembic 0010 migration is not implemented"
    assert len(matches) == 1, "Alembic 0010 must have one migration file"
    return matches[0]


def _source() -> str:
    return re.sub(r"\s+", " ", _migration_path().read_text(encoding="utf-8")).casefold()


def _revision_values() -> dict[str, object]:
    tree = ast.parse(_migration_path().read_text(encoding="utf-8"))
    values: dict[str, object] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}:
            values[target.id] = ast.literal_eval(node.value)
    return values


def _migration_module() -> ModuleType:
    path = _migration_path()
    spec = importlib.util.spec_from_file_location("migration_0010", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_revision_is_chained_after_0009() -> None:
    values = _revision_values()

    assert values["revision"] == "20260819_0010"
    assert values["down_revision"] == "20260819_0009"


def test_upgrade_removes_local_password_and_uuid_generation() -> None:
    source = _source()

    assert re.search(r"op\.drop_column\( ['\"]users['\"], ['\"]password_hash['\"]", source)
    assert re.search(
        r"op\.alter_column\( ['\"]users['\"].{0,300}['\"]id['\"].{0,300}"
        r"server_default\s*=\s*none",
        source,
    )


def test_upgrade_adds_profile_columns_and_auth_foreign_key() -> None:
    source = _source()

    for column in ("email", "status"):
        assert re.search(
            rf"op\.add_column\( ['\"]users['\"], sa\.column\( ['\"]{column}['\"]",
            source,
        )
    assert (
        re.search(
            r"op\.create_foreign_key\( .{0,250}['\"]users['\"].{0,250}"
            r"['\"]auth\.users['\"].{0,250}cascade",
            source,
        )
        or re.search(r"references\s+auth\.users\s*\(\s*id\s*\).{0,40}cascade", source)
    )


def test_profile_trigger_is_security_definer_with_fixed_search_path() -> None:
    source = _source()

    assert "security definer" in source
    assert re.search(r"set\s+search_path\s*=\s*(?:pg_catalog\s*,\s*)?public", source)
    assert re.search(r"create\s+(?:or\s+replace\s+)?function", source)
    assert re.search(r"create\s+trigger .{0,200}after\s+insert\s+on\s+auth\.users", source)


def test_profile_trigger_assigns_the_default_member_role() -> None:
    source = _source()

    assert "insert into" in source and "public.users" in source
    assert re.search(r"role_id.{0,300}member", source)


def test_upgrade_revokes_app_table_access_from_all_supabase_roles() -> None:
    source = _source()

    assert re.search(
        r"revoke\s+all\s+on\s+(?:all\s+tables\s+in\s+schema\s+public|table\s+).{0,500}from",
        source,
    )
    for role in ("anon", "authenticated", "service_role"):
        assert re.search(rf"\b{role}\b", source)


def test_upgrade_creates_or_enforces_a_private_storage_bucket() -> None:
    source = _source()

    assert "storage.buckets" in source
    assert re.search(r"storage\.buckets.{0,300}\bfalse\b", source)


def test_upgrade_provides_private_realtime_authorization_and_broadcast_foundation() -> None:
    source = _source()

    assert "realtime.messages" in source
    assert "create policy" in source
    assert "realtime.topic()" in source
    assert "private" in source
    assert "broadcast" in source


def test_upgrade_revokes_local_realtime_owner_membership_in_a_finally_block() -> None:
    source = _source()

    assert "supabase_admin" in source
    assert "grant {} to {}" in source
    assert "revoke {} from {}" in source
    assert "finally:" in source
    assert "alter table realtime.messages owner to" not in source


def test_upgrade_does_not_add_domain_tables_to_realtime_publication() -> None:
    source = _source()

    for table in DOMAIN_TABLES:
        assert not re.search(
            rf"alter\s+publication\s+supabase_realtime\s+add\s+table\s+"
            rf"(?:public\.)?{table}\b",
            source,
        )


def test_downgrade_explicitly_refuses_to_run() -> None:
    with pytest.raises(NotImplementedError):
        _migration_module().downgrade()


def test_alembic_excludes_external_supabase_metadata_placeholders() -> None:
    source = re.sub(r"\s+", " ", ALEMBIC_ENV.read_text(encoding="utf-8")).casefold()

    assert "def include_object" in source
    assert "type_ == \"table\"" in source or "type_ == 'table'" in source
    assert "info" in source
    assert "external" in source
    assert "return false" in source
