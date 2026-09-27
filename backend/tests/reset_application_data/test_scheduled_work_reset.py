"""Static table, order, target, and migration contracts for local reset."""

from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.core.config.instance import InstanceTarget
from operations import reset_application_data as reset
from operations import reset_models, reset_planning


def test_reset_includes_views_boards_dashboards_and_reports_in_safe_delete_order() -> None:
    assert "saved_view_defaults" in reset_models.APPLICATION_TABLES
    assert "saved_view_defaults" in reset_models.NON_PRESERVED_TABLES
    assert "public.saved_view_defaults" in reset_models._LOCK_APPLICATION_STATEMENT
    assert reset_models.DELETE_ORDER.index("saved_view_defaults") < reset_models.DELETE_ORDER.index(
        "saved_views"
    )
    for table in ("board_grants", "board_record_placements", "board_widgets", "boards"):
        assert table in reset_models.APPLICATION_TABLES
        assert table in reset_models.NON_PRESERVED_TABLES
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
        assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    assert reset_models.DELETE_ORDER.index("board_grants") < reset_models.DELETE_ORDER.index(
        "boards"
    )
    assert reset_models.DELETE_ORDER.index("board_widgets") < reset_models.DELETE_ORDER.index(
        "boards"
    )
    assert reset_models.DELETE_ORDER.index("boards") < reset_models.DELETE_ORDER.index(
        "departments"
    )
    assert reset_models.DELETE_ORDER.index(
        "board_record_placements"
    ) < reset_models.DELETE_ORDER.index("boards")
    assert reset_models.DELETE_ORDER.index(
        "board_record_placements"
    ) < reset_models.DELETE_ORDER.index("records")
    for table in (
        "dashboard_defaults",
        "dashboard_widgets",
        "dashboards",
        "report_run_eligible_users",
        "report_run_rows",
        "report_runs",
        "reports",
    ):
        assert table in reset_models.APPLICATION_TABLES
        assert table in reset_models.NON_PRESERVED_TABLES
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
        assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    assert reset_models.DELETE_ORDER.index("dashboard_defaults") < reset_models.DELETE_ORDER.index(
        "dashboards"
    )
    assert reset_models.DELETE_ORDER.index("dashboard_widgets") < reset_models.DELETE_ORDER.index(
        "dashboards"
    )
    assert reset_models.DELETE_ORDER.index("dashboards") < reset_models.DELETE_ORDER.index(
        "departments"
    )
    assert reset_models.DELETE_ORDER.index("reports") < reset_models.DELETE_ORDER.index("modules")
    assert reset_models.DELETE_ORDER.index("report_run_rows") < reset_models.DELETE_ORDER.index(
        "report_runs"
    )
    assert reset_models.DELETE_ORDER.index("report_run_eligible_users") < (
        reset_models.DELETE_ORDER.index("report_runs")
    )
    assert reset_models.DELETE_ORDER.index("report_runs") < reset_models.DELETE_ORDER.index(
        "reports"
    )
    assert reset_models.DELETE_ORDER.index("report_run_rows") < reset_models.DELETE_ORDER.index(
        "records"
    )


def test_reset_derives_the_single_current_alembic_head() -> None:
    config = Config()
    config.set_main_option("script_location", "migrations")
    heads = ScriptDirectory.from_config(config).get_heads()
    assert len(heads) == 1
    assert reset_planning._expected_alembic_head() == heads[0]


def test_reset_counts_locks_and_deletes_scheduled_report_children_first() -> None:
    for table in ("in_app_notifications", "report_schedules", "scheduled_work"):
        assert table in reset_models.APPLICATION_TABLES
        assert table in reset_models.NON_PRESERVED_TABLES
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
        assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS

    order = reset_models.DELETE_ORDER
    assert order.index("in_app_notifications") < order.index("scheduled_work")
    assert order.index("report_schedules") < order.index("scheduled_work")
    assert order.index("report_schedules") < order.index("reports")
    assert order.index("scheduled_work") < order.index("report_runs")
    assert order.index("scheduled_work") < order.index("reports")


