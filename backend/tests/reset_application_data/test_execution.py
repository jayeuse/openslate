"""Admission and transaction-order contracts for the local reset command."""

from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from psycopg import connect
from sqlalchemy.orm import Session

from app.core.security.passwords import hash_password
from app.systems.access.identity.service import authenticate_password
from operations import reset_application_data as reset
from operations import reset_execution as execution
from operations import reset_planning
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


def test_reset_rejects_remote_runtime_or_missing_owner_environment() -> None:
    local = "postgresql://openslate_owner:secret@127.0.0.1:54322/openslate"
    assert reset.validate_local_database_url(local) is None
    for url in (
        local.replace("127.0.0.1", "remote.example"),
        local.replace("openslate_owner", "openslate_runtime"),
        local.replace("54322", "55322"),
    ):
        with pytest.raises(reset.ResetError):
            reset.validate_local_database_url(url)
    with pytest.raises(reset.ResetError):
        reset.required_environment({"DATABASE_URL": local, "ADMIN_EMAIL": "admin@example.test"})
    with pytest.raises(reset.ResetError):
        reset.required_storage_environment(
            {"BACKEND_BIND_HOST": "127.0.0.1", "BACKEND_PORT": "8000"}
        )


def test_reset_derives_the_single_current_alembic_head() -> None:
    config = Config()
    config.set_main_option("script_location", "migrations")
    heads = ScriptDirectory.from_config(config).get_heads()
    assert len(heads) == 1
    assert reset_planning._expected_alembic_head() == heads[0]


@pytest.mark.integration
def test_reset_removes_local_identity_rows_and_preserves_the_administrator(
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
            cursor.execute(
                "INSERT INTO public.departments (id, department_name) VALUES (%s, %s)",
                (uuid4(), f"reset-{admin_id}"),
            )
            file_id = uuid4()
            cursor.execute(
                "INSERT INTO public.files "
                "(id, purpose, creator_id, filename, expected_size, object_key, state) "
                "VALUES (%s, 'workspace_logo', %s, 'reset.png', 1, %s, 'awaiting_upload')",
                (file_id, admin_id, uuid4().hex),
            )
            cursor.execute("UPDATE public.workspace_profiles SET logo_file_id = %s", (file_id,))
        database.commit()
        plan = reset.build_reset_plan(
            database, admin_email, storage_object_keys=storage.list_object_keys()
        )
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
            cursor.execute("SELECT logo_file_id FROM public.workspace_profiles")
            assert cursor.fetchone() == (None,)
    assert storage.list_object_keys() == ()
    engine = guarded_create_engine(runtime_url)
    try:
        with Session(engine) as db:
            assert authenticate_password(db, admin_email, admin_password).id == admin_id
    finally:
        engine.dispose()
