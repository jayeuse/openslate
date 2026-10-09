"""Real PostgreSQL catalog, binding and reversible-lineage guarantees for saved charts."""

import json
import subprocess

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.models import BoardWidget
from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.models import DashboardWidget
from tests.migrations.saved_chart_migration_support import (
    HEAD,
    PREDECESSOR,
    ChartMigrationFixture,
)
from tests.migrations.saved_chart_migration_support import chart_migration as chart_migration
from tests.migrations.saved_chart_migration_support import literal_query as _literal_query
from tests.operations.migration_support import run_alembic

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
            "id",
            "department_id",
            "module_id",
            "name",
            "chart_type",
            "query",
            "revision",
            "created_at",
            "updated_at",
            "deleted_at",
            "is_deleted",
            "performed_by",
        }
        assert columns["charts", "name"]["character_maximum_length"] == 120
        assert columns["charts", "query"]["udt_name"] == "jsonb"
        assert columns["charts", "query"]["is_nullable"] == "NO"
        assert columns["charts", "revision"]["column_default"] == "1"
        for table in ("board_widgets", "dashboard_widgets"):
            assert columns[table, "config"]["is_nullable"] == "YES"
            assert columns[table, "chart_id"]["udt_name"] == "uuid"
            assert columns[table, "size"]["is_nullable"] == "NO"
            assert "'M'" in columns[table, "size"]["column_default"]
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
            "ck_charts_name_nonempty",
            "ck_charts_revision_positive",
            "ck_charts_type",
            "ck_board_widgets_size",
            "ck_dashboard_widgets_size",
            "ck_board_widgets_query_source",
            "ck_dashboard_widgets_query_source",
        ):
            assert constraints[name]["contype"] == "c"
        for name in (
            "fk_charts_department_id_departments",
            "fk_charts_module_id_modules",
            "fk_board_widgets_chart_id_charts",
            "fk_dashboard_widgets_chart_id_charts",
        ):
            assert constraints[name]["confdeltype"] == "r"
        assert constraints["fk_charts_performed_by_users"]["confdeltype"] == "n"
        indexes = set(
            connection.scalars(
                text("""
            SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
              AND tablename IN ('charts', 'board_widgets', 'dashboard_widgets')
        """)
            )
        )
        assert {
            "charts_pkey",
            "ix_charts_module_id",
            "ix_charts_department_id",
            "ix_board_widgets_chart_id",
            "ix_dashboard_widgets_chart_id",
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
        assert (
            connection.scalar(
                text("""
            SELECT count(*) FROM pg_class c, LATERAL aclexplode(
                COALESCE(c.relacl, acldefault('r', c.relowner))) a
            WHERE c.oid = 'public.charts'::regclass AND a.grantee = 0
        """)
            )
            == 0
        )
    with fixture.runtime.begin() as connection:
        assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
        _chart(connection, fixture)
        assert (
            connection.scalar(
                text("SELECT revision FROM public.charts WHERE id = :id"),
                {"id": fixture.ids["chart"]},
            )
            == 1
        )
        connection.execute(
            text("UPDATE public.charts SET name = 'Edited' WHERE id = :id"),
            {"id": fixture.ids["chart"]},
        )
        assert (
            connection.scalar(
                text("SELECT name FROM public.charts WHERE id = :id"), {"id": fixture.ids["chart"]}
            )
            == "Edited"
        )
        connection.execute(
            text("DELETE FROM public.charts WHERE id = :id"), {"id": fixture.ids["chart"]}
        )
        for kind in ("bar", "line", "pie", "summary", "workload", "records"):
            _chart(connection, fixture, kind=kind)
            connection.execute(
                text("DELETE FROM public.charts WHERE id = :id"), {"id": fixture.ids["chart"]}
            )


def _chart(connection, fixture, **changes):
    values = {
        "id": fixture.ids["chart"],
        "department": fixture.ids["department"],
        "module": fixture.ids["module"],
        "name": "Literal chart",
        "kind": "summary",
        "revision": 1,
        "actor": fixture.ids["actor"],
    }
    values.update(changes)
    connection.execute(
        text("""
        INSERT INTO public.charts (id, department_id, module_id, name, chart_type, query,
                                   revision, performed_by)
        VALUES (:id, :department, :module, :name, :kind, '{}'::jsonb, :revision, :actor)
    """),
        values,
    )


@pytest.mark.parametrize("change", ["name", "revision", "kind", "module", "department", "actor"])
def test_chart_rejects_invalid_catalog_values_and_missing_parents(chart_migration, change):
    value = {"name": " ", "revision": 0, "kind": "pivot"}.get(change, uuid7())
    with chart_migration.runtime.begin() as connection:
        with pytest.raises(IntegrityError), connection.begin_nested():
            _chart(connection, chart_migration, **{change: value})
        assert (
            connection.scalar(
                text("SELECT count(*) FROM public.charts WHERE id = :id"),
                {"id": chart_migration.ids["chart"]},
            )
            == 0
        )


@pytest.mark.parametrize("table", ["board_widgets", "dashboard_widgets"])
@pytest.mark.parametrize("invalid", ["both", "neither", "missing-chart", "size"])
def test_widget_query_source_and_size_constraints(chart_migration, table, invalid):
    fixture = chart_migration
    with fixture.runtime.begin() as connection:
        _chart(connection, fixture)
        common = {
            "id": uuid7(),
            "parent": fixture.ids["board" if table == "board_widgets" else "dashboard"],
            "chart": fixture.ids["chart"],
            "config": None,
            "size": "M",
            "module": fixture.ids["module"],
        }
        if invalid == "both":
            common["config"] = '{"version":1}'
        elif invalid == "neither":
            common["chart"] = None
        elif invalid == "missing-chart":
            common["chart"] = uuid7()
        else:
            common["size"] = "Z"
        board = table == "board_widgets"
        fields = "board_id, module_id, name" if board else "dashboard_id"
        values = ":parent, :module, 'Tile'" if board else ":parent"
        with pytest.raises(IntegrityError), connection.begin_nested():
            connection.execute(
                text(f"""INSERT INTO public.{table}
                (id, {fields}, position, widget_type, config, chart_id, size)
                VALUES (:id, {values}, 0, 'summary', CAST(:config AS jsonb), :chart, :size)
            """),
                common,
            )


def test_orm_sql_null_references_fk_restrict_and_actor_set_null(chart_migration):
    fixture = chart_migration
    with Session(fixture.runtime) as session:
        session.add(
            Chart(
                id=fixture.ids["chart"],
                department_id=fixture.ids["department"],
                module_id=fixture.ids["module"],
                name="ORM query",
                chart_type="summary",
                query={"module_id": str(fixture.ids["module"])},
                performed_by=fixture.ids["actor"],
            )
        )
        session.flush()
        session.add_all(
            [
                BoardWidget(
                    board_id=fixture.ids["board"],
                    module_id=fixture.ids["module"],
                    name="ORM Board",
                    position=0,
                    widget_type="summary",
                    chart_id=fixture.ids["chart"],
                    config=None,
                ),
                DashboardWidget(
                    dashboard_id=fixture.ids["dashboard"],
                    position=0,
                    widget_type="summary",
                    chart_id=fixture.ids["chart"],
                    config=None,
                ),
            ]
        )
        session.commit()
    with fixture.owner.begin() as connection:
        for table in ("board_widgets", "dashboard_widgets"):
            assert (
                connection.scalar(
                    text(
                        f"SELECT bool_and(config IS NULL) FROM public.{table} WHERE chart_id = :id"
                    ),
                    {"id": fixture.ids["chart"]},
                )
                is True
            )
            for size in ("S", "M", "L"):
                connection.execute(
                    text(f"UPDATE public.{table} SET size = :size WHERE chart_id = :id"),
                    {"id": fixture.ids["chart"], "size": size},
                )
                assert (
                    connection.scalar(
                        text(f"SELECT size FROM public.{table} WHERE chart_id = :id"),
                        {"id": fixture.ids["chart"]},
                    )
                    == size
                )
        for table, identifier in (
            ("charts", fixture.ids["chart"]),
            ("modules", fixture.ids["module"]),
        ):
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(
                    text(f"DELETE FROM public.{table} WHERE id = :id"), {"id": identifier}
                )
        connection.execute(
            text("DELETE FROM public.users WHERE id = :id"), {"id": fixture.ids["actor"]}
        )
        assert (
            connection.scalar(
                text("SELECT performed_by IS NULL FROM public.charts WHERE id = :id"),
                {"id": fixture.ids["chart"]},
            )
            is True
        )


def test_predecessor_backfill_preserves_rows_queries_timestamps_and_round_trip(
    chart_migration, capfd
):
    fixture = chart_migration
    fixture.rewind()
    layouts = [
        ({"size": "half", "pinned": False, "refresh": "manual"}, "M", False),
        ({"size": "half", "pinned": True, "refresh": "one-minute"}, "M", True),
        ({"size": "full", "pinned": False, "refresh": "five-minutes"}, "L", False),
        ({"size": "full", "pinned": True}, "L", True),
        ({}, "M", False),
        ({"size": "full"}, "L", False),
        ({"pinned": True}, "M", True),
    ]
    originals = [{**_literal_query(), **layout} for layout, _, _ in layouts]
    fixture.seed_legacy(originals)
    before = fixture.snapshots("board_widgets")
    dashboard_before = fixture.snapshots("dashboard_widgets")
    fixture.upgrade()
    after = fixture.snapshots("board_widgets")
    for previous, saved, (layout, size, pinned) in zip(before, after, layouts, strict=True):
        assert {
            key: value
            for key, value in saved.items()
            if key not in {"size", "pinned", "chart_id", "config"}
        } == {key: value for key, value in previous.items() if key != "config"}
        assert (saved["size"], saved["pinned"], saved["chart_id"]) == (size, pinned, None)
        assert saved["config"] == {
            **_literal_query(),
            **({"refresh": layout["refresh"]} if "refresh" in layout else {}),
        }
    assert {
        key: value
        for key, value in fixture.snapshots("dashboard_widgets")[0].items()
        if key not in {"size", "chart_id"}
    } == dashboard_before[0]
    fixture.rewind()
    restored = fixture.snapshots("board_widgets")
    for row, previous, (_, size, pinned) in zip(restored, before, layouts, strict=True):
        assert {key: value for key, value in row.items() if key != "config"} == {
            key: value for key, value in previous.items() if key != "config"
        }
        assert row["config"]["size"] == ("half" if size == "M" else "full")
        assert row["config"]["pinned"] is pinned
    fixture.upgrade()
    assert fixture.snapshots("board_widgets") == after
    captured = capfd.readouterr()
    fixture.record_lineage(captured.out, captured.err)


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        [],
        {"size": "S"},
        {"pinned": "yes"},
        {"pinned": None},
        {"unknown": 1},
        {"refresh": "hourly"},
        {"version": True},
        {"fields": [{"field_id": "bad", "expected_type": "text"}]},
        {"metric": {"field_id": "11111111-1111-4111-8111-111111111111", "expected_type": "text"}},
    ],
)
def test_invalid_predecessor_config_refuses_upgrade_without_partial_changes(
    chart_migration, invalid
):
    fixture = chart_migration
    fixture.rewind()
    fixture.seed_legacy([invalid])
    before = fixture.snapshots("board_widgets")
    with pytest.raises(subprocess.CalledProcessError):
        run_alembic(fixture.environment, "upgrade", HEAD)
    _assert_predecessor(fixture)
    assert fixture.snapshots("board_widgets") == before


