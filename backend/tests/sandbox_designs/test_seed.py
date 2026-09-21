import importlib.util
import json
from pathlib import Path
from uuid import UUID

from sqlalchemy.dialects import postgresql

from app.systems.sandbox.designs.defaults import EMPTY_SANDBOX_DOCUMENT, empty_document
from app.systems.sandbox.designs.validation import validate_document


def test_default_document_contains_no_placeholder_entities() -> None:
    seed = empty_document()

    assert seed.design.departments == []
    assert seed.design.modules == []
    assert seed.design.relationships == []
    assert seed.design.layout == {}
    assert seed.automations == []
    assert seed.scenarios == []


def test_empty_document_round_trips_through_the_v2_contract() -> None:
    seed = empty_document()
    restored = type(seed).model_validate(seed.model_dump(by_alias=True, mode="json"))

    assert validate_document(restored) == []
    assert json.loads(json.dumps(EMPTY_SANDBOX_DOCUMENT)) == seed.model_dump(
        by_alias=True, mode="json", exclude_none=True
    )


def test_migration_seeds_only_the_empty_shared_document() -> None:
    migration = _migration_module()
    operations = _RecordingOperations()
    migration.op = operations

    migration.upgrade()

    inserts = [
        statement for statement in operations.statements if "INSERT INTO public" in str(statement)
    ]
    assert len(inserts) == 1
    document_insert = inserts[0]
    document_params = document_insert.compile().params
    document_compiled = document_insert.compile(dialect=postgresql.dialect())

    assert "public.sandbox_documents" in str(document_insert)
    assert isinstance(document_params["id"], UUID)
    assert document_params["id"].version == 7
    bind_type = document_compiled.binds["id"].type.dialect_impl(postgresql.dialect())
    assert isinstance(bind_type, postgresql.UUID)
    assert json.loads(document_params["document"]) == EMPTY_SANDBOX_DOCUMENT


def test_placeholder_cleanup_migration_replaces_only_the_known_seed() -> None:
    migration = _cleanup_migration_module()
    operations = _RecordingOperations()
    migration.op = operations

    migration.upgrade()

    statements = [str(statement) for statement in operations.statements]
    assert len(statements) == 2
    assert "DELETE FROM public.sandbox_versions" in statements[0]
    assert "UPDATE public.sandbox_documents" in statements[1]
    for statement in operations.statements:
        params = statement.compile().params
        assert params["placeholder_hash"] == (
            "131d71b467d26eccebbf6844e1d460d72a393195a88239d7bb77d2be5ddca98a"
        )
    update_params = operations.statements[1].compile().params
    assert json.loads(update_params["document"]) == EMPTY_SANDBOX_DOCUMENT
    assert update_params["content_hash"] == (
        "34d294fb849433b5b53deb50502a21d22ef2e5383b6d93de0eb9cb21ee6d127f"
    )
    assert update_params["byte_count"] == 150


def test_normalized_placeholder_cleanup_migration_replaces_only_its_known_hash() -> None:
    migration = _normalized_cleanup_migration_module()
    operations = _RecordingOperations()
    migration.op = operations

    migration.upgrade()

    statements = [str(statement) for statement in operations.statements]
    assert len(statements) == 2
    assert "DELETE FROM public.sandbox_versions" in statements[0]
    assert "kind = 'release'" in statements[0]
    assert "label = 'Starting structure'" in statements[0]
    assert "UPDATE public.sandbox_documents" in statements[1]
    for statement in operations.statements:
        params = statement.compile().params
        assert params["placeholder_hash"] == (
            "bbaea97be6c1a9edd7cefefbf242c91f8683257c291eae4338a5ddfdffa26409"
        )
    update_params = operations.statements[1].compile().params
    assert json.loads(update_params["document"]) == EMPTY_SANDBOX_DOCUMENT
    assert update_params["content_hash"] == (
        "34d294fb849433b5b53deb50502a21d22ef2e5383b6d93de0eb9cb21ee6d127f"
    )
    assert update_params["byte_count"] == 150


