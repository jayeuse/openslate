"""Console recovery must report email delivery and refuse unrelated providers."""

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from app.core.config.instance import InstanceTargetError
from operations import recover_local_admin as operation


@pytest.fixture
def console(monkeypatch):
    user_id = uuid4()
    recover = Mock(return_value=SimpleNamespace(user_id=user_id))
    monkeypatch.setattr(
        operation, "get_settings", lambda: SimpleNamespace(database_url="synthetic")
    )
    monkeypatch.setattr(operation, "instance_target_for_process", lambda *_a: None)
    monkeypatch.setattr(operation, "get_engine", lambda: object())
    monkeypatch.setattr(operation, "AuditSession", lambda *_a: nullcontext(object()))
    monkeypatch.setattr(operation, "is_elevated", lambda: True)
    monkeypatch.setattr(operation, "recover_local_admin", recover)
    monkeypatch.setattr(operation, "environment_inputs", lambda *_a: {}, raising=False)
    monkeypatch.setattr(
        operation, "assert_provider_instance", lambda *_a, **_k: None, raising=False
    )
    return user_id, recover


def test_console_recovery_reports_email_without_a_temporary_secret(console, capsys):
    user_id, _ = console
    operation.main([str(user_id)])
    output = capsys.readouterr().out
    assert str(user_id) in output
    assert "email" in output.lower()
    assert "temporary_password" not in output


def test_console_recovery_refuses_unadmitted_provider(console, monkeypatch, capsys):
    user_id, recover = console

    def deny(*_args, **_kwargs):
        raise InstanceTargetError("private diagnostic")

    monkeypatch.setattr(operation, "assert_provider_instance", deny, raising=False)
    with pytest.raises((SystemExit, AttributeError)) as caught:
        operation.main([str(user_id)])
    recover.assert_not_called()
    assert isinstance(caught.value, SystemExit)
    assert str(caught.value) == "Administrator recovery failed"
    assert not capsys.readouterr().out
