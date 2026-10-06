"""Guarded PostgreSQL coverage for combined Boards, OpenView, and Access reset."""

from __future__ import annotations

import os
from unittest.mock import Mock
from uuid import uuid4

import pytest
from psycopg import connect

from app.systems.boards.post_models import publication_content_fingerprint
from operations import reset_application_data as reset
from operations.reset import execution
from tests.conftest import _guard_integration_database


@pytest.mark.integration
def test_reset_removes_board_report_dashboard_hierarchy_and_preserves_administrator(
    request, monkeypatch
) -> None:
    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    runtime_url = os.environ.get("TEST_DATABASE_URL")
    owner_url = os.environ.get("MIGRATION_DATABASE_URL")
    if runtime_url is None or owner_url is None:
        raise RuntimeError("Reset integration requires the disposable PostgreSQL runner")
    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    database_url = owner_url.replace("postgresql+psycopg://", "postgresql://", 1)
    storage = Mock()
    storage.list_object_keys.return_value = ()
    auth = Mock()
    admin_id, member_id, session_id = uuid4(), uuid4(), uuid4()
    admin_provider_id, member_provider_id = uuid4(), uuid4()
    department_id, group_id = uuid4(), uuid4()
    module_id, title_field_id, file_id = uuid4(), uuid4(), uuid4()
    dashboard_id, widget_id = uuid4(), uuid4()
    board_id, project_board_id, record_id = uuid4(), uuid4(), uuid4()
    event_id, post_id = uuid4(), uuid4()
    report_id, run_id, work_id = uuid4(), uuid4(), uuid4()
    admin_email = f"reset-admin-{admin_id}@example.test"
    auth.list_account_ids.return_value = (member_provider_id,)
    workspace_settings_before_test = None

    def cleanup() -> None:
        _guard_integration_database(runtime_url)
        _guard_integration_database(owner_url)
        with connect(database_url) as database:
            with database.cursor() as cursor:
                if workspace_settings_before_test is not None:
                    cursor.execute(
                        "UPDATE public.workspace_profiles SET currency = %s, week_start = %s, "
                        "business_hours = %s, mark = %s",
                        workspace_settings_before_test,
                    )
                cursor.execute(
                    "UPDATE public.workspace_profiles SET logo_file_id = NULL "
                    "WHERE logo_file_id = %s",
                    (file_id,),
                )
                for table, column, owned_id in (
                    ("in_app_notifications", "work_id", work_id),
                    ("scheduled_work", "id", work_id),
                    ("report_run_eligible_users", "run_id", run_id),
                    ("report_run_rows", "run_id", run_id),
                    ("report_runs", "id", run_id),
                    ("report_schedules", "report_id", report_id),
                    ("reports", "id", report_id),
                    ("board_event_reminders", "event_id", event_id),
                    ("board_post_revisions", "post_id", post_id),
                    ("board_posts", "id", post_id),
                    ("board_events", "id", event_id),
                    ("dashboard_widgets", "dashboard_id", dashboard_id),
                    ("dashboards", "id", dashboard_id),
                    ("records", "id", record_id),
                ):
                    cursor.execute(f"DELETE FROM public.{table} WHERE {column} = %s", (owned_id,))
                for table in ("board_groups", "group_access", "group_members"):
                    cursor.execute(f"DELETE FROM public.{table} WHERE group_id = %s", (group_id,))
                cursor.execute(
                    "DELETE FROM public.boards WHERE id IN (%s, %s)",
                    (board_id, project_board_id),
                )
                cursor.execute(
                    "UPDATE public.modules SET title_field_id = NULL WHERE id = %s", (module_id,)
                )
                cursor.execute("DELETE FROM public.fields WHERE id = %s", (title_field_id,))
                cursor.execute("DELETE FROM public.modules WHERE id = %s", (module_id,))
                cursor.execute("DELETE FROM public.departments WHERE id = %s", (department_id,))
                cursor.execute("DELETE FROM public.files WHERE id = %s", (file_id,))
                cursor.execute("DELETE FROM public.groups WHERE id = %s", (group_id,))
                cursor.execute(
                    "DELETE FROM public.identity_sessions WHERE user_id IN (%s, %s)",
                    (admin_id, member_id),
                )
                cursor.execute(
                    "DELETE FROM public.lifecycle_rate_limit_buckets WHERE actor_id IN (%s, %s)",
                    (admin_id, member_id),
                )
                cursor.execute(
                    "DELETE FROM public.identity_rate_limit_buckets WHERE fingerprint IN (%s, %s)",
                    ("1" * 64, "2" * 64),
                )
                cursor.execute(
                    "DELETE FROM public.users WHERE id IN (%s, %s)", (admin_id, member_id)
                )
            database.commit()

    request.addfinalizer(cleanup)
    with connect(database_url) as database:
        with database.cursor() as cursor:
            cursor.execute(
                "SELECT currency, week_start, business_hours, mark FROM public.workspace_profiles"
            )
            workspace_settings_before_test = cursor.fetchone()
            cursor.execute(
                "INSERT INTO public.users (id, email, supabase_user_id, username, status, role) "
                "VALUES (%s, %s, %s, %s, 'active', 'admin'), "
                "(%s, %s, %s, %s, 'active', 'member')",
                (
                    admin_id,
                    admin_email,
                    admin_provider_id,
                    f"reset_admin_{admin_id.hex[:12]}",
                    member_id,
                    f"reset-member-{member_id}@example.test",
                    member_provider_id,
                    f"reset_member_{member_id.hex[:12]}",
                ),
            )
            cursor.execute(
                "INSERT INTO public.identity_sessions "
                "(id, user_id, refresh_token_digest, csrf_token_digest, created_at, refreshed_at, "
                "expires_at) VALUES (%s, %s, %s, %s, now(), now(), now() + interval '1 day'), "
                "(%s, %s, %s, %s, now(), now(), now() + interval '1 day')",
                (
                    session_id,
                    admin_id,
                    "a" * 64,
                    "b" * 64,
                    uuid4(),
                    member_id,
                    "c" * 64,
                    "d" * 64,
                ),
            )
            cursor.execute(
                "INSERT INTO public.identity_rate_limit_buckets "
                "(fingerprint, attempt_count, window_started_at) "
                "VALUES (%s, 1, now()), (%s, 1, now())",
                ("1" * 64, "2" * 64),
            )
            cursor.execute(
                "INSERT INTO public.lifecycle_rate_limit_buckets "
                "(id, actor_id, attempt_count, window_started_at, window_expires_at) "
                "VALUES (%s, %s, 1, now(), now() + interval '1 minute'), "
                "(%s, %s, 1, now(), now() + interval '1 minute')",
                (uuid4(), admin_id, uuid4(), member_id),
            )
            cursor.execute(
                "INSERT INTO public.departments (id, department_name) VALUES (%s, %s)",
                (department_id, f"reset-{admin_id}"),
            )
            cursor.execute(
                "INSERT INTO public.groups (id, name, performed_by) VALUES (%s, %s, %s)",
                (group_id, f"reset-group-{group_id.hex[:12]}", admin_id),
            )
            cursor.execute(
                "INSERT INTO public.group_members (id, group_id, user_id) VALUES (%s, %s, %s)",
                (uuid4(), group_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.group_access (id, group_id, department_id, level) "
                "VALUES (%s, %s, %s, 'read')",
                (uuid4(), group_id, department_id),
            )
            cursor.execute(
                "INSERT INTO public.modules (id, department_id, module_name) VALUES (%s, %s, %s)",
                (module_id, department_id, f"reset-module-{module_id.hex[:12]}"),
            )
            cursor.execute(
                "INSERT INTO public.fields (id, module_id, name, type, required, position) "
                "VALUES (%s, %s, 'Title', 'text', true, 0)",
                (title_field_id, module_id),
            )
            cursor.execute(
                "UPDATE public.modules SET title_field_id = %s WHERE id = %s",
                (title_field_id, module_id),
            )
            cursor.execute(
                "INSERT INTO public.files "
                "(id, purpose, creator_id, filename, expected_size, object_key, state) "
                "VALUES (%s, 'workspace_logo', %s, 'reset.png', 1, %s, 'awaiting_upload')",
                (file_id, admin_id, uuid4().hex),
            )
            cursor.execute(
                "UPDATE public.workspace_profiles SET logo_file_id = %s, currency = 'USD', "
                "week_start = 'sunday', business_hours = '10:00–16:00', mark = 'ACME'",
                (file_id,),
            )
            plan_before_dashboard = reset.build_reset_plan(
                database, admin_email, storage_object_keys=storage.list_object_keys()
            )
            cursor.execute(
                "INSERT INTO public.dashboards (id, department_id, name) VALUES (%s, %s, %s)",
                (dashboard_id, department_id, f"reset-dashboard-{dashboard_id.hex[:12]}"),
            )
            cursor.execute(
                "INSERT INTO public.dashboard_widgets "
                "(id, dashboard_id, position, widget_type, config) "
                "VALUES (%s, %s, 0, 'chart', '{}'::jsonb)",
                (widget_id, dashboard_id),
            )
            cursor.execute(
                "INSERT INTO public.boards (id, scope, department_id, name) "
                "VALUES (%s, 'department', %s, %s), (%s, 'project', NULL, %s)",
                (board_id, department_id, "Reset board", project_board_id, "Reset project"),
            )
            cursor.execute(
                "INSERT INTO public.board_groups (id, board_id, group_id, level) "
                "VALUES (%s, %s, %s, 'write')",
                (uuid4(), project_board_id, group_id),
            )
            cursor.execute(
                "INSERT INTO public.board_events(id,board_id,author_id,title,all_day,"
                "start_date,end_date,timezone_name) VALUES "
                "(%s,%s,%s,'R',true,current_date,current_date,'UTC')",
                (event_id, board_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.board_event_reminders (id, board_id, event_id, timing) "
                "VALUES (%s, %s, %s, '1d')",
                (uuid4(), board_id, event_id),
            )
            cursor.execute(
                "INSERT INTO public.board_posts "
                "(id, board_id, author_id, title, body, status) "
                "VALUES (%s, %s, %s, 'Reset notice', 'Private notice', 'published')",
                (post_id, board_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.board_post_revisions "
                "(id, post_id, publication_number, publication_key, "
                "content_fingerprint, author_id, title, body, published_at) VALUES "
                "(%s, %s, 1, %s, %s, %s, 'Reset notice', 'Private notice', now())",
                (
                    uuid4(),
                    post_id,
                    uuid4(),
                    publication_content_fingerprint(
                        author_id=member_id,
                        title="Reset notice",
                        body="Private notice",
                    ),
                    member_id,
                ),
            )
            cursor.execute(
                "INSERT INTO public.records (id, module_id) VALUES (%s, %s)",
                (record_id, module_id),
            )
            cursor.execute(
                "INSERT INTO public.reports (id, module_id, name, recipe) "
                "VALUES (%s, %s, %s, '{}'::jsonb)",
                (report_id, module_id, "Reset report"),
            )
            cursor.execute(
                "INSERT INTO public.report_schedules "
                "(id, report_id, enabled, cadence, timezone_name, local_time, next_due_at) "
                "VALUES (%s, %s, true, 'daily', 'UTC', '09:00', now())",
                (uuid4(), report_id),
            )
            cursor.execute(
                "INSERT INTO public.report_runs "
                "(id, report_id, module_id, idempotency_key, recipe_revision, "
                "recipe, headings, row_count, csv_bytes) "
                "VALUES (%s, %s, %s, %s, 1, '{}'::jsonb, '[\"Name\"]'::jsonb, 1, %s)",
                (run_id, report_id, module_id, uuid4(), b"Name\r\nReady\r\n"),
            )
            cursor.execute(
                "INSERT INTO public.report_run_rows "
                "(id, run_id, position, record_id, cells) "
                "VALUES (%s, %s, 0, %s, '[\"Ready\"]'::jsonb)",
                (uuid4(), run_id, record_id),
            )
            cursor.execute(
                "INSERT INTO public.report_run_eligible_users (run_id, user_id) VALUES (%s, %s)",
                (run_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.scheduled_work "
                "(id, kind, report_id, scheduled_for, next_attempt_at, state, "
                "attempt_count, run_id, created_at, updated_at) "
                "VALUES (%s, 'report-run', %s, now(), now(), 'succeeded', 1, %s, now(), now())",
                (work_id, report_id, run_id),
            )
            cursor.execute(
                "INSERT INTO public.in_app_notifications (id, work_id, recipient_id, kind"
                ", subject_type, subject_id) "
                "VALUES (%s, %s, %s, 'report-run', 'report_run', %s)",
                (uuid4(), work_id, member_id, run_id),
            )
        database.commit()
        with pytest.raises(reset.ResetError, match="reset plan changed"):
            execution.apply_reset(
                database,
                plan_before_dashboard,
                execute=True,
                stdin_is_tty=True,
                confirmation=plan_before_dashboard.impact_digest,
                storage=storage,
                auth=auth,
            )
        plan = reset.build_reset_plan(
            database, admin_email, storage_object_keys=storage.list_object_keys()
        )
        for table in (
            "groups group_members group_access board_groups board_event_reminders "
            "board_post_revisions board_posts board_events "
            "dashboard_widgets dashboards reports report_schedules "
            "report_runs report_run_rows report_run_eligible_users "
            "scheduled_work in_app_notifications"
        ).split():
            assert plan.counts[table] == 1
        assert plan.counts["boards"] == 3
        assert plan.counts["fields"] == 1
        assert plan.counts["modules"] == 1
        assert plan.impact_digest != plan_before_dashboard.impact_digest
        for column, original, changed in (
            ("currency", "USD", "EUR"),
            ("week_start", "sunday", "monday"),
            ("business_hours", "10:00–16:00", "08:00–17:00"),
            ("mark", "ACME", "CHANGED"),
        ):
            with database.cursor() as cursor:
                cursor.execute(f"UPDATE public.workspace_profiles SET {column} = %s", (changed,))
            database.commit()
            try:
                changed_plan = reset.build_reset_plan(
                    database, admin_email, storage_object_keys=storage.list_object_keys()
                )
                assert changed_plan.impact_digest != plan.impact_digest, column
                with pytest.raises(reset.ResetError, match="reset plan changed"):
                    execution.apply_reset(
                        database,
                        plan,
                        execute=True,
                        stdin_is_tty=True,
                        confirmation=plan.impact_digest,
                        storage=storage,
                        auth=auth,
                    )
                auth.delete_and_verify_missing.assert_not_called()
            finally:
                database.rollback()
                with database.cursor() as cursor:
                    cursor.execute(
                        f"UPDATE public.workspace_profiles SET {column} = %s", (original,)
                    )
                database.commit()
        restore_company_board = execution._reset_company_board
        for column, value in (
            ("currency", "USD"),
            ("week_start", "sunday"),
            ("business_hours", "10:00–16:00"),
            ("mark", "ACME"),
        ):

            def invalidate_workspace_setting(connection, *, column=column, value=value) -> None:
                restore_company_board(connection)
                with connection.cursor() as cursor:
                    cursor.execute(f"UPDATE public.workspace_profiles SET {column} = %s", (value,))

            with monkeypatch.context() as injected_failure:
                injected_failure.setattr(
                    execution, "_reset_company_board", invalidate_workspace_setting
                )
                auth.list_account_ids.side_effect = ((member_provider_id,), ())
                with pytest.raises(
                    reset.ResetError, match="Provider accounts.*profiles were retained"
                ):
                    execution.apply_reset(
                        database,
                        plan,
                        execute=True,
                        stdin_is_tty=True,
                        confirmation=plan.impact_digest,
                        storage=storage,
                        auth=auth,
                    )
            assert execution._read_workspace(database) == plan.workspace_snapshot
            storage.delete_and_verify_empty.assert_not_called()
        # Restart the mocked provider fixture for the successful attempt.
        auth.reset_mock()
        auth.list_account_ids.side_effect = ((member_provider_id,), ())
        execution.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=plan.impact_digest,
            storage=storage,
            auth=auth,
        )
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.users")
            assert cursor.fetchall() == [(admin_id,)]
            cursor.execute("SELECT count(*) FROM public.identity_sessions")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.identity_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.lifecycle_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.departments")
            assert cursor.fetchone() == (0,)
            for table in ("groups", "group_members", "group_access"):
                cursor.execute(f"SELECT count(*) FROM public.{table}")
                assert cursor.fetchone() == (0,)
            for table in (
                "board_groups board_event_reminders board_post_revisions "
                "board_posts board_events dashboard_widgets "
                "dashboards reports report_schedules report_runs "
                "report_run_rows report_run_eligible_users scheduled_work in_app_notifications"
            ).split():
                cursor.execute(f"SELECT count(*) FROM public.{table}")
                assert cursor.fetchone() == (0,), table
            cursor.execute("SELECT scope, status FROM public.boards")
            assert cursor.fetchall() == [("company", "active")]
            cursor.execute("SELECT logo_file_id FROM public.workspace_profiles")
            assert cursor.fetchone() == (None,)
            cursor.execute(
                "SELECT currency, week_start, business_hours, mark FROM public.workspace_profiles"
            )
            workspace_settings = cursor.fetchone()
            assert workspace_settings == ("PHP", "monday", "09:00–18:00", "RS"), workspace_settings
            cursor.execute(
                "SELECT revision, document->>'schemaVersion', performed_by "
                "FROM public.sandbox_documents"
            )
            assert cursor.fetchone() == (1, "4", None)
            cursor.execute(
                "SELECT sequence, kind, label, performed_by FROM public.sandbox_versions"
            )
            assert cursor.fetchall() == []
            cursor.execute("SELECT count(*) FROM public.sandbox_test_runs")
            assert cursor.fetchone() == (0,)
    assert storage.list_object_keys() == ()
    auth.require_present.assert_called_once_with(admin_provider_id)
    auth.delete_and_verify_missing.assert_called_once_with((member_provider_id,))
