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


@pytest.fixture
def security_console(monkeypatch):
    from operations import recover_workspace_security as security_operation

    user_id = uuid4()
    recover = Mock(return_value=SimpleNamespace(user_id=user_id))
    engine = Mock()
    engine.connect.return_value = nullcontext(object())
    settings = Mock(return_value=SimpleNamespace(database_url="synthetic"))
    monkeypatch.setattr(security_operation, "get_settings", settings)
    monkeypatch.setattr(security_operation, "instance_target_for_process", lambda *_a: object())
    monkeypatch.setattr(security_operation, "assert_database_url", lambda *_a, **_k: None)
    monkeypatch.setattr(security_operation, "assert_instance_target", lambda *_a, **_k: None)
    monkeypatch.setattr(security_operation, "get_engine", lambda: engine)
    monkeypatch.setattr(security_operation, "AuditSession", lambda *_a: nullcontext(object()))
    monkeypatch.setattr(security_operation, "is_elevated", lambda: True)
    monkeypatch.setattr(security_operation, "recover_workspace_security", recover)
    monkeypatch.setattr(security_operation, "environment_inputs", lambda *_a: {})
    monkeypatch.setattr(security_operation, "assert_provider_instance", lambda *_a, **_k: None)
    return security_operation, user_id, recover, settings


def test_security_console_reports_confirmed_reset_and_factors(security_console, capsys):
    security_operation, user_id, recover, _ = security_console
    security_operation.main([str(user_id)])
    recover.assert_called_once()
    output = capsys.readouterr().out
    assert str(user_id) in output
    assert "mfa_policy=optional" in output
    assert "ip_allow_list_cleared=true" in output
    assert "provider_factors_cleared=true" in output
    assert "sessions_revoked=true" in output


def test_security_console_checks_elevation_before_instance_access(security_console, monkeypatch):
    security_operation, user_id, recover, settings = security_console
    monkeypatch.setattr(security_operation, "is_elevated", lambda: False)
    with pytest.raises(SystemExit, match="refused"):
        security_operation.main([str(user_id)])
    settings.assert_not_called()
    recover.assert_not_called()


@pytest.mark.parametrize(
    "guard",
    [
        "instance_target_for_process",
        "assert_database_url",
        "assert_instance_target",
        "assert_provider_instance",
    ],
)
def test_security_console_refuses_unattested_instance(security_console, monkeypatch, guard):
    security_operation, user_id, recover, _ = security_console

    def deny(*_args, **_kwargs):
        raise InstanceTargetError("private target diagnostic")

    monkeypatch.setattr(security_operation, guard, deny)
    with pytest.raises(SystemExit) as caught:
        security_operation.main([str(user_id)])
    recover.assert_not_called()
    assert str(caught.value) == "Workspace security recovery failed"
    assert "private" not in str(caught.value)


def test_security_console_refuses_missing_instance_target(security_console, monkeypatch):
    security_operation, user_id, recover, _ = security_console
    monkeypatch.setattr(security_operation, "instance_target_for_process", lambda *_a: None)
    with pytest.raises(SystemExit, match="refused"):
        security_operation.main([str(user_id)])
    recover.assert_not_called()


def test_security_console_reports_partial_outcome_without_private_diagnostics(security_console):
    from app.systems.access.identity.security_recovery import LocalSecurityRecoveryError

    security_operation, user_id, recover, _ = security_console
    recover.side_effect = LocalSecurityRecoveryError(
        "private diagnostic", local_reset_committed=True, provider_factors_cleared=None
    )
    with pytest.raises(SystemExit) as caught:
        security_operation.main([str(user_id)])
    assert "incomplete" in str(caught.value)
    assert "local_reset_committed=true" in str(caught.value)
    assert "provider_factors_cleared=unknown" in str(caught.value)
    assert "Rerun" in str(caught.value)
    assert "private" not in str(caught.value)


def test_console_recovery_passes_the_named_organization(console, capsys):
    user_id, recover = console
    operation.main([str(user_id), "--organization", "harbor-clinic"])
    assert recover.call_args.kwargs["organization"] == "harbor-clinic"
    operation.main([str(user_id)])
    assert recover.call_args.kwargs["organization"] is None


def test_console_recovery_asks_for_the_organization_when_there_are_several(console, capsys):
    from app.systems.access.identity.admin_recovery import OrganizationChoiceRequired

    user_id, recover = console
    recover.side_effect = OrganizationChoiceRequired(("harbor-clinic", "north-school"))
    with pytest.raises(SystemExit) as caught:
        operation.main([str(user_id)])
    assert str(caught.value) == (
        "Administrator recovery was refused: the account administers several organizations; "
        "rerun with --organization <id or slug> (one of: harbor-clinic, north-school)"
    )
    assert not capsys.readouterr().out


def test_security_console_passes_the_named_organization_and_asks_when_ambiguous(
    security_console,
):
    from app.systems.access.identity.admin_recovery import OrganizationChoiceRequired

    security_operation, user_id, recover, _ = security_console
    security_operation.main([str(user_id), "--organization", "north-school"])
    assert recover.call_args.kwargs["organization"] == "north-school"
    recover.side_effect = OrganizationChoiceRequired(("harbor-clinic", "north-school"))
    with pytest.raises(SystemExit) as caught:
        security_operation.main([str(user_id)])
    assert str(caught.value) == (
        "Workspace security recovery was refused: the account administers several "
        "organizations; rerun with --organization <id or slug> "
        "(one of: harbor-clinic, north-school)"
    )
