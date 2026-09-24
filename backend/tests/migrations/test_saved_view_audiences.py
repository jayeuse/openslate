"""Saved-view audience/default migration regressions on disposable PostgreSQL."""

import json
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "d1a731600968"
TARGET_REVISION = "20c062857e0d"


@pytest.mark.integration
def test_saved_view_audience_migration_preserves_legacy_data_and_downgrades_safely() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    ids = {
        key: uuid7()
        for key in (
            "author",
            "target_user",
            "department",
            "module",
            "other_module",
            "workspace_view",
            "private_view",
            "role_view",
            "user_view",
            "default",
            "invalid_audience_view",
        )
    }
    created_at = datetime(2024, 1, 2, 3, 4, 5, tzinfo=UTC)
    updated_at = datetime(2024, 2, 3, 4, 5, 6, tzinfo=UTC)
    deleted_at = datetime(2024, 3, 4, 5, 6, 7, tzinfo=UTC)
    legacy_rows = (
        {
            "id": ids["workspace_view"],
            "module_id": ids["module"],
            "owner_id": ids["author"],
            "name": "Legacy workspace view",
            "visibility": "workspace",
            "revision": 7,
            "definition": {"filters": [{"field": "status", "value": "open"}]},
            "created_at": created_at,
            "updated_at": updated_at,
            "deleted_at": None,
            "is_deleted": False,
            "performed_by": ids["target_user"],
            "audience_kind": "everyone",
        },
        {
            "id": ids["private_view"],
            "module_id": ids["module"],
            "owner_id": ids["target_user"],
            "name": "Legacy private view",
            "visibility": "private",
            "revision": 12,
            "definition": {"sort": [{"field": "created_at", "direction": "desc"}]},
            "created_at": created_at,
            "updated_at": deleted_at,
            "deleted_at": deleted_at,
            "is_deleted": True,
            "performed_by": ids["author"],
            "audience_kind": "private",
        },
    )

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        role_ids = _seed_legacy_rows(owner_engine, ids, legacy_rows)

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            _assert_upgraded_rows(connection, legacy_rows)
            _assert_audience_constraints_and_default_table(connection)
            _assert_default_table_privileges(connection)
        _assert_audience_constraint_rejects_incomplete_role(owner_engine, ids)
        _assert_default_fk_rejects_cross_module_view(owner_engine, ids)

        with runtime_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO public.saved_view_defaults "
                    "(id, user_id, module_id, view_id) "
                    "VALUES (:id, :user_id, :module_id, :view_id)"
                ),
                {
                    "id": ids["default"],
                    "user_id": ids["author"],
                    "module_id": ids["module"],
                    "view_id": ids["workspace_view"],
                },
            )
        with inspector_engine.connect() as connection:
            default_row = connection.execute(
                text(
                    "SELECT user_id, module_id, view_id FROM public.saved_view_defaults "
                    "WHERE id = :id"
                ),
                {"id": ids["default"]},
            ).mappings().one()
        assert dict(default_row) == {
            "user_id": ids["author"],
            "module_id": ids["module"],
            "view_id": ids["workspace_view"],
        }

        _insert_scoped_audience_views(owner_engine, ids, role_ids["member"])
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            _assert_downgraded_rows(connection, legacy_rows, ids)

    finally:
        run_alembic(environment, "upgrade", "head")
        _delete_test_rows(owner_engine, ids)
        inspector_engine.dispose()
        runtime_engine.dispose()
        owner_engine.dispose()


def _seed_legacy_rows(
    engine: Engine, ids: dict[str, UUID], legacy_rows: tuple[dict, ...]
) -> dict[str, UUID]:
    with engine.begin() as connection:
        roles = dict(
            connection.execute(
                text("SELECT role, id FROM public.roles WHERE role IN ('admin', 'member')")
            ).all()
        )
        assert set(roles) == {"admin", "member"}
        for key, username, role in (
            ("author", "migration-author", "admin"),
            ("target_user", "migration-target", "member"),
        ):
            connection.execute(
                text(
                    "INSERT INTO public.users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": ids[key],
                    "email": f"{username}@example.test",
                    "username": username,
                    "role_id": roles[role],
                },
            )
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": "Migration test department"},
        )
        for key, name in (("module", "Migration test module"), ("other_module", "Other module")):
            connection.execute(
                text(
                    "INSERT INTO public.modules (id, department_id, module_name) "
                    "VALUES (:id, :department_id, :name)"
                ),
                {"id": ids[key], "department_id": ids["department"], "name": name},
            )
        for row in legacy_rows:
            connection.execute(
                text(
                    "INSERT INTO public.saved_views "
                    "(id, module_id, owner_id, name, visibility, revision, definition, "
                    "created_at, deleted_at, is_deleted, updated_at, performed_by) "
                    "VALUES (:id, :module_id, :owner_id, :name, :visibility, :revision, "
                    "CAST(:definition AS jsonb), :created_at, :deleted_at, :is_deleted, "
                    ":updated_at, :performed_by)"
                ),
                {
                    **row,
                    "definition": json.dumps(row["definition"]),
                },
            )
    return roles


