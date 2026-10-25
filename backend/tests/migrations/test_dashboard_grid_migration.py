"""The grid migration places existing widgets on the 4 x 5 grid and marks each home."""

import json
import os
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from tests.conftest import alembic_heads, create_organization, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BEFORE_GRID = "5a5ccb851c11"

# Harbor shape: four size-M widgets per department Dashboard.
HARBOR = [("summary", "M"), ("workload", "M"), ("records", "M"), ("chart", "M")]
ELEVEN_NUMBERS = [("summary", "M")] * 11
MIXED = [("summary", "S"), ("chart", "L"), ("workload", "S"), ("records", "L")]
# A pie is at most 3 columns wide: L takes 3 x 3, else 2 x 2 (the saved pie chart here).
PIE_ROOMY = [("summary", "S"), ("pie", "L")]
PIE_TIGHT = [("chart", "L"), ("summary", "M"), ("saved_pie", "L")]
UNPLACED = (None, None, None, None)


def test_grid_migration_places_widgets_in_position_order_and_marks_first_active_home() -> None:
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    assert head != BEFORE_GRID
    # No pooled fixture connection may hold locks while the schema changes.
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    ids: dict[str, UUID] = {}
    try:
        run_alembic(environment, "downgrade", BEFORE_GRID)
        _seed_old_shape(engine, ids)
        run_alembic(environment, "upgrade", head)
        run_alembic(environment, "check")
        with engine.connect() as connection:
            assert _placements(connection, ids["harbor"]) == [
                ("summary", 0, 0, 2, 1),
                ("workload", 2, 0, 2, 2),
                ("records", 0, 1, 2, 2),
                ("chart", 2, 2, 2, 2),
            ]
            assert _placements(connection, ids["numbers"]) == [
                *(
                    ("summary", column, row, 2, 1)
                    for row in range(5)
                    for column in (0, 2)
                ),
                ("summary", *UNPLACED),
            ]
            assert _placements(connection, ids["mixed"]) == [
                ("summary", 0, 0, 1, 1),
                ("chart", 0, 1, 4, 2),
                ("workload", 0, 3, 2, 2),
                ("records", *UNPLACED),
            ]
            assert _placements(connection, ids["pie_roomy"]) == [
                ("summary", 0, 0, 1, 1),
                ("chart", 1, 0, 3, 3),
            ]
            assert _placements(connection, ids["pie_tight"]) == [
                ("chart", 0, 0, 4, 2),
                ("summary", 0, 2, 2, 1),
                ("chart", 2, 2, 2, 2),
            ]
            assert connection.execute(
                text(
                    "SELECT grid_column, grid_row, column_span, row_span "
                    "FROM public.dashboard_widgets WHERE id = :id"
                ),
                {"id": ids["deleted_widget"]},
            ).one() == UNPLACED
            homes = dict(
                connection.execute(
                    text(
                        "SELECT name, is_home FROM public.dashboards WHERE org_id = :org"
                    ),
                    {"org": ids["org"]},
                ).all()
            )
            assert homes == {
                "Harbor": True,
                "Archived first": False,
                "Numbers": False,
                "Mixed": True,
                "Only archived": False,
                "Pie roomy": True,
                "Pie tight": True,
            }
            _assert_catalog(connection)
        _assert_placement_check(engine, ids["harbor"])
    finally:
        _delete_rows(engine, ids)
        engine.dispose()


def _seed_old_shape(engine: Engine, ids: dict[str, UUID]) -> None:
    with Session(engine) as db:
        ids["org"] = create_organization(db).id
        db.commit()
    with engine.begin() as connection:
        departments = {}
        for key in (
            "harbor_department",
            "mixed_department",
            "archived_department",
            "pie_roomy_department",
            "pie_tight_department",
        ):
            ids[key] = departments[key] = uuid7()
            connection.execute(
                text(
                    "INSERT INTO public.departments (id, org_id, department_name) "
                    "VALUES (:id, :org, :name)"
                ),
                {"id": ids[key], "org": ids["org"], "name": f"Grid {ids[key].hex}"},
            )
        for key, name, department, position, archived in (
            ("harbor", "Harbor", "harbor_department", 0, False),
            ("archived_first", "Archived first", "mixed_department", 0, True),
            ("numbers", "Numbers", "mixed_department", 2, False),
            ("mixed", "Mixed", "mixed_department", 1, False),
            ("only_archived", "Only archived", "archived_department", 0, True),
            ("pie_roomy", "Pie roomy", "pie_roomy_department", 0, False),
            ("pie_tight", "Pie tight", "pie_tight_department", 0, False),
        ):
            ids[key] = uuid7()
            connection.execute(
                text(
                    "INSERT INTO public.dashboards (id, org_id, department_id, name, position, "
                    "is_deleted, deleted_at) VALUES (:id, :org, :department, :name, :position, "
                    ":archived, CASE WHEN :archived THEN now() END)"
                ),
                {
                    "id": ids[key],
                    "org": ids["org"],
                    "department": ids[department],
                    "name": name,
                    "position": position,
                    "archived": archived,
                },
            )
        ids["module"], ids["pie_chart"] = uuid7(), uuid7()
        connection.execute(
            text(
                "INSERT INTO public.modules (id, org_id, department_id, module_name) "
                "VALUES (:id, :org, :department, 'Pie source')"
            ),
            {"id": ids["module"], "org": ids["org"], "department": ids["pie_tight_department"]},
        )
        connection.execute(
            text(
                "INSERT INTO public.charts (id, org_id, department_id, module_id, name, "
                "chart_type, query) VALUES (:id, :org, :department, :module, 'Saved pie', "
                "'pie', '{}'::jsonb)"
            ),
            {
                "id": ids["pie_chart"],
                "org": ids["org"],
                "department": ids["pie_tight_department"],
                "module": ids["module"],
            },
        )
        for key, widgets in (
            ("harbor", HARBOR),
            ("numbers", ELEVEN_NUMBERS),
            ("mixed", MIXED),
            ("pie_roomy", PIE_ROOMY),
            ("pie_tight", PIE_TIGHT),
        ):
            for position, (kind, size) in enumerate(widgets):
                _insert_old_widget(
                    connection, uuid7(), ids[key], position, kind, size, ids.get("pie_chart")
                )
        # A removed widget keeps no cells and blocks nothing.
        ids["deleted_widget"] = uuid7()
        _insert_old_widget(
            connection, ids["deleted_widget"], ids["harbor"], 0, "records", "L", deleted=True
        )