def _assert_predecessor(fixture):
    assert fixture.revision() == PREDECESSOR
    with fixture.owner.connect() as connection:
        assert connection.scalar(text("SELECT to_regclass('public.charts')")) is None
        assert (
            connection.scalar(
                text("""SELECT count(*) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name IN ('board_widgets','dashboard_widgets')
              AND column_name IN ('size', 'pinned', 'chart_id')""")
            )
            == 0
        )


def test_update_failure_rolls_back_new_schema_and_all_widget_data(chart_migration):
    fixture = chart_migration
    fixture.rewind()
    fixture.seed_legacy([{**_literal_query(), "size": "full", "pinned": True}])
    before = fixture.snapshots("board_widgets")
    suffix = fixture.ids["board"].hex
    function = "s26_fail_" + suffix
    with fixture.owner.begin() as connection:
        connection.execute(
            text(f"""CREATE FUNCTION public.{function}() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned migration failure'; END $$""")
        )
        connection.execute(
            text(
                "CREATE TRIGGER s26_failure AFTER UPDATE ON public.board_widgets "
                f"FOR EACH STATEMENT EXECUTE FUNCTION public.{function}()"
            )
        )
    try:
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(fixture.environment, "upgrade", HEAD)
        _assert_predecessor(fixture)
        assert fixture.snapshots("board_widgets") == before
    finally:
        with fixture.owner.begin() as connection:
            connection.execute(text("DROP TRIGGER s26_failure ON public.board_widgets"))
            connection.execute(text(f"DROP FUNCTION public.{function}()"))


