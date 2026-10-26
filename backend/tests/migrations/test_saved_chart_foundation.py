"""Real PostgreSQL catalog, binding and runtime guarantees for saved charts."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.models import BoardWidget
from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.models import DashboardWidget
from tests.migrations.saved_chart_migration_support import ChartMigrationFixture
from tests.migrations.saved_chart_migration_support import chart_migration as chart_migration

pytestmark = pytest.mark.integration


def test_saved_chart_catalog_roles_and_runtime_crud(chart_migration: ChartMigrationFixture):
    fixture = chart_migration
    with fixture.owner.connect() as connection:
        columns = {
            (row["table_name"], row["column_name"]): row
            for row in connection.execute(
                text("""
                SELECT table_name, column_name, udt_name, is_nullable, column_default,
                       character_maximum_length
                FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name IN ('charts', 'board_widgets', 'dashboard_widgets')
            """)
            ).mappings()
        }
        assert {name for table, name in columns if table == "charts"} == {
            "id", "org_id", "department_id", "module_id", "name", "chart_type", "query",
            "revision", "created_at", "updated_at", "deleted_at", "is_deleted", "performed_by",
        }
        assert columns["charts", "name"]["character_maximum_length"] == 120
        assert columns["charts", "query"]["udt_name"] == "jsonb"
        assert columns["charts", "query"]["is_nullable"] == "NO"
        assert columns["charts", "revision"]["column_default"] == "1"
        for table in ("board_widgets", "dashboard_widgets"):
            assert columns[table, "config"]["is_nullable"] == "YES"
            assert columns[table, "chart_id"]["udt_name"] == "uuid"
        assert columns["board_widgets", "size"]["is_nullable"] == "NO"
        assert "'M'" in columns["board_widgets", "size"]["column_default"]
        constraints = {
            row["conname"]: row
            for row in connection.execute(
                text("""
                SELECT conname, contype, confdeltype FROM pg_constraint
                WHERE conrelid IN ('public.charts'::regclass, 'public.board_widgets'::regclass,
                                   'public.dashboard_widgets'::regclass)
            """)
            ).mappings()
        }
        for name in (
            "ck_charts_name_nonempty", "ck_charts_revision_positive", "ck_charts_type",
            "ck_board_widgets_size", "ck_dashboard_widgets_placement",
            "ck_board_widgets_query_source", "ck_dashboard_widgets_query_source",
        ):
            assert constraints[name]["contype"] == "c"
        for name in (
            "fk_charts_department_id_departments", "fk_charts_module_id_modules",
            "fk_board_widgets_chart_id_charts", "fk_dashboard_widgets_chart_id_charts",
        ):
            assert constraints[name]["confdeltype"] == "r"
        assert constraints["fk_charts_performed_by_users"]["confdeltype"] == "n"
        indexes = set(connection.scalars(text("""
            SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
              AND tablename IN ('charts', 'board_widgets', 'dashboard_widgets')
        """)))
        assert {
            "charts_pkey", "ix_charts_module_id", "ix_charts_department_id",
            "ix_board_widgets_chart_id", "ix_dashboard_widgets_chart_id",
        } <= indexes
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert connection.scalar(
                text("SELECT has_table_privilege('openslate_runtime', 'public.charts', :p)"),
                {"p": privilege},
            )
            for role in ("anon", "authenticated", "service_role"):
                assert not connection.scalar(
                    text("SELECT has_table_privilege(:role, 'public.charts', :p)"),
                    {"role": role, "p": privilege},
                )
        assert connection.scalar(text("""
            SELECT count(*) FROM pg_class c, LATERAL aclexplode(
                COALESCE(c.relacl, acldefault('r', c.relowner))) a
            WHERE c.oid = 'public.charts'::regclass AND a.grantee = 0
        """)) == 0
    with fixture.runtime.begin() as connection:
        assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
        _chart(connection, fixture)
        assert connection.scalar(
            text("SELECT revision FROM public.charts WHERE id = :id"), {"id": fixture.ids["chart"]}
        ) == 1
        connection.execute(
            text("UPDATE public.charts SET name = 'Edited' WHERE id = :id"),
            {"id": fixture.ids["chart"]},
        )
        assert connection.scalar(
            text("SELECT name FROM public.charts WHERE id = :id"), {"id": fixture.ids["chart"]}
        ) == "Edited"
        connection.execute(text("DELETE FROM public.charts WHERE id = :id"),
                           {"id": fixture.ids["chart"]})
        for kind in ("bar", "line", "pie", "summary", "workload", "records"):
            _chart(connection, fixture, kind=kind)
            connection.execute(text("DELETE FROM public.charts WHERE id = :id"),
                               {"id": fixture.ids["chart"]})


def _chart(connection, fixture, **changes):
    values = {
        "id": fixture.ids["chart"], "org": fixture.ids["org"],
        "department": fixture.ids["department"], "module": fixture.ids["module"],
        "name": "Literal chart", "kind": "summary", "revision": 1,
        "actor": fixture.ids["actor"],
    }
    values.update(changes)
    connection.execute(text("""
        INSERT INTO public.charts (id, org_id, department_id, module_id, name, chart_type, query,
                                   revision, performed_by)
        VALUES (:id, :org, :department, :module, :name, :kind, '{}'::jsonb, :revision, :actor)
    """), values)


@pytest.mark.parametrize("change", ["name", "revision", "kind", "module", "department", "actor"])
def test_chart_rejects_invalid_catalog_values_and_missing_parents(chart_migration, change):
    value = {"name": " ", "revision": 0, "kind": "pivot"}.get(change, uuid7())
    with chart_migration.runtime.begin() as connection:
        with pytest.raises(IntegrityError), connection.begin_nested():
            _chart(connection, chart_migration, **{change: value})
        assert connection.scalar(
            text("SELECT count(*) FROM public.charts WHERE id = :id"),
            {"id": chart_migration.ids["chart"]},
        ) == 0


@pytest.mark.parametrize("table", ["board_widgets", "dashboard_widgets"])
@pytest.mark.parametrize("invalid", ["both", "neither", "missing-chart", "size"])
def test_widget_query_source_and_size_constraints(chart_migration, table, invalid):
    fixture = chart_migration
    with fixture.runtime.begin() as connection:
        _chart(connection, fixture)
        common = {
            "id": uuid7(), "org": fixture.ids["org"],
            "parent": fixture.ids["board" if table == "board_widgets" else "dashboard"],
            "chart": fixture.ids["chart"], "config": None, "size": "M",
            "module": fixture.ids["module"],
        }
        if invalid == "both":
            common["config"] = '{"version":1}'
        elif invalid == "neither":
            common["chart"] = None
        elif invalid == "missing-chart":
            common["chart"] = uuid7()
        else:
            # Board widgets keep S/M/L; Dashboard widgets cover cells of the 4 x 5 grid.
            common["size"] = "Z"
            common["span"] = 5
        board = table == "board_widgets"
        fields = "board_id, module_id, name, size" if board else (
            "dashboard_id, grid_column, grid_row, column_span, row_span"
        )
        values = ":parent, :module, 'Tile', :size" if board else ":parent, 0, 0, :span, 1"
        common.setdefault("span", 1)
        with pytest.raises(IntegrityError), connection.begin_nested():
            connection.execute(text(f"""INSERT INTO public.{table}
                (id, org_id, {fields}, position, widget_type, config, chart_id)
                VALUES (:id, :org, {values}, 0, 'summary', CAST(:config AS jsonb), :chart)
            """), common)


def test_orm_sql_null_references_fk_restrict_and_actor_set_null(chart_migration):
    fixture = chart_migration
    with Session(fixture.runtime) as session:
        session.add(Chart(
            id=fixture.ids["chart"], org_id=fixture.ids["org"],
            department_id=fixture.ids["department"], module_id=fixture.ids["module"],
            name="ORM query", chart_type="summary",
            query={"module_id": str(fixture.ids["module"])}, performed_by=fixture.ids["actor"],
        ))
        session.flush()
        session.add_all([
            BoardWidget(
                org_id=fixture.ids["org"], board_id=fixture.ids["board"],
                module_id=fixture.ids["module"], name="ORM Board", position=0,
                widget_type="summary", chart_id=fixture.ids["chart"], config=None,
            ),
            DashboardWidget(
                org_id=fixture.ids["org"], dashboard_id=fixture.ids["dashboard"], position=0,
                widget_type="summary", chart_id=fixture.ids["chart"], config=None,
            ),
        ])
        session.commit()
    with fixture.owner.begin() as connection:
        for table in ("board_widgets", "dashboard_widgets"):
            assert connection.scalar(
                text(f"SELECT bool_and(config IS NULL) FROM public.{table} WHERE chart_id = :id"),
                {"id": fixture.ids["chart"]},
            ) is True
        for size in ("S", "M", "L"):
            connection.execute(
                text("UPDATE public.board_widgets SET size = :size WHERE chart_id = :id"),
                {"id": fixture.ids["chart"], "size": size},
            )
            assert connection.scalar(
                text("SELECT size FROM public.board_widgets WHERE chart_id = :id"),
                {"id": fixture.ids["chart"]},
            ) == size
        for table, identifier in (
            ("charts", fixture.ids["chart"]), ("modules", fixture.ids["module"]),
        ):
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(text(f"DELETE FROM public.{table} WHERE id = :id"),
                                   {"id": identifier})
        connection.execute(text("DELETE FROM public.memberships WHERE user_id = :id"),
                           {"id": fixture.ids["actor"]})
        connection.execute(text("DELETE FROM public.users WHERE id = :id"),
                           {"id": fixture.ids["actor"]})
        assert connection.scalar(
            text("SELECT performed_by IS NULL FROM public.charts WHERE id = :id"),
            {"id": fixture.ids["chart"]},
        ) is True