def _delete_test_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM public.saved_view_defaults WHERE id = :id"),
            {"id": ids["default"]},
        )
        connection.execute(
            text(
                "DELETE FROM public.saved_views WHERE id IN "
                "(:workspace_view, :private_view, :role_view, :user_view, :invalid_view)"
            ),
            {
                "workspace_view": ids["workspace_view"],
                "private_view": ids["private_view"],
                "role_view": ids["role_view"],
                "user_view": ids["user_view"],
                "invalid_view": ids["invalid_audience_view"],
            },
        )
        connection.execute(
            text("DELETE FROM public.modules WHERE id IN (:module, :other_module)"),
            {"module": ids["module"], "other_module": ids["other_module"]},
        )
        connection.execute(
            text("DELETE FROM public.departments WHERE id = :id"),
            {"id": ids["department"]},
        )
        connection.execute(
            text("DELETE FROM public.users WHERE id IN (:author, :target_user)"),
            {"author": ids["author"], "target_user": ids["target_user"]},
        )


def _assert_upgraded_rows(connection: Connection, legacy_rows: tuple[dict, ...]) -> None:
    rows = connection.execute(
        text(
            "SELECT id, module_id, owner_id, name, visibility, revision, definition, "
            "created_at, deleted_at, is_deleted, updated_at, performed_by, audience_kind, "
            "audience_role_id, audience_user_id, presentation FROM public.saved_views "
            "WHERE id IN (:workspace_id, :private_id)"
        ),
        {
            "workspace_id": legacy_rows[0]["id"],
            "private_id": legacy_rows[1]["id"],
        },
    ).mappings()
    actual = {row["id"]: row for row in rows}
    assert set(actual) == {row["id"] for row in legacy_rows}
    for expected in legacy_rows:
        row = actual[expected["id"]]
        for field in (
            "owner_id",
            "module_id",
            "name",
            "visibility",
            "revision",
            "definition",
            "created_at",
            "deleted_at",
            "is_deleted",
            "updated_at",
            "performed_by",
            "audience_kind",
        ):
            assert row[field] == expected[field]
        assert row["audience_role_id"] is None
        assert row["audience_user_id"] is None
        assert row["presentation"] == {"version": 1}


def _assert_audience_constraints_and_default_table(connection: Connection) -> None:
    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, pg_get_constraintdef(oid) AS definition "
                "FROM pg_constraint WHERE conrelid IN "
                "('public.saved_views'::regclass, 'public.saved_view_defaults'::regclass)"
            )
        ).mappings()
    }
    expected_kinds = {
        "ck_saved_views_audience_kind": "c",
        "ck_saved_views_audience_reference": "c",
        "uq_saved_views_id_module": "u",
        "fk_saved_views_audience_role_id_roles": "f",
        "fk_saved_views_audience_user_id_users": "f",
        "fk_saved_view_defaults_module_id_modules": "f",
        "fk_saved_view_defaults_user_id_users": "f",
        "fk_saved_view_defaults_view_module": "f",
        "uq_saved_view_defaults_user_module": "u",
    }
    assert {name: constraints[name]["contype"] for name in expected_kinds} == expected_kinds
    assert "FOREIGN KEY (view_id, module_id)" in constraints[
        "fk_saved_view_defaults_view_module"
    ]["definition"]
    assert "saved_views(id, module_id)" in constraints[
        "fk_saved_view_defaults_view_module"
    ]["definition"]
    columns = set(
        connection.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'saved_view_defaults'"
            )
        ).scalars()
    )
    assert {"id", "user_id", "module_id", "view_id", "created_at", "updated_at"} <= columns


