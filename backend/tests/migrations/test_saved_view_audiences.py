"""Saved-view audience/default contracts on the active Supabase baseline.

Access and lifecycle behavior remains covered by ``tests/views/test_access.py`` and
``tests/views/test_lifecycle_dependencies.py``. Retired vanilla upgrade/downgrade transitions are
outside the fresh-install path.
"""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment


@pytest.mark.integration
def test_saved_view_catalog_constraints_and_runtime_access_on_active_baseline() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    ids = {
        key: uuid7()
        for key in (
            "author",
            "target_user",
            "actor",
            "department",
            "module",
            "other_module",
            "private_view",
            "everyone_view",
            "role_view",
            "user_view",
            "default",
        )
    }

    try:
        _seed_source_rows(owner_engine, ids)
        with owner_engine.connect() as connection:
            _assert_saved_view_catalog(connection)
            _assert_runtime_privileges(connection)

        _insert_audience_views(owner_engine, ids)
        _assert_invalid_audience_rows_are_rejected(owner_engine, ids)
        _assert_runtime_default_and_unique_scope(runtime_engine, owner_engine, ids)
        _assert_cross_module_default_is_rejected(runtime_engine, ids)
        _assert_performed_by_delete_action(owner_engine, ids)
    finally:
        _delete_test_rows(owner_engine, ids)
        runtime_engine.dispose()
        owner_engine.dispose()


def _seed_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        for key in ("author", "target_user", "actor"):
            connection.execute(
                text(
                    "INSERT INTO public.users (id, email, username, status, role) "
                    "VALUES (:id, :email, :username, 'active', 'member')"
                ),
                {
                    "id": ids[key],
                    "email": f"saved-view-baseline-{ids[key].hex}@example.test",
                    "username": f"saved_view_baseline_{ids[key].hex}",
                },
            )
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": f"Saved views {ids['department'].hex}"},
        )
        for key in ("module", "other_module"):
            connection.execute(
                text(
                    "INSERT INTO public.modules (id, department_id, module_name) "
                    "VALUES (:id, :department_id, :name)"
                ),
                {
                    "id": ids[key],
                    "department_id": ids["department"],
                    "name": f"Saved view {ids[key].hex}",
                },
            )


def _assert_saved_view_catalog(connection: Connection) -> None:
    saved_view_columns = {
        row["column_name"]: row
        for row in connection.execute(
            text(
                "SELECT column_name, udt_name, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'saved_views'"
            )
        ).mappings()
    }
    assert set(saved_view_columns) == {
        "id",
        "created_at",
        "deleted_at",
        "is_deleted",
        "updated_at",
        "performed_by",
        "module_id",
        "owner_id",
        "name",
        "visibility",
        "audience_kind",
        "audience_user_id",
        "revision",
        "definition",
        "presentation",
    }
    assert saved_view_columns["definition"]["udt_name"] == "jsonb"
    assert saved_view_columns["presentation"]["udt_name"] == "jsonb"
    assert saved_view_columns["revision"]["column_default"] == "1"
    assert saved_view_columns["audience_kind"]["column_default"] == "'private'::character varying"
    assert saved_view_columns["audience_user_id"]["is_nullable"] == "YES"

    default_columns = {
        row["column_name"]: row
        for row in connection.execute(
            text(
                "SELECT column_name, udt_name, is_nullable "
                "FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'saved_view_defaults'"
            )
        ).mappings()
    }
    assert set(default_columns) == {
        "id",
        "created_at",
        "deleted_at",
        "is_deleted",
        "updated_at",
        "performed_by",
        "user_id",
        "module_id",
        "view_id",
    }
    assert all(
        default_columns[column]["is_nullable"] == "NO"
        for column in ("user_id", "module_id", "view_id")
    )

    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype, pg_get_constraintdef(oid) AS definition "
                "FROM pg_constraint WHERE conrelid IN "
                "('public.saved_views'::regclass, 'public.saved_view_defaults'::regclass)"
            )
        ).mappings()
    }
    expected_kinds = {
        "saved_views_pkey": "p",
        "ck_saved_views_visibility": "c",
        "ck_saved_views_audience_kind": "c",
        "ck_saved_views_revision": "c",
        "ck_saved_views_audience_reference": "c",
        "uq_saved_views_id_module": "u",
        "fk_saved_views_audience_user_id_users": "f",
        "fk_saved_views_module_id_modules": "f",
        "fk_saved_views_owner_id_users": "f",
        "fk_saved_views_performed_by_users": "f",
        "saved_view_defaults_pkey": "p",
        "uq_saved_view_defaults_user_module": "u",
        "fk_saved_view_defaults_module_id_modules": "f",
        "fk_saved_view_defaults_performed_by_users": "f",
        "fk_saved_view_defaults_user_id_users": "f",
        "fk_saved_view_defaults_view_module": "f",
    }
    assert set(constraints) == set(expected_kinds)
    assert {name: constraints[name]["contype"] for name in expected_kinds} == expected_kinds
    for name in (
        "fk_saved_views_audience_user_id_users",
        "fk_saved_views_module_id_modules",
        "fk_saved_views_owner_id_users",
        "fk_saved_view_defaults_module_id_modules",
    ):
        assert constraints[name]["confdeltype"] == "r"
    assert constraints["fk_saved_views_performed_by_users"]["confdeltype"] == "n"
    assert constraints["fk_saved_view_defaults_performed_by_users"]["confdeltype"] == "n"
    assert constraints["fk_saved_view_defaults_user_id_users"]["confdeltype"] == "c"
    assert constraints["fk_saved_view_defaults_view_module"]["confdeltype"] == "c"
    assert (
        "FOREIGN KEY (view_id, module_id)"
        in constraints["fk_saved_view_defaults_view_module"]["definition"]
    )
    assert (
        "saved_views(id, module_id)"
        in constraints["fk_saved_view_defaults_view_module"]["definition"]
    )

    indexes: dict[str, set[str]] = {"saved_views": set(), "saved_view_defaults": set()}
    for row in connection.execute(
        text(
            "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' "
            "AND tablename IN ('saved_views', 'saved_view_defaults')"
        )
    ).mappings():
        indexes[row["tablename"]].add(row["indexname"])
    assert indexes == {
        "saved_views": {
            "saved_views_pkey",
            "uq_saved_views_id_module",
            "ix_saved_views_module_id",
            "ix_saved_views_owner_module",
            "ix_saved_views_everyone_module_active",
            "ix_saved_views_user_module_active",
        },
        "saved_view_defaults": {
            "saved_view_defaults_pkey",
            "uq_saved_view_defaults_user_module",
            "ix_saved_view_defaults_user_id",
            "ix_saved_view_defaults_view_module",
        },
    }


