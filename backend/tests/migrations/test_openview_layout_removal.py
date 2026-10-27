"""OpenView keeps three layouts: the migration deletes the other views and strips seven keys."""

import json
import os
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from tests.conftest import alembic_heads, create_organization, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BEFORE_REMOVAL = "c3f8d2e6a1b7"
REMOVED_KEYS = (
    "date_field_id",
    "timeline_start_field_id",
    "timeline_end_field_id",
    "timeline_deadline_field_id",
    "timeline_progress_field_id",
    "date_range",
    "scale",
)
FIELD = "0190a000-0000-7000-8000-0000000000f1"
# Every key the previous API wrote, at its default, as a view saved before the removal holds it.
OLD_DEFAULTS: dict[str, Any] = {
    "version": 1,
    "column_field_ids": [FIELD],
    "pinned_field_ids": [],
    "density": "comfortable",
    "wrap": False,
    "card_size": "comfortable",
    "primary_field_id": None,
    "secondary_field_id": None,
    "date_field_id": None,
    "timeline_start_field_id": None,
    "timeline_end_field_id": None,
    "timeline_deadline_field_id": None,
    "timeline_progress_field_id": None,
    "date_range": "month",
    "scale": None,
    "group_by_field_id": None,
}
CURRENT = {key: value for key, value in OLD_DEFAULTS.items() if key not in REMOVED_KEYS}
# name: (presentation, is_default, is_deleted)
VIEWS: dict[str, tuple[dict[str, Any], bool, bool]] = {
    "kanban": ({**OLD_DEFAULTS, "layout": "kanban", "group_by_field_id": FIELD}, True, False),
    "calendar": ({**OLD_DEFAULTS, "layout": "calendar", "date_field_id": FIELD}, False, True),
    "timeline": ({**OLD_DEFAULTS, "layout": "timeline", "scale": "month"}, False, False),
    "stray_table": (
        {**OLD_DEFAULTS, "layout": "table", "date_field_id": FIELD, "date_range": "quarter",
         "scale": "list"},
        False, False,
    ),
    "old_grid": ({**OLD_DEFAULTS, "layout": "grid"}, False, True),
    "table": ({**CURRENT, "layout": "table", "pinned_field_ids": [FIELD]}, False, False),
    "grid": ({**CURRENT, "layout": "grid", "primary_field_id": FIELD}, False, False),
    "gallery": ({**CURRENT, "layout": "gallery", "group_by_field_id": FIELD}, False, True),
}
DELETED = ("kanban", "calendar", "timeline")
STRIPPED = ("stray_table", "old_grid")
UNTOUCHED = ("table", "grid", "gallery")


def test_upgrade_deletes_removed_layout_views_and_strips_their_settings() -> None:
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    # No pooled fixture connection may hold locks while the migration runs.
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    ids: dict[str, UUID] = {}
    try:
        _seed(engine, ids)
        before = _rows(engine, ids)
        run_alembic(environment, "downgrade", BEFORE_REMOVAL)
        run_alembic(environment, "upgrade", head)
        run_alembic(environment, "check")

        expected = {
            **{name: before[name] | {"presentation": _stripped(name)} for name in STRIPPED},
            **{name: before[name] for name in UNTOUCHED},
        }
        # Archived and default views of the removed layouts are gone. The others lose only
        # the seven keys; a view without them is unchanged, its revision and times included.
        assert _rows(engine, ids) == expected
        with engine.connect() as connection:
            # The module keeps no default view, so it opens on the built-in default.
            assert connection.scalar(
                text(
                    "SELECT count(*) FROM public.saved_views "
                    "WHERE module_id = :module AND is_default"
                ),
                {"module": ids["module"]},
            ) == 0
            assert _audit_rows(connection, ids) == 1
            # The owner connection bypasses row security, so every organization is migrated.
            assert connection.scalar(
                text(
                    "SELECT count(*) FROM public.saved_views "
                    "WHERE presentation->>'layout' IN ('kanban', 'calendar', 'timeline') "
                    "OR presentation ?| CAST(:keys AS text[])"
                ),
                {"keys": list(REMOVED_KEYS)},
            ) == 0

        run_alembic(environment, "downgrade", BEFORE_REMOVAL)
        # The downgrade brings back neither the deleted rows nor the stripped keys.
        assert _rows(engine, ids) == expected
    finally:
        run_alembic(environment, "upgrade", head)
        _delete_rows(engine, ids)
        engine.dispose()


def _stripped(name: str) -> dict[str, Any]:
    return {key: value for key, value in VIEWS[name][0].items() if key not in REMOVED_KEYS}


def _rows(engine: Engine, ids: dict[str, UUID]) -> dict[str, dict[str, Any]]:
    names = {ids[name]: name for name in VIEWS}
    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT id, to_jsonb(v) FROM public.saved_views v WHERE org_id = :org"),
            {"org": ids["org"]},
        ).all()
    return {names[row_id]: row for row_id, row in rows}


def _audit_rows(connection: Connection, ids: dict[str, UUID]) -> int:
    return int(
        connection.scalar(
            text(
                "SELECT count(*) FROM public.audit_logs "
                "WHERE entity_type = 'saved_views' AND entity_id = :view"
            ),
            {"view": ids["kanban"]},
        )
    )


def _seed(engine: Engine, ids: dict[str, UUID]) -> None:
    with Session(engine) as db:
        ids["org"] = create_organization(db).id
        db.commit()
    ids.update(department=uuid7(), module=uuid7(), **{name: uuid7() for name in VIEWS})
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.departments (id, org_id, department_name) "
                "VALUES (:department, :org, 'Layout removal ' || :department)"
            ),
            ids,
        )
        connection.execute(
            text(
                "INSERT INTO public.modules (id, org_id, department_id, module_name) "
                "VALUES (:module, :org, :department, 'Orders')"
            ),
            ids,
        )
        for name, (presentation, is_default, is_deleted) in VIEWS.items():
            connection.execute(
                text(
                    "INSERT INTO public.saved_views (id, org_id, module_id, name, is_default, "
                    "definition, presentation, is_deleted, deleted_at) VALUES (:id, :org, "
                    ":module, :name, :is_default, CAST(:definition AS jsonb), "
                    "CAST(:presentation AS jsonb), :is_deleted, "
                    "CASE WHEN :is_deleted THEN now() END)"
                ),
                {
                    "id": ids[name],
                    "org": ids["org"],
                    "module": ids["module"],
                    "name": name,
                    "is_default": is_default,
                    "definition": json.dumps({"columns": []}),
                    "presentation": json.dumps(presentation),
                    "is_deleted": is_deleted,
                },
            )
        connection.execute(
            text(
                "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type, "
                "entity_id) VALUES (:id, :org, now(), 'create', 'saved_views', :view)"
            ),
            {"id": uuid7(), "org": ids["org"], "view": ids["kanban"]},
        )


def _delete_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    if "org" not in ids:
        return
    with engine.begin() as connection:
        for table in ("audit_logs", "saved_views", "modules", "departments", "organizations"):
            column = "id" if table == "organizations" else "org_id"
            connection.execute(
                text(f"DELETE FROM public.{table} WHERE {column} = :org"), {"org": ids["org"]}
            )