def _assert_default_table_privileges(connection: Connection) -> None:
    privileges = connection.execute(
        text(
            "SELECT has_table_privilege('openslate_runtime', "
            "'public.saved_view_defaults', 'SELECT') AS runtime_select, "
            "has_table_privilege('openslate_runtime', "
            "'public.saved_view_defaults', 'INSERT') AS runtime_insert, "
            "has_table_privilege('openslate_runtime', "
            "'public.saved_view_defaults', 'UPDATE') AS runtime_update, "
            "has_table_privilege('openslate_runtime', "
            "'public.saved_view_defaults', 'DELETE') AS runtime_delete, "
            "has_table_privilege('openslate_inspector', "
            "'public.saved_view_defaults', 'SELECT') AS inspector_select, "
            "has_table_privilege('openslate_inspector', "
            "'public.saved_view_defaults', 'INSERT') AS inspector_insert"
        )
    ).mappings().one()
    assert all(
        privileges[f"runtime_{operation}"]
        for operation in ("select", "insert", "update", "delete")
    )
    assert privileges["inspector_select"] is True
    assert privileges["inspector_insert"] is False


def _assert_audience_constraint_rejects_incomplete_role(
    engine: Engine, ids: dict[str, UUID]
) -> None:
    with engine.begin() as connection:
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text(
                        "INSERT INTO public.saved_views "
                        "(id, module_id, owner_id, name, visibility, definition, audience_kind) "
                        "VALUES (:id, :module_id, :owner_id, 'Invalid role audience', "
                        "'workspace', '{}'::jsonb, 'role')"
                    ),
                    {
                        "id": ids["invalid_audience_view"],
                        "module_id": ids["module"],
                        "owner_id": ids["author"],
                    },
                )


def _assert_default_fk_rejects_cross_module_view(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        with pytest.raises(IntegrityError):
            with connection.begin_nested():
                connection.execute(
                    text(
                        "INSERT INTO public.saved_view_defaults "
                        "(id, user_id, module_id, view_id) "
                        "VALUES (:id, :user_id, :module_id, :view_id)"
                    ),
                    {
                        "id": uuid7(),
                        "user_id": ids["author"],
                        "module_id": ids["other_module"],
                        "view_id": ids["workspace_view"],
                    },
                )


def _insert_scoped_audience_views(
    engine: Engine, ids: dict[str, UUID], member_role_id: UUID
) -> None:
    with engine.begin() as connection:
        for key, name, kind, role_id, user_id in (
            ("role_view", "Role audience", "role", member_role_id, None),
            ("user_view", "User audience", "user", None, ids["target_user"]),
        ):
            connection.execute(
                text(
                    "INSERT INTO public.saved_views "
                    "(id, module_id, owner_id, name, visibility, definition, audience_kind, "
                    "audience_role_id, audience_user_id) VALUES "
                    "(:id, :module_id, :owner_id, :name, 'workspace', '{}'::jsonb, :kind, "
                    ":role_id, :user_id)"
                ),
                {
                    "id": ids[key],
                    "module_id": ids["module"],
                    "owner_id": ids["author"],
                    "name": name,
                    "kind": kind,
                    "role_id": role_id,
                    "user_id": user_id,
                },
            )


def _assert_downgraded_rows(
    connection: Connection, legacy_rows: tuple[dict, ...], ids: dict[str, UUID]
) -> None:
    rows = connection.execute(
        text(
            "SELECT id, visibility FROM public.saved_views WHERE id IN "
            "(:workspace_view, :private_view, :role_view, :user_view)"
        ),
        {
            "workspace_view": legacy_rows[0]["id"],
            "private_view": legacy_rows[1]["id"],
            "role_view": ids["role_view"],
            "user_view": ids["user_view"],
        },
    ).mappings()
    visibility_by_id = {row["id"]: row["visibility"] for row in rows}
    assert visibility_by_id == {
        legacy_rows[0]["id"]: "workspace",
        legacy_rows[1]["id"]: "private",
        ids["role_view"]: "private",
        ids["user_view"]: "private",
    }
    assert (
        connection.execute(text("SELECT to_regclass('public.saved_view_defaults')")).scalar_one()
        is None
    )
    remaining_audience_columns = connection.execute(
        text(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'saved_views' "
            "AND column_name IN ('audience_kind', 'audience_role_id', 'audience_user_id')"
        )
    ).scalar_one()
    assert remaining_audience_columns == 0