def _assert_runtime_privileges(connection: Connection) -> None:
    statement = text("SELECT has_table_privilege('openslate_runtime', :table, :action)")
    for table in ("public.saved_views", "public.saved_view_defaults"):
        for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert connection.scalar(statement, {"table": table, "action": action}) is True


def _insert_audience_views(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        for key, kind, visibility, audience_user_id in (
            ("private_view", "private", "private", None),
            ("everyone_view", "everyone", "workspace", None),
            ("role_view", "everyone", "workspace", None),
            ("user_view", "user", "workspace", ids["target_user"]),
        ):
            connection.execute(
                text(
                    "INSERT INTO public.saved_views "
                    "(id, module_id, owner_id, name, visibility, audience_kind, "
                    "audience_user_id, definition, performed_by) "
                    "VALUES (:id, :module_id, :owner_id, :name, :visibility, :kind, "
                    ":user_id, '{}'::jsonb, :actor_id)"
                ),
                {
                    "id": ids[key],
                    "module_id": ids["module"],
                    "owner_id": ids["author"],
                    "name": key,
                    "visibility": visibility,
                    "kind": kind,
                    "user_id": audience_user_id,
                    "actor_id": ids["actor"] if key == "role_view" else None,
                },
            )


def _assert_invalid_audience_rows_are_rejected(engine: Engine, ids: dict[str, UUID]) -> None:
    invalid_rows = (
        ("role", "workspace", None, 1),
        ("unknown", "workspace", None, 1),
        ("private", "workspace", None, 1),
        ("private", "private", None, 0),
        ("user", "workspace", uuid7(), 1),
    )
    with engine.begin() as connection:
        for kind, visibility, user_id, revision in invalid_rows:
            with pytest.raises(IntegrityError):
                with connection.begin_nested():
                    connection.execute(
                        text(
                            "INSERT INTO public.saved_views "
                            "(id, module_id, owner_id, name, visibility, audience_kind, "
                            "audience_user_id, revision, definition) "
                            "VALUES (:id, :module_id, :owner_id, 'Invalid audience', :visibility, "
                            ":kind, :user_id, :revision, '{}'::jsonb)"
                        ),
                        {
                            "id": uuid7(),
                            "module_id": ids["module"],
                            "owner_id": ids["author"],
                            "visibility": visibility,
                            "kind": kind,
                            "user_id": user_id,
                            "revision": revision,
                        },
                    )


def _assert_runtime_default_and_unique_scope(
    runtime_engine: Engine, owner_engine: Engine, ids: dict[str, UUID]
) -> None:
    with runtime_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.saved_view_defaults "
                "(id, user_id, module_id, view_id, performed_by) "
                "VALUES (:id, :user_id, :module_id, :view_id, :actor_id)"
            ),
            {
                "id": ids["default"],
                "user_id": ids["author"],
                "module_id": ids["module"],
                "view_id": ids["role_view"],
                "actor_id": ids["actor"],
            },
        )
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
                        "module_id": ids["module"],
                        "view_id": ids["everyone_view"],
                    },
                )

    with owner_engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT user_id, module_id, view_id, performed_by "
                    "FROM public.saved_view_defaults WHERE id = :id"
                ),
                {"id": ids["default"]},
            )
            .mappings()
            .one()
        )
    assert dict(row) == {
        "user_id": ids["author"],
        "module_id": ids["module"],
        "view_id": ids["role_view"],
        "performed_by": ids["actor"],
    }


def _assert_cross_module_default_is_rejected(engine: Engine, ids: dict[str, UUID]) -> None:
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
                        "view_id": ids["role_view"],
                    },
                )


def _assert_performed_by_delete_action(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": ids["actor"]})
        assert (
            connection.scalar(
                text("SELECT performed_by FROM public.saved_views WHERE id = :id"),
                {"id": ids["role_view"]},
            )
            is None
        )
        assert (
            connection.scalar(
                text("SELECT performed_by FROM public.saved_view_defaults WHERE id = :id"),
                {"id": ids["default"]},
            )
            is None
        )


def _delete_test_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM public.saved_view_defaults WHERE id = :id"),
            {"id": ids["default"]},
        )
        connection.execute(
            text("DELETE FROM public.saved_views WHERE id IN (:private, :everyone, :role, :user)"),
            {
                "private": ids["private_view"],
                "everyone": ids["everyone_view"],
                "role": ids["role_view"],
                "user": ids["user_view"],
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
            text("DELETE FROM public.users WHERE id IN (:author, :target_user, :actor)"),
            {
                "author": ids["author"],
                "target_user": ids["target_user"],
                "actor": ids["actor"],
            },
        )
