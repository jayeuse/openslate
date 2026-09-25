"""Preserve Boards memberships when Access becomes the single authority."""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

MERGE_REVISION = "997ba6cad7ac"
UNIFIED_REVISION = "207230bfc5cf"


@pytest.mark.integration
def test_legacy_memberships_move_into_access_without_overwriting_access_rows() -> None:
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    ids = {
        name: uuid7()
        for name in (
            "user",
            "access",
            "board",
            "deleted",
            "access_link",
            "board_link",
            "deleted_link",
        )
    }
    try:
        run_alembic(environment, "downgrade", MERGE_REVISION)
        _seed(engine, ids)

        run_alembic(environment, "upgrade", UNIFIED_REVISION)
        with engine.connect() as connection:
            assert (
                connection.scalar(text("SELECT to_regclass('public.user_department_memberships')"))
                is None
            )
            rows = connection.execute(
                text(
                    "SELECT id, department_id, is_primary FROM public.user_departments "
                    "WHERE user_id = :user_id ORDER BY department_id"
                ),
                {"user_id": ids["user"]},
            ).all()
            assert set(rows) == {
                (ids["access_link"], ids["access"], True),
                (ids["board_link"], ids["board"], False),
            }
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            _cleanup(engine, ids)
            engine.dispose()


def _seed(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        role_id = connection.scalar(text("SELECT id FROM public.roles WHERE role = 'member'"))
        assert role_id is not None
        connection.execute(
            text(
                "INSERT INTO public.users (id, email, username, status, role_id) "
                "VALUES (:id, :email, :username, 'active', :role_id)"
            ),
            {
                "id": ids["user"],
                "email": f"integration-membership-{ids['user'].hex}@example.test",
                "username": f"integration-membership-{ids['user'].hex}",
                "role_id": role_id,
            },
        )
        for name in ("access", "board", "deleted"):
            connection.execute(
                text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
                {"id": ids[name], "name": f"Integration {name} {ids[name].hex}"},
            )
        connection.execute(
            text(
                "INSERT INTO public.user_departments "
                "(id, user_id, department_id, is_primary) "
                "VALUES (:id, :user_id, :department_id, true)"
            ),
            {"id": ids["access_link"], "user_id": ids["user"], "department_id": ids["access"]},
        )
        for link, department, deleted in (
            ("board_link", "board", False),
            ("deleted_link", "deleted", True),
            (uuid7(), "access", False),
        ):
            connection.execute(
                text(
                    "INSERT INTO public.user_department_memberships "
                    "(id, user_id, department_id, is_deleted) "
                    "VALUES (:id, :user_id, :department_id, :is_deleted)"
                ),
                {
                    "id": ids[link] if isinstance(link, str) else link,
                    "user_id": ids["user"],
                    "department_id": ids[department],
                    "is_deleted": deleted,
                },
            )


def _cleanup(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM public.user_departments WHERE user_id = :user_id"),
            {"user_id": ids["user"]},
        )
        connection.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": ids["user"]})
        connection.execute(
            text("DELETE FROM public.departments WHERE id IN (:access, :board, :deleted)"),
            {name: ids[name] for name in ("access", "board", "deleted")},
        )
