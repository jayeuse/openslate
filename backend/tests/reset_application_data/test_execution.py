"""Admission and transaction-order contracts for the local reset command."""

from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from psycopg import connect
from sqlalchemy.orm import Session

from app.core.config.instance import InstanceTarget
from app.core.security.passwords import hash_password
from app.systems.access.identity.service import authenticate_password
from app.systems.boards.announcement_models import publication_content_fingerprint
from operations import reset_application_data as reset
from operations import reset_execution as execution
from tests.conftest import _guard_integration_database, guarded_create_engine


def _plan() -> SimpleNamespace:
    return SimpleNamespace(
        impact_digest="exact",
        sample_email="admin@example.test",
        preserved_admin_id=uuid4(),
        preserved_admin_role_id=uuid4(),
        preserved_member_role_id=uuid4(),
        workspace_snapshot=SimpleNamespace(id=uuid4()),
        storage_object_keys=("objects/aa/object",),
    )


def test_reset_defaults_to_dry_run_without_database_work() -> None:
    database = Mock()
    assert reset._parser().parse_args([]).execute is False
    reset.apply_reset(database, _plan())
    assert database.mock_calls == []


@pytest.mark.parametrize("tty,confirmation", [(False, "exact"), (True, None), (True, "wrong")])
def test_reset_requires_interactive_exact_confirmation(tty, confirmation) -> None:
    database = Mock()
    with pytest.raises(reset.ResetError):
        reset.apply_reset(
            database, _plan(), execute=True, stdin_is_tty=tty, confirmation=confirmation
        )
    assert database.mock_calls == []


def test_reset_execute_requires_the_api_writer_gate(monkeypatch) -> None:
    database = Mock()
    monkeypatch.setattr(
        reset,
        "require_api_stopped",
        lambda *_: (_ for _ in ()).throw(reset.ResetError("API server running")),
    )
    with pytest.raises(reset.ResetError, match="API server running"):
        reset.apply_reset(
            database,
            _plan(),
            execute=True,
            stdin_is_tty=True,
            confirmation="exact",
            storage=Mock(),
            backend_host="127.0.0.1",
            backend_port="8000",
        )
    assert database.mock_calls == []


def test_database_commit_precedes_private_storage_cleanup(monkeypatch) -> None:
    plan = _plan()
    database = Mock()
    storage = Mock(list_object_keys=Mock(return_value=plan.storage_object_keys))
    storage.delete_and_verify_empty.side_effect = RuntimeError("unavailable")
    statements: list[str] = []
    monkeypatch.setattr(execution, "_begin_transaction", lambda _: None)
    monkeypatch.setattr(
        execution, "_execute", lambda _, statement, *args: statements.append(statement)
    )
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)
    monkeypatch.setattr(execution, "_validate_postconditions", lambda *_args, **_kwargs: None)
    with pytest.raises(execution.ResetError, match="reset committed but private storage"):
        execution.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=plan.impact_digest,
            storage=storage,
            build_plan_fn=lambda *_, **__: plan,
        )

    assert database.commit.call_count == 1
    database.rollback.assert_not_called()
    assert statements.index("DELETE FROM public.identity_sessions") < statements.index(
        "DELETE FROM public.users WHERE id <> %s"
    )
    assert statements.index("DELETE FROM public.lifecycle_rate_limit_buckets") < statements.index(
        "DELETE FROM public.users WHERE id <> %s"
    )
    assert statements.index("DELETE FROM public.files") < statements.index(
        "DELETE FROM public.records"
    )
    assert statements.index("DELETE FROM public.sandbox_test_runs") < statements.index(
        "DELETE FROM public.sandbox_versions"
    )
    assert any(statement.startswith("UPDATE public.sandbox_documents") for statement in statements)
    assert not any(
        statement.startswith("INSERT INTO public.sandbox_versions") for statement in statements
    )