def test_schedule_progress_repair_downgrade_keeps_predecessor_columns() -> None:
    migration = _schedule_progress_repair_migration_module()
    operations = _RecordingOperations()
    migration.op = operations

    migration.downgrade()

    assert operations.statements == []


def test_migration_emits_all_deferred_sandbox_foreign_keys() -> None:
    migration = _migration_module()
    operations = _RecordingOperations()
    migration.op = operations

    migration.upgrade()

    assert operations.foreign_keys == [
        (
            "fk_sandbox_documents_performed_by_users",
            "sandbox_documents",
            "users",
            ["performed_by"],
            ["id"],
            {"ondelete": "SET NULL"},
        ),
        (
            "fk_sandbox_versions_performed_by_users",
            "sandbox_versions",
            "users",
            ["performed_by"],
            ["id"],
            {"ondelete": "SET NULL"},
        ),
        (
            "fk_sandbox_versions_source_version_id_sandbox_versions",
            "sandbox_versions",
            "sandbox_versions",
            ["source_version_id"],
            ["id"],
            {"ondelete": "RESTRICT"},
        ),
    ]


def test_migration_downgrade_removes_deferred_foreign_keys_before_tables() -> None:
    migration = _migration_module()
    operations = _RecordingOperations()
    migration.op = operations

    migration.downgrade()

    assert operations.dropped_constraints == [
        (
            "fk_sandbox_versions_source_version_id_sandbox_versions",
            "sandbox_versions",
            {"type_": "foreignkey", "if_exists": True},
        ),
        (
            "fk_sandbox_versions_performed_by_users",
            "sandbox_versions",
            {"type_": "foreignkey", "if_exists": True},
        ),
        (
            "fk_sandbox_documents_performed_by_users",
            "sandbox_documents",
            {"type_": "foreignkey", "if_exists": True},
        ),
    ]


def _migration_module():
    path = (
        Path(__file__).parents[2]
        / "migrations"
        / "versions"
        / "4db4d8baf162_add_sandbox_design_documents.py"
    )
    spec = importlib.util.spec_from_file_location("sandbox_design_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _cleanup_migration_module():
    path = (
        Path(__file__).parents[2]
        / "migrations"
        / "versions"
        / "a96c2f4e7d31_remove_sandbox_placeholder_data.py"
    )
    spec = importlib.util.spec_from_file_location("sandbox_placeholder_cleanup_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _normalized_cleanup_migration_module():
    path = (
        Path(__file__).parents[2]
        / "migrations"
        / "versions"
        / "b47e91a6c3d2_remove_normalized_sandbox_placeholder.py"
    )
    spec = importlib.util.spec_from_file_location(
        "normalized_sandbox_placeholder_cleanup_migration", path
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _schedule_progress_repair_migration_module():
    path = (
        Path(__file__).parents[2]
        / "migrations"
        / "versions"
        / "5147066a0b3a_repair_automation_schedule_progress_.py"
    )
    spec = importlib.util.spec_from_file_location("schedule_progress_repair_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


class _RecordingOperations:
    def __init__(self) -> None:
        self.statements: list[object] = []
        self.foreign_keys: list[tuple[object, ...]] = []
        self.dropped_constraints: list[tuple[object, ...]] = []

    def create_table(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def create_index(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def create_foreign_key(
        self,
        name: str,
        source_table: str,
        referent_table: str,
        local_cols: list[str],
        remote_cols: list[str],
        **kwargs: object,
    ) -> None:
        self.foreign_keys.append(
            (name, source_table, referent_table, local_cols, remote_cols, kwargs)
        )

    def drop_constraint(self, name: str, table_name: str, **kwargs: object) -> None:
        self.dropped_constraints.append((name, table_name, kwargs))

    def drop_index(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def drop_table(self, *args: object, **kwargs: object) -> None:
        del args, kwargs

    def execute(self, statement: object) -> None:
        self.statements.append(statement)

    def f(self, identifier: str) -> str:
        return identifier
