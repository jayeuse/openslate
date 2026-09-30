"""Admission and transaction-order contracts for the local reset command."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from app.core.config.instance import InstanceTarget, InstanceTargetError
from operations import reset_application_data as reset
from operations import reset_execution as execution
from operations import reset_planning


def _plan() -> SimpleNamespace:
    provider_id = uuid4()
    return SimpleNamespace(
        impact_digest="exact",
        sample_email="admin@example.test",
        counts={},
        profiles_to_delete=0,
        inactive_admin_profiles_to_delete=0,
        preserved_admin_id=uuid4(),
        preserved_admin_provider_id=uuid4(),
        provider_subjects=((uuid4(), provider_id),),
        provider_account_ids=(provider_id,),
        profile_snapshot=SimpleNamespace(id=uuid4()),
        credential_snapshot=SimpleNamespace(user_id=uuid4()),
        workspace_snapshot=SimpleNamespace(
            id=uuid4(), invitation_expiry_days=7, guest_duration_days=30
        ),
        storage_object_keys=("objects/aa/object",),
        alembic_head="head",
    )


def _auth(plan: SimpleNamespace) -> Mock:
    auth = Mock()
    auth.list_account_ids.side_effect = [plan.provider_account_ids, ()]
    return auth


def test_reset_impact_digest_includes_the_invitation_settings() -> None:
    plan = _plan()
    plan.impact_digest = reset_planning._impact_digest(plan)

    changed = SimpleNamespace(**vars(plan))
    changed.workspace_snapshot = SimpleNamespace(
        id=plan.workspace_snapshot.id, invitation_expiry_days=14, guest_duration_days=30
    )

    assert reset_planning._impact_digest(changed) != plan.impact_digest


def test_reset_impact_digest_freezes_provider_subject_mapping() -> None:
    plan = _plan()
    changed = SimpleNamespace(**vars(plan))
    app_id, _ = plan.provider_subjects[0]
    changed.provider_subjects = ((app_id, uuid4()),)

    assert reset_planning._impact_digest(changed) != reset_planning._impact_digest(plan)


def test_reset_impact_digest_freezes_orphan_provider_accounts() -> None:
    plan = _plan()
    plan.provider_account_ids = (plan.provider_subjects[0][1],)
    changed = SimpleNamespace(**vars(plan))
    changed.provider_account_ids = tuple(sorted((*plan.provider_account_ids, uuid4()), key=str))

    assert reset_planning._impact_digest(changed) != reset_planning._impact_digest(plan)


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
    events: list[str] = []
    database.commit.side_effect = lambda: events.append("commit")

    def storage_failure(_: object) -> None:
        events.append("storage_cleanup")
        raise RuntimeError("unavailable")

    storage.delete_and_verify_empty.side_effect = storage_failure
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
            auth=_auth(plan),
            build_plan_fn=lambda *_, **__: plan,
        )

    assert events.index("commit") < events.index("storage_cleanup")
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
    company_board = next(
        index
        for index, statement in enumerate(statements)
        if statement.startswith("INSERT INTO public.boards")
    )
    assert statements.index("DELETE FROM public.boards") < company_board
    assert "'company'" in statements[company_board]


def test_provider_accounts_are_deleted_before_application_profiles(monkeypatch) -> None:
    plan = _plan()
    orphan_id = uuid4()
    plan.provider_account_ids = tuple(sorted((*plan.provider_account_ids, orphan_id), key=str))
    events: list[str] = []
    database = Mock()
    storage = Mock()

    def list_storage() -> tuple[str, ...]:
        events.append("storage_inventory")
        return plan.storage_object_keys

    storage.list_object_keys.side_effect = list_storage
    auth = _auth(plan)
    auth.require_present.side_effect = lambda _: events.append("admin_checked")
    auth.delete_and_verify_missing.side_effect = lambda _: events.append("provider_deleted")
    monkeypatch.setattr(execution, "_begin_transaction", lambda _: None)
    monkeypatch.setattr(
        execution, "_execute", lambda _, statement, *args: events.append(statement)
    )
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)
    monkeypatch.setattr(execution, "_validate_postconditions", lambda *_args, **_kwargs: None)

    execution.apply_reset(
        database, plan, execute=True, stdin_is_tty=True, confirmation=plan.impact_digest,
        storage=storage, auth=auth, build_plan_fn=lambda *_, **__: plan,
    )

    auth.require_present.assert_called_once_with(plan.preserved_admin_provider_id)
    auth.delete_and_verify_missing.assert_called_once_with(
        plan.provider_account_ids
    )
    assert events.index("provider_deleted") < events.index(
        "DELETE FROM public.users WHERE id <> %s"
    )
    assert max(index for index, event in enumerate(events) if event == "storage_inventory") < (
        events.index(reset._LOCK_APPLICATION_STATEMENT)
    )


def test_changed_auth_inventory_refuses_reset_before_any_provider_deletion(monkeypatch) -> None:
    plan = _plan()
    changed = SimpleNamespace(**vars(plan))
    changed.impact_digest = "changed"
    database = Mock()
    storage = Mock(list_object_keys=Mock(return_value=plan.storage_object_keys))
    auth = Mock(list_account_ids=Mock(return_value=tuple(sorted(
        (*plan.provider_account_ids, uuid4()), key=str
    ))))
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)

    with pytest.raises(reset.ResetError, match="reset plan changed"):
        execution.apply_reset(
            database, plan, execute=True, stdin_is_tty=True,
            confirmation=plan.impact_digest, storage=storage, auth=auth,
            build_plan_fn=lambda *_, **kwargs: (
                changed if kwargs["provider_account_ids"] != plan.provider_account_ids else plan
            ),
        )

    auth.delete_and_verify_missing.assert_not_called()
    database.rollback.assert_called()


def test_provider_failure_keeps_application_profiles_for_safe_retry(monkeypatch) -> None:
    plan = _plan()
    database = Mock()
    storage = Mock(list_object_keys=Mock(return_value=plan.storage_object_keys))
    auth = _auth(plan)
    auth.delete_and_verify_missing.side_effect = RuntimeError("provider error")
    statements: list[str] = []
    monkeypatch.setattr(execution, "_begin_transaction", lambda _: None)
    monkeypatch.setattr(
        execution, "_execute", lambda _, statement, *args: statements.append(statement)
    )
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)

    with pytest.raises(reset.ResetError, match="Provider account cleanup is incomplete"):
        execution.apply_reset(
            database, plan, execute=True, stdin_is_tty=True,
            confirmation=plan.impact_digest, storage=storage, auth=auth,
            build_plan_fn=lambda *_, **__: plan,
        )

    assert not any(statement.startswith("DELETE FROM public.users") for statement in statements)
    storage.delete_and_verify_empty.assert_not_called()


def test_database_failure_after_provider_cleanup_reports_partial_reset(monkeypatch) -> None:
    plan = _plan()
    database = Mock()
    storage = Mock(list_object_keys=Mock(return_value=plan.storage_object_keys))
    auth = _auth(plan)
    monkeypatch.setattr(execution, "_begin_transaction", lambda _: None)

    def execute(_, statement, *_args):
        if statement.startswith("UPDATE public.workspace_profiles"):
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(execution, "_execute", execute)
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)

    with pytest.raises(reset.ResetError, match="Provider accounts.*profiles were retained"):
        execution.apply_reset(
            database, plan, execute=True, stdin_is_tty=True,
            confirmation=plan.impact_digest, storage=storage, auth=auth,
            build_plan_fn=lambda *_, **__: plan,
        )

    auth.delete_and_verify_missing.assert_called_once()
    database.rollback.assert_called()
    storage.delete_and_verify_empty.assert_not_called()


def test_plan_drift_after_auth_cleanup_keeps_profiles_and_reports_partial(monkeypatch) -> None:
    plan = _plan()
    changed = SimpleNamespace(**vars(plan))
    changed.impact_digest = "changed"
    database = Mock()
    storage = Mock(list_object_keys=Mock(return_value=plan.storage_object_keys))
    auth = _auth(plan)
    statements: list[str] = []
    monkeypatch.setattr(execution, "_begin_transaction", lambda _: None)
    monkeypatch.setattr(
        execution, "_execute", lambda _, statement, *args: statements.append(statement)
    )
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)
    plans = iter((plan, changed))

    with pytest.raises(reset.ResetError, match="Provider accounts.*profiles were retained"):
        execution.apply_reset(
            database, plan, execute=True, stdin_is_tty=True,
            confirmation=plan.impact_digest, storage=storage, auth=auth,
            build_plan_fn=lambda *_, **__: next(plans),
        )

    assert not any(statement.startswith("DELETE FROM public.users") for statement in statements)
    storage.delete_and_verify_empty.assert_not_called()


def test_ambiguous_database_commit_does_not_claim_profiles_were_retained(monkeypatch) -> None:
    plan = _plan()
    database = Mock()
    database.commit.side_effect = [None, None, RuntimeError("connection lost")]
    storage = Mock(list_object_keys=Mock(return_value=plan.storage_object_keys))
    auth = _auth(plan)
    monkeypatch.setattr(execution, "_begin_transaction", lambda _: None)
    monkeypatch.setattr(execution, "_execute", lambda *_args: None)
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)
    monkeypatch.setattr(execution, "_validate_postconditions", lambda *_args, **_kwargs: None)

    with pytest.raises(reset.ResetError, match="database commit outcome is uncertain"):
        execution.apply_reset(
            database, plan, execute=True, stdin_is_tty=True,
            confirmation=plan.impact_digest, storage=storage, auth=auth,
            build_plan_fn=lambda *_, **__: plan,
        )

    auth.delete_and_verify_missing.assert_called_once()
    storage.delete_and_verify_empty.assert_not_called()


def test_reset_reads_the_canonical_root_environment_and_checks_its_target(
    monkeypatch, tmp_path
) -> None:
    url = "postgresql+psycopg://openslate_owner:secret@127.0.0.1:55432/postgres"
    target = InstanceTarget(
        instance_id="openslate-supabase-a1b2c3d4",
        host="127.0.0.1",
        port=55432,
        database="postgres",
        attestation_path=tmp_path / "instance.json",
    )
    values = {
        "ENVIRONMENT": "development",
        "MIGRATION_DATABASE_URL": url,
        "ADMIN_EMAIL": "admin@example.test",
        "SUPABASE_URL": "http://127.0.0.1:58000",
        "SUPABASE_SECRET_KEY": "fake-secret",
        "SUPABASE_TIMEOUT_SECONDS": "2",
        "BACKEND_BIND_HOST": "127.0.0.1",
        "BACKEND_PORT": "8000",
    }
    connection = Mock()
    storage = Mock(list_object_keys=Mock(return_value=()))
    seen_paths = []
    monkeypatch.setattr(reset, "environment_inputs", lambda path: seen_paths.append(path) or values)
    monkeypatch.setattr(reset, "instance_target_for_process", lambda *_args: target)
    monkeypatch.setattr(reset, "connect", lambda _url: connection)
    monkeypatch.setattr(reset, "ResetStorage", lambda *_args: storage)
    monkeypatch.setattr(
        reset, "ResetAuth", lambda *_args: Mock(list_account_ids=Mock(return_value=()))
    )
    monkeypatch.setattr(reset, "assert_provider_instance", Mock())
    monkeypatch.setattr(
        reset, "build_reset_plan",
        lambda *_args, **_kwargs: SimpleNamespace(
            preserved_admin_provider_id=uuid4(), sample_email="admin@example.test"
        ),
    )
    monkeypatch.setattr(reset, "_print_plan", lambda _plan: None)
    monkeypatch.setattr(reset, "assert_psycopg_target", Mock())

    reset.main([])

    assert seen_paths == [reset.DOTENV_PATH]
    reset.assert_psycopg_target.assert_called_once_with(
        connection, target, expected_user="openslate_owner"
    )
    connection.close.assert_called_once()


def test_reset_refuses_unbound_provider_before_privileged_calls(monkeypatch) -> None:
    values = {
        "ENVIRONMENT": "development",
        "MIGRATION_DATABASE_URL": (
            "postgresql+psycopg://openslate_owner:secret@127.0.0.1:55432/postgres"
        ),
        "ADMIN_EMAIL": "admin@example.test",
        "BACKEND_BIND_HOST": "127.0.0.1",
        "BACKEND_PORT": "8000",
        "SUPABASE_URL": "http://127.0.0.1:58000",
        "SUPABASE_SECRET_KEY": "fake-secret",
        "SUPABASE_TIMEOUT_SECONDS": "2",
    }
    connect = Mock()
    guard = Mock(side_effect=InstanceTargetError("provider mismatch"))
    monkeypatch.setattr(reset, "environment_inputs", lambda _: values)
    monkeypatch.setattr(reset, "instance_target_for_process", lambda *_: Mock())
    monkeypatch.setattr(reset, "validate_local_database_url", lambda *_a, **_k: None)
    monkeypatch.setattr(reset, "assert_provider_instance", guard, raising=False)
    monkeypatch.setattr(reset, "connect", connect)

    with pytest.raises(SystemExit, match="provider mismatch"):
        reset.main([])

    guard.assert_called_once()
    connect.assert_not_called()


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