@pytest.mark.parametrize(
    "state",
    [
        "chart",
        "board-reference",
        "dashboard-reference",
        "normalized",
        "board-S",
        "dashboard-S",
        "dashboard-L",
    ],
)
def test_downgrade_refuses_unrepresentable_retained_state_without_changes(chart_migration, state):
    fixture = chart_migration
    with fixture.owner.begin() as connection:
        if state in {"chart", "board-reference", "dashboard-reference"}:
            _chart(connection, fixture)
            connection.execute(
                text("UPDATE public.charts SET is_deleted = true WHERE id = :id"),
                {"id": fixture.ids["chart"]},
            )
        if state != "chart":
            board = state.startswith("board") or state == "normalized"
            table = "board_widgets" if board else "dashboard_widgets"
            parent_fields = "board_id, module_id, name" if board else "dashboard_id"
            parent_values = ":parent, :module, 'Retained'" if board else ":parent"
            reference = state.endswith("reference")
            config = (
                None
                if reference
                else json.dumps(
                    {"version": 1, "query": {}} if state == "normalized" else _literal_query()
                )
            )
            size = "S" if state.endswith("S") else "L" if state == "dashboard-L" else "M"
            connection.execute(
                text(f"""INSERT INTO public.{table}
                (id, {parent_fields}, position, widget_type, config, chart_id, size, is_deleted)
                VALUES (:id, {parent_values}, 0, 'summary',
                        CAST(:config AS jsonb), :chart, :size, true)
            """),
                {
                    "id": uuid7(),
                    "parent": fixture.ids["board" if board else "dashboard"],
                    "module": fixture.ids["module"],
                    "config": config,
                    "chart": fixture.ids["chart"] if reference else None,
                    "size": size,
                },
            )
    before = (fixture.snapshots("board_widgets"), fixture.snapshots("dashboard_widgets"))
    fixture.require_sole_consumer()
    with pytest.raises(subprocess.CalledProcessError):
        run_alembic(fixture.environment, "downgrade", PREDECESSOR)
    assert fixture.revision() == HEAD
    assert (fixture.snapshots("board_widgets"), fixture.snapshots("dashboard_widgets")) == before