def test_reset_counts_locks_and_deletes_memberships_before_departments() -> None:
    table = "user_departments"
    assert table in reset_models.APPLICATION_TABLES
    assert table in reset_models.NON_PRESERVED_TABLES
    assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
    assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    assert reset_models.DELETE_ORDER.index(table) < reset_models.DELETE_ORDER.index("departments")


def test_reset_counts_locks_and_deletes_board_templates() -> None:
    table = "board_templates"
    assert table in reset_models.APPLICATION_TABLES
    assert table in reset_models.NON_PRESERVED_TABLES
    assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
    assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    assert table in reset_models.DELETE_ORDER


def test_reset_counts_locks_and_deletes_board_personal_state_before_parents() -> None:
    for table in ("board_favorites", "board_homes"):
        assert table in reset_models.APPLICATION_TABLES
        assert table in reset_models.NON_PRESERVED_TABLES
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
        assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
        assert reset_models.DELETE_ORDER.index(table) < reset_models.DELETE_ORDER.index("boards")


def test_reset_counts_locks_and_deletes_board_events_before_board_and_author() -> None:
    table = "board_events"
    assert table in reset_models.APPLICATION_TABLES
    assert table in reset_models.NON_PRESERVED_TABLES
    assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
    assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    assert reset_models.DELETE_ORDER.index(table) < reset_models.DELETE_ORDER.index("boards")


def test_reset_counts_locks_and_deletes_announcement_revisions_before_parents() -> None:
    for table in ("board_announcement_revisions", "board_announcements"):
        assert table in reset_models.APPLICATION_TABLES
        assert table in reset_models.NON_PRESERVED_TABLES
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
        assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    order = reset_models.DELETE_ORDER
    assert order.index("in_app_notifications") < order.index("scheduled_work")
    assert order.index("scheduled_work") < order.index("board_announcement_revisions")
    assert order.index("board_announcement_revisions") < order.index("board_announcements")
    assert order.index("board_announcements") < order.index("boards")
    assert order.index("board_announcements") < order.index("departments")


def test_reset_deletes_all_announcement_personal_state_before_announcements_and_users() -> None:
    table = "board_announcement_personal_states"
    assert table in reset_models.APPLICATION_TABLES
    assert table in reset_models.NON_PRESERVED_TABLES
    assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
    assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    # DELETE_ORDER is executed without a user filter, including preserved-admin rows.
    assert reset_models.DELETE_ORDER.count(table) == 1
    assert reset_models.DELETE_ORDER.index(table) < reset_models.DELETE_ORDER.index(
        "board_announcements"
    )


def test_reset_rejects_urls_that_do_not_match_the_attested_instance() -> None:
    target = InstanceTarget(
        instance_id="openslate-supabase-a1b2c3d4",
        host="127.0.0.1",
        port=55432,
        database="postgres",
        attestation_path=Path("/tmp/instance.json"),
    )
    local = "postgresql+psycopg://openslate_owner:secret@127.0.0.1:55432/postgres"
    assert reset.validate_local_database_url(local, target) is None
    with pytest.raises(reset.ResetError):
        reset.validate_local_database_url(local)
    for url in (
        local.replace("127.0.0.1", "remote.example"),
        local.replace("openslate_owner", "openslate_runtime"),
        local.replace("55432", "54322"),
        local.replace("/postgres", "/other_database"),
    ):
        with pytest.raises(reset.ResetError):
            reset.validate_local_database_url(url, target)
    with pytest.raises(reset.ResetError):
        reset.required_environment({"DATABASE_URL": local, "ADMIN_EMAIL": "admin@example.test"})
    with pytest.raises(reset.ResetError):
        reset.required_storage_environment(
            {"BACKEND_BIND_HOST": "127.0.0.1", "BACKEND_PORT": "8000"}
        )