def test_reset_reads_the_canonical_root_environment_and_checks_its_target(
    monkeypatch, tmp_path
) -> None:
    url = "postgresql+psycopg://openslate_owner:secret@127.0.0.1:55322/openslate_boards"
    target = InstanceTarget(
        instance_id="openslate-boards-a1b2c3d4",
        host="127.0.0.1",
        port=55322,
        database="openslate_boards",
        attestation_path=tmp_path / "instance.json",
    )
    values = {
        "ENVIRONMENT": "development",
        "MIGRATION_DATABASE_URL": url,
        "ADMIN_EMAIL": "admin@example.test",
        "FILES_STORAGE_ROOT": str(tmp_path),
        "BACKEND_BIND_HOST": "127.0.0.1",
        "BACKEND_PORT": "8000",
    }
    connection = Mock()
    storage = Mock(list_object_keys=Mock(return_value=()))
    seen_paths = []
    monkeypatch.setattr(reset, "environment_inputs", lambda path: seen_paths.append(path) or values)
    monkeypatch.setattr(reset, "instance_target_for_process", lambda *_args: target)
    monkeypatch.setattr(reset, "connect", lambda _url: connection)
    monkeypatch.setattr(reset, "ResetStorage", lambda _root: storage)
    monkeypatch.setattr(reset, "build_reset_plan", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(reset, "_print_plan", lambda _plan: None)
    monkeypatch.setattr(reset, "assert_psycopg_target", Mock())

    reset.main([])

    assert seen_paths == [reset.DOTENV_PATH]
    reset.assert_psycopg_target.assert_called_once_with(
        connection, target, expected_user="openslate_owner"
    )
    connection.close.assert_called_once()


@pytest.mark.parametrize("environment", ["production", "prod"])
def test_reset_rejects_production_before_target_resolution_or_connection(
    monkeypatch, tmp_path, environment
) -> None:
    values = {
        "ENVIRONMENT": environment,
        "MIGRATION_DATABASE_URL": (
            "postgresql+psycopg://openslate_owner:secret@db.example.test:5432/openslate"
        ),
        "ADMIN_EMAIL": "admin@example.test",
        "FILES_STORAGE_ROOT": str(tmp_path),
        "BACKEND_BIND_HOST": "127.0.0.1",
        "BACKEND_PORT": "8000",
    }
    target = Mock()
    connection = Mock()
    monkeypatch.setattr(reset, "environment_inputs", lambda _path: values)
    monkeypatch.setattr(reset, "instance_target_for_process", target)
    monkeypatch.setattr(reset, "connect", connection)

    with pytest.raises(SystemExit, match="local development or disposable tests"):
        reset.main([])

    target.assert_not_called()
    connection.assert_not_called()


@pytest.mark.integration
def test_reset_removes_board_report_dashboard_hierarchy_and_preserves_administrator(
    tmp_path, request, monkeypatch
) -> None:
    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    runtime_url = os.environ.get("TEST_DATABASE_URL")
    owner_url = os.environ.get("MIGRATION_DATABASE_URL")
    if runtime_url is None or owner_url is None:
        raise RuntimeError("Reset integration requires the disposable PostgreSQL runner")
    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    database_url = owner_url.replace("postgresql+psycopg://", "postgresql://", 1)
    root = tmp_path / "private-files"
    (root / "objects" / "aa").mkdir(parents=True)
    (root / "quarantine" / "bb").mkdir(parents=True)
    (root / "objects" / "aa" / "ready").write_bytes(b"ready")
    (root / "quarantine" / "bb" / "pending").write_bytes(b"pending")
    storage = reset.ResetStorage(root)
    admin_id, member_id, session_id = uuid4(), uuid4(), uuid4()
    admin_action_id, member_action_id = uuid4(), uuid4()
    admin_email = f"reset-admin-{admin_id}@example.test"
    admin_password = "Correct Horse Battery Staple 2026!"

    def cleanup() -> None:
        _guard_integration_database(runtime_url)
        _guard_integration_database(owner_url)
        with connect(database_url) as database:
            with database.cursor() as cursor:
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
                "INSERT INTO public.users (id, email, username, status, role_id) "
                "VALUES (%s, %s, %s, 'active', %s), (%s, %s, %s, 'active', %s)",
                (
                    admin_id,
                    admin_email,
                    f"reset_admin_{admin_id.hex[:12]}",
                    admin_role_id,
                    member_id,
                    f"reset-member-{member_id}@example.test",
                    f"reset_member_{member_id.hex[:12]}",
                    member_role_id,
                ),
            )
            cursor.execute(
                "INSERT INTO public.identity_credentials "
                "(user_id, password_digest, must_change_password, password_changed_at) "
                "VALUES (%s, %s, false, now()), (%s, 'delete', false, now())",
                (admin_id, hash_password(admin_password), member_id),
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
                "INSERT INTO public.identity_action_tokens "
                "(id, user_id, purpose, token_digest, created_at, expires_at) "
                "VALUES (%s, %s, 'recovery', %s, now(), now() + interval '1 day'), "
                "(%s, %s, 'invitation', %s, now(), now() + interval '1 day')",
                (admin_action_id, admin_id, "e" * 64, member_action_id, member_id, "f" * 64),
            )
            cursor.execute(
                "INSERT INTO public.identity_delivery_outbox "
                "(id, action_token_id, recipient, purpose, state, attempt_count, next_attempt_at, "
                "created_at, updated_at) "
                "VALUES (%s, %s, %s, 'recovery', 'pending', 0, now(), now(), now()), "
                "(%s, %s, %s, 'invitation', 'pending', 0, now(), now(), now())",
                (
                    uuid4(),
                    admin_action_id,
                    admin_email,
                    uuid4(),
                    member_action_id,
                    "member@example.test",
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
            department_id, module_id = uuid4(), uuid4()
            cursor.execute(
                "INSERT INTO public.departments (id, department_name) VALUES (%s, %s)",
                (department_id, f"reset-{admin_id}"),
            )
            cursor.execute(
                "INSERT INTO public.user_department_memberships (id, user_id, department_id) "
                "VALUES (%s, %s, %s)",
                (uuid4(), member_id, department_id),
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
            )
        plan = reset.build_reset_plan(
            database, admin_email, storage_object_keys=storage.list_object_keys()
        )
        for table in (
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
        )
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.users")
            assert cursor.fetchall() == [(admin_id,)]
            cursor.execute("SELECT user_id FROM public.identity_credentials")
            assert cursor.fetchall() == [(admin_id,)]
            cursor.execute("SELECT count(*) FROM public.identity_sessions")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.identity_action_tokens")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.identity_delivery_outbox")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.identity_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.lifecycle_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.departments")
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
            assert cursor.fetchone() == (1, "2", None)
            cursor.execute(
                "SELECT sequence, kind, label, performed_by FROM public.sandbox_versions"
            )
            assert cursor.fetchall() == []
            cursor.execute("SELECT count(*) FROM public.sandbox_test_runs")
            assert cursor.fetchone() == (0,)
    assert storage.list_object_keys() == ()
    engine = guarded_create_engine(runtime_url)
    try:
        with Session(engine) as db:
            assert authenticate_password(db, admin_email, admin_password).id == admin_id
    finally:
        engine.dispose()
