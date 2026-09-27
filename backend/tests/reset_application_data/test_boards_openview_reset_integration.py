"""Guarded PostgreSQL coverage for combined Boards, OpenView, and Access reset."""

from __future__ import annotations

import os
from unittest.mock import Mock
from uuid import uuid4

import pytest
from psycopg import connect

from app.systems.boards.announcement_models import publication_content_fingerprint
from operations import reset_application_data as reset
from operations import reset_execution as execution
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
    department_id = uuid4()
    admin_email = f"reset-admin-{admin_id}@example.test"

    def cleanup() -> None:
        _guard_integration_database(runtime_url)
        _guard_integration_database(owner_url)
        with connect(database_url) as database:
            with database.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM public.user_departments WHERE department_id = %s",
                    (department_id,),
                )
                cursor.execute(
                    "DELETE FROM public.users WHERE id IN (%s, %s)", (admin_id, member_id)
                )
            database.commit()

    request.addfinalizer(cleanup)
    with connect(database_url) as database:
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.roles WHERE role = 'admin'")
            (admin_role_id,) = cursor.fetchone()
            cursor.execute("SELECT id FROM public.roles WHERE role = 'member'")
            (member_role_id,) = cursor.fetchone()
            cursor.execute(
                "INSERT INTO public.users (id, email, supabase_user_id, username, status, role_id) "
                "VALUES (%s, %s, %s, %s, 'active', %s), "
                "(%s, %s, %s, %s, 'active', %s)",
                (
                    admin_id,
                    admin_email,
                    admin_provider_id,
                    f"reset_admin_{admin_id.hex[:12]}",
                    admin_role_id,
                    member_id,
                    f"reset-member-{member_id}@example.test",
                    member_provider_id,
                    f"reset_member_{member_id.hex[:12]}",
                    member_role_id,
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
            module_id = uuid4()
            cursor.execute(
                "INSERT INTO public.departments (id, department_name) VALUES (%s, %s)",
                (department_id, f"reset-{admin_id}"),
            )
            cursor.execute(
                "INSERT INTO public.user_departments "
                "(id, user_id, department_id, is_primary, performed_by) "
                "VALUES (%s, %s, %s, true, %s)",
                (uuid4(), member_id, department_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.modules (id, department_id, module_name) VALUES (%s, %s, %s)",
                (module_id, department_id, f"reset-module-{module_id.hex[:12]}"),
            )
            file_id = uuid4()
            cursor.execute(
                "INSERT INTO public.files "
                "(id, purpose, creator_id, filename, expected_size, object_key, state) "
                "VALUES (%s, 'workspace_logo', %s, 'reset.png', 1, %s, 'awaiting_upload')",
                (file_id, admin_id, uuid4().hex),
            )
            cursor.execute("UPDATE public.workspace_profiles SET logo_file_id = %s", (file_id,))
            plan_before_dashboard = reset.build_reset_plan(
                database, admin_email, storage_object_keys=storage.list_object_keys()
            )
            dashboard_id, widget_id = uuid4(), uuid4()
            cursor.execute(
                "INSERT INTO public.dashboards (id, owner_id, name) VALUES (%s, %s, %s)",
                (dashboard_id, member_id, f"reset-dashboard-{dashboard_id.hex[:12]}"),
            )
            cursor.execute(
                "INSERT INTO public.dashboard_widgets "
                "(id, dashboard_id, position, widget_type, config) "
                "VALUES (%s, %s, 0, 'chart', '{}'::jsonb)",
                (widget_id, dashboard_id),
            )
            board_id, record_id = uuid4(), uuid4()
            cursor.execute(
                "INSERT INTO public.boards (id, owner_id, department_id, name) "
                "VALUES (%s, %s, %s, %s)",
                (board_id, member_id, department_id, "Reset board"),
            )
            cursor.execute(
                "INSERT INTO public.board_events(id,board_id,author_id,title,all_day,"
                "start_date,end_date,timezone_name,audience_kind) VALUES "
                "(%s,%s,%s,'R',true,current_date,current_date,'UTC','author')",
                (uuid4(), board_id, member_id),
            )
            announcement_id = uuid4()
            cursor.execute(
                "INSERT INTO public.board_announcements "
                "(id, board_id, author_id, title, body, status, audience_kind) "
                "VALUES (%s, %s, %s, 'Reset notice', 'Private notice', 'published', 'author')",
                (announcement_id, board_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.board_announcement_revisions "
                "(id, announcement_id, publication_number, publication_key, "
                "content_fingerprint, author_id, title, body, "
                "audience_kind, published_at) VALUES "
                "(%s, %s, 1, %s, %s, %s, 'Reset notice', 'Private notice', 'author', now())",
                (
                    uuid4(),
                    announcement_id,
                    uuid4(),
                    publication_content_fingerprint(
                        author_id=member_id,
                        title="Reset notice",
                        body="Private notice",
                        audience_kind="author",
                    ),
                    member_id,
                ),
            )
            cursor.execute(
                "INSERT INTO public.board_announcement_personal_states "
                "(id, user_id, announcement_id, read, bookmarked) "
                "VALUES (%s, %s, %s, true, true)",
                (uuid4(), member_id, announcement_id),
            )
            for table in ("board_favorites", "board_homes"):
                cursor.execute(
                    f"INSERT INTO public.{table} (id, user_id, board_id) VALUES (%s, %s, %s)",
                    (uuid4(), member_id, board_id),
                )
            cursor.execute(
                "INSERT INTO public.board_templates (id, name, bundle) VALUES (%s, %s, %s::jsonb)",
                (
                    uuid4(),
                    "Reset template",
                    '{"kind":"openslate-board","version":2,"configuration":'
                    '{"name":"Reset","description":null,"department_name":null,'
                    '"default_section":"overview","widgets":[]}}',
                ),
            )
            cursor.execute(
                "INSERT INTO public.records (id, module_id) VALUES (%s, %s)",
                (record_id, module_id),
            )
            cursor.execute(
                "INSERT INTO public.board_record_placements (id, board_id, record_id) "
                "VALUES (%s, %s, %s)",
                (uuid4(), board_id, record_id),
            )
            cursor.execute(
                "INSERT INTO public.dashboard_defaults (id, user_id, dashboard_id) "
                "VALUES (%s, %s, %s)",
                (uuid4(), member_id, dashboard_id),
            )
            report_id, run_id = uuid4(), uuid4()
            cursor.execute(
                "INSERT INTO public.reports (id, owner_id, module_id, name, recipe) "
                "VALUES (%s, %s, %s, %s, '{}'::jsonb)",
                (report_id, member_id, module_id, "Reset report"),
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
            work_id = uuid4()
            cursor.execute(
                "INSERT INTO public.scheduled_work "
                "(id, kind, report_id, scheduled_for, next_attempt_at, state, "
                "attempt_count, run_id, created_at, updated_at) "
                "VALUES (%s, 'report-run', %s, now(), now(), 'succeeded', 1, %s, now(), now())",
                (work_id, report_id, run_id),
            )
            cursor.execute(
                "INSERT INTO public.in_app_notifications (id, work_id, recipient_id) "
                "VALUES (%s, %s, %s)",
                (uuid4(), work_id, member_id),
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
            "user_departments "
            "board_announcement_personal_states board_announcement_revisions "
            "board_announcements board_events "
            "board_favorites board_homes boards board_record_placements board_templates "
            "dashboard_defaults dashboard_widgets dashboards reports report_schedules "
            "report_runs report_run_rows report_run_eligible_users "
            "scheduled_work in_app_notifications"
        ).split():
            assert plan.counts[table] == 1
        assert plan.impact_digest != plan_before_dashboard.impact_digest
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
            cursor.execute("SELECT count(*) FROM public.user_departments")
            assert cursor.fetchone() == (0,)
            for table in (
                "board_announcement_personal_states board_announcement_revisions "
                "board_announcements board_events "
                "board_record_placements boards board_templates dashboard_widgets "
                "dashboard_defaults dashboards reports report_schedules report_runs "
                "report_run_rows report_run_eligible_users scheduled_work in_app_notifications"
            ).split():
                cursor.execute(f"SELECT count(*) FROM public.{table}")
                assert cursor.fetchone() == (0,), table
            cursor.execute("SELECT logo_file_id FROM public.workspace_profiles")
            assert cursor.fetchone() == (None,)
            cursor.execute(
                "SELECT revision, document->>'schemaVersion', performed_by "
                "FROM public.sandbox_documents"
            )
            assert cursor.fetchone() == (1, "3", None)
            cursor.execute(
                "SELECT sequence, kind, label, performed_by FROM public.sandbox_versions"
            )
            assert cursor.fetchall() == []
            cursor.execute("SELECT count(*) FROM public.sandbox_test_runs")
            assert cursor.fetchone() == (0,)
    assert storage.list_object_keys() == ()
    auth.require_present.assert_called_once_with(admin_provider_id)
    auth.delete_and_verify_missing.assert_called_once_with((member_provider_id,))
