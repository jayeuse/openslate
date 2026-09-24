"""Admission and transaction-order contracts for the local reset command."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from app.core.config.instance import InstanceTarget
from operations import reset_application_data as reset
from operations import reset_execution as execution
from operations import reset_planning


def _plan() -> SimpleNamespace:
    return SimpleNamespace(
        impact_digest="exact",
        sample_email="admin@example.test",
        counts={},
        profiles_to_delete=0,
        inactive_admin_profiles_to_delete=0,
        preserved_admin_id=uuid4(),
        preserved_admin_role_id=uuid4(),
        preserved_member_role_id=uuid4(),
        profile_snapshot=SimpleNamespace(id=uuid4()),
        credential_snapshot=SimpleNamespace(user_id=uuid4()),
        admin_role_snapshot=SimpleNamespace(id=uuid4()),
        member_role_snapshot=SimpleNamespace(id=uuid4()),
        workspace_snapshot=SimpleNamespace(id=uuid4()),
        access_policy_defaults_snapshot=SimpleNamespace(id=uuid4(), revision=1),
        access_policy_version_snapshot=SimpleNamespace(id=uuid4(), revision=1),
        storage_object_keys=("objects/aa/object",),
        alembic_head="head",
    )


def test_reset_impact_digest_includes_access_singleton_snapshots() -> None:
    plan = _plan()
    plan.impact_digest = reset_planning._impact_digest(plan)

    changed_defaults = SimpleNamespace(**vars(plan))
    changed_defaults.access_policy_defaults_snapshot = SimpleNamespace(
        id=plan.access_policy_defaults_snapshot.id, revision=2
    )
    changed_version = SimpleNamespace(**vars(plan))
    changed_version.access_policy_version_snapshot = SimpleNamespace(
        id=plan.access_policy_version_snapshot.id, revision=2
    )

    assert reset_planning._impact_digest(changed_defaults) != plan.impact_digest
    assert reset_planning._impact_digest(changed_version) != plan.impact_digest


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
