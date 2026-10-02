"""Writer-quiescence admission for the guarded reset utility."""

import socket
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.engine import make_url

from app.core.config.instance import InstanceTarget
from operations import reset_application_data as reset
from operations import reset_execution as execution
from operations.reset_models import ResetError
from operations.reset_storage import require_api_stopped
from tests.reset_application_data.test_execution import _plan


def test_api_writer_admission_is_cross_platform_and_fail_closed(monkeypatch) -> None:
    def refused(*_args, **_kwargs):
        raise ConnectionRefusedError

    monkeypatch.setattr(socket, "create_connection", refused)
    assert require_api_stopped("127.0.0.1", "8000") is None
    assert require_api_stopped("::1", "8000") is None

    class Connected:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    monkeypatch.setattr(socket, "create_connection", lambda *_args, **_kwargs: Connected())
    with pytest.raises(ResetError, match="must be stopped"):
        require_api_stopped("::", "8000")
    with pytest.raises(ResetError, match="valid"):
        require_api_stopped("127.0.0.1", "invalid")
    with pytest.raises(ResetError, match="not supported"):
        require_api_stopped("192.168.1.10", "8000")


@pytest.fixture
def development_reset_cli(monkeypatch, tmp_path):
    plan = _plan()
    values = {
        "ENVIRONMENT": "development",
        "MIGRATION_DATABASE_URL": (
            "postgresql+psycopg://openslate_owner:fixture-only@127.0.0.1:55432/postgres"
        ),
        "ADMIN_EMAIL": plan.sample_email,
        "SUPABASE_URL": "http://127.0.0.1:58000",
        "SUPABASE_SECRET_KEY": "fixture-only",
        "BACKEND_BIND_HOST": "127.0.0.1",
        "BACKEND_PORT": "8000",
    }
    database = Mock()
    provider_ids = set(plan.provider_account_ids)
    auth = Mock()
    auth.list_account_ids.side_effect = lambda *_: tuple(sorted(provider_ids, key=str))
    auth.delete_and_verify_missing.side_effect = provider_ids.difference_update
    storage = Mock(list_object_keys=Mock(return_value=plan.storage_object_keys))
    target = Mock(
        side_effect=lambda url, _: InstanceTarget(
            "openslate-fixture",
            make_url(url).host,
            make_url(url).port,
            "postgres",
            tmp_path / "instance.json",
        )
    )
    connect = Mock(return_value=database)
    prompt = Mock(side_effect=AssertionError("Noninteractive reset must not prompt"))
    executed_modes: list[bool] = []
    execute_reset = reset._execute_reset

    def execute(*args, **kwargs):
        executed_modes.append(kwargs["stdin_is_tty"])
        return execute_reset(*args, **kwargs)

    monkeypatch.setattr(reset, "environment_inputs", lambda _: values)
    monkeypatch.setattr(reset, "instance_target_for_process", target)
    monkeypatch.setattr(reset, "connect", connect)
    monkeypatch.setattr(reset, "assert_provider_instance", Mock())
    monkeypatch.setattr(reset, "assert_psycopg_target", Mock())
    monkeypatch.setattr(reset, "ResetAuth", lambda *_: auth)
    monkeypatch.setattr(reset, "ResetStorage", lambda *_: storage)
    monkeypatch.setattr(reset, "build_reset_plan", Mock(return_value=plan))
    monkeypatch.setattr(reset, "_print_plan", lambda _: None)
    monkeypatch.setattr(reset, "_execute_reset", execute)
    monkeypatch.setattr(reset.sys, "stdin", SimpleNamespace(isatty=lambda: False))
    monkeypatch.setattr("builtins.input", prompt)
    monkeypatch.setattr(socket, "create_connection", Mock(side_effect=ConnectionRefusedError))
    statements: list[str] = []
    monkeypatch.setattr(
        execution, "_execute", lambda _connection, statement, *_args: statements.append(statement)
    )
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)
    monkeypatch.setattr(execution, "_validate_postconditions", lambda *_a, **_k: None)
    return SimpleNamespace(
        plan=plan,
        values=values,
        database=database,
        auth=auth,
        storage=storage,
        target=target,
        connect=connect,
        prompt=prompt,
        statements=statements,
        executed_modes=executed_modes,
    )