def _insert_old_widget(
    connection: Connection,
    widget_id: UUID,
    dashboard_id: UUID,
    position: int,
    kind: str,
    size: str,
    saved_pie: UUID | None = None,
    *,
    deleted: bool = False,
) -> None:
    """``pie`` is an inline pie chart; ``saved_pie`` references the saved pie chart."""
    widget_type = "chart" if kind in {"pie", "saved_pie"} else kind
    config = {"version": 1, "chart_type": "pie"} if kind == "pie" else {"version": 1}
    connection.execute(
        text(
            "INSERT INTO public.dashboard_widgets (id, org_id, dashboard_id, position, "
            "widget_type, size, config, chart_id, is_deleted, deleted_at) VALUES (:id, "
            "(SELECT org_id FROM public.dashboards WHERE id = :dashboard), :dashboard, "
            ":position, :widget_type, :size, CAST(:config AS jsonb), :chart, :deleted, "
            "CASE WHEN :deleted THEN now() END)"
        ),
        {
            "id": widget_id,
            "dashboard": dashboard_id,
            "position": position,
            "widget_type": widget_type,
            "size": size,
            "config": None if kind == "saved_pie" else json.dumps(config),
            "chart": saved_pie if kind == "saved_pie" else None,
            "deleted": deleted,
        },
    )


def _placements(
    connection: Connection, dashboard_id: UUID
) -> list[tuple[str, int | None, int | None, int | None, int | None]]:
    return [
        (row[0], row[1], row[2], row[3], row[4])
        for row in connection.execute(
            text(
                "SELECT widget_type, grid_column, grid_row, column_span, row_span "
                "FROM public.dashboard_widgets WHERE dashboard_id = :id AND is_deleted = false "
                "ORDER BY position"
            ),
            {"id": dashboard_id},
        ).all()
    ]


def _assert_catalog(connection: Connection) -> None:
    columns = set(
        connection.scalars(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'dashboard_widgets'"
            )
        )
    )
    assert {"grid_column", "grid_row", "column_span", "row_span"} <= columns
    assert "size" not in columns
    checks = dict(
        connection.execute(
            text(
                "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conrelid = 'public.dashboard_widgets'::regclass AND contype = 'c'"
            )
        ).all()
    )
    assert "ck_dashboard_widgets_size" not in checks
    checks = {name: definition.replace('"', "") for name, definition in checks.items()}
    assert "position < 20" in checks["ck_dashboard_widgets_position"]
    assert "(grid_column + column_span) <= 4" in checks["ck_dashboard_widgets_placement"]
    assert "(grid_row + row_span) <= 5" in checks["ck_dashboard_widgets_placement"]
    home_index = connection.scalar(
        text(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' "
            "AND indexname = 'uq_dashboards_department_home'"
        )
    )
    assert home_index is not None
    definition = home_index.lower()
    assert "create unique index" in definition and "(org_id, department_id)" in definition
    assert "is_home" in definition and "not is_deleted" in definition


def _assert_placement_check(engine: Engine, dashboard_id: UUID) -> None:
    for column, row, columns, rows in (
        (0, 0, None, 1),  # partly placed
        (3, 0, 2, 1),  # past the fourth column
        (0, 4, 1, 2),  # past the fifth row
        (-1, 0, 1, 1),
    ):
        with pytest.raises(IntegrityError) as caught, engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO public.dashboard_widgets (id, org_id, dashboard_id, position, "
                    "widget_type, config, grid_column, grid_row, column_span, row_span) "
                    "VALUES (:id, (SELECT org_id FROM public.dashboards WHERE id = :dashboard), "
                    ":dashboard, 19, 'summary', '{}'::jsonb, :column, :row, :columns, :rows)"
                ),
                {
                    "id": uuid7(),
                    "dashboard": dashboard_id,
                    "column": column,
                    "row": row,
                    "columns": columns,
                    "rows": rows,
                },
            )
        assert caught.value.orig.diag.constraint_name == "ck_dashboard_widgets_placement"


def _delete_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    if "org" not in ids:
        return
    with engine.begin() as connection:
        for table in (
            "dashboard_widgets",
            "dashboards",
            "charts",
            "modules",
            "departments",
            "organizations",
        ):
            column = "id" if table == "organizations" else "org_id"
            connection.execute(
                text(f"DELETE FROM public.{table} WHERE {column} = :org"), {"org": ids["org"]}
            )