def test_confirm_digest_is_a_registered_execute_option() -> None:
    args = reset._parser().parse_args(["--execute", "--confirm-digest", "exact"])
    assert args.execute is True and args.confirm_digest == "exact"


def test_confirmation_flag_without_execute_refuses_before_setup(development_reset_cli) -> None:
    state = development_reset_cli
    with pytest.raises(SystemExit, match="requires --execute"):
        reset.main(["--confirm-digest", "exact"])
    state.target.assert_not_called()
    state.connect.assert_not_called()
    state.auth.delete_and_verify_missing.assert_not_called()


@pytest.mark.parametrize("environment", ("test", "dev", "local", "production"))
def test_noninteractive_reset_refuses_outside_development_before_setup(
    development_reset_cli, environment
) -> None:
    state = development_reset_cli
    state.values["ENVIRONMENT"] = environment
    with pytest.raises(SystemExit, match="only with ENVIRONMENT=development"):
        reset.main(["--execute", "--confirm-digest", "exact"])
    state.target.assert_not_called()
    state.connect.assert_not_called()
    state.auth.delete_and_verify_missing.assert_not_called()


@pytest.mark.parametrize(
    "setting,url",
    (
        (
            "MIGRATION_DATABASE_URL",
            "postgresql+psycopg://openslate_owner:fixture-only@192.168.1.4:55432/postgres",
        ),
        ("SUPABASE_URL", "http://192.168.1.4:58000"),
    ),
)
def test_noninteractive_reset_refuses_nonloopback_targets_before_setup(
    development_reset_cli, setting, url
) -> None:
    state = development_reset_cli
    state.values[setting] = url
    with pytest.raises(SystemExit, match="loopback"):
        reset.main(["--execute", "--confirm-digest", "exact"])
    state.target.assert_not_called()
    state.connect.assert_not_called()
    state.auth.delete_and_verify_missing.assert_not_called()


def test_noninteractive_reset_requires_the_fresh_preview_digest(development_reset_cli) -> None:
    state = development_reset_cli
    state.plan.impact_digest = "fresh-state-digest"
    with pytest.raises(SystemExit, match="exact impact-digest"):
        reset.main(["--execute", "--confirm-digest", "previous-preview-digest"])
    state.auth.delete_and_verify_missing.assert_not_called()
    state.storage.delete_and_verify_empty.assert_not_called()
    assert state.statements == []


def test_noninteractive_reset_requires_the_api_stopped(development_reset_cli, monkeypatch) -> None:
    state = development_reset_cli
    monkeypatch.setattr(socket, "create_connection", lambda *_a, **_k: nullcontext())
    with pytest.raises(SystemExit, match="API server must be stopped"):
        reset.main(["--execute", "--confirm-digest", "exact"])
    state.auth.delete_and_verify_missing.assert_not_called()
    assert state.statements == []


def test_noninteractive_development_reset_executes_without_pretending_to_have_a_tty(
    development_reset_cli,
) -> None:
    state = development_reset_cli
    reset.main(["--execute", "--confirm-digest", "exact"])
    state.prompt.assert_not_called()
    assert state.executed_modes == [False]
    state.auth.require_present.assert_called_once_with(state.plan.preserved_admin_provider_id)
    state.auth.delete_and_verify_missing.assert_called_once_with(state.plan.provider_account_ids)
    state.storage.delete_and_verify_empty.assert_called_once_with(state.plan.storage_object_keys)
    assert "DELETE FROM public.users WHERE id <> %s" in state.statements
    state.database.close.assert_called_once()
