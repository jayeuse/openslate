"""Host admission and private marker failures are not safe browser interactions."""

import io
import json
from types import SimpleNamespace

import pytest


def test_development_bridge_refuses_before_opening_database(monkeypatch, capsys) -> None:
    from operations import backup_state

    monkeypatch.setattr(
        backup_state, "get_settings", lambda: SimpleNamespace(environment="development")
    )
    monkeypatch.setattr(
        backup_state, "get_engine", lambda: pytest.fail("Development opened the database")
    )
    monkeypatch.setattr(
        backup_state.sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "op": "claim",
                    "installation_id": "dev-installation",
                    "project": "dev-project",
                    "claim_id": "11111111-1111-4111-8111-111111111111",
                }
            )
        ),
    )
    assert backup_state.main([]) == 2
    assert json.loads(capsys.readouterr().out) == {"code": "backup_production_required"}


def test_native_windows_bridge_refuses_before_configuration(monkeypatch, capsys) -> None:
    from operations import backup_state

    monkeypatch.setattr(backup_state.sys, "platform", "win32")
    monkeypatch.setattr(
        backup_state, "get_settings", lambda: pytest.fail("Windows loaded configuration")
    )
    monkeypatch.setattr(
        backup_state.sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "op": "inspect",
                    "installation_id": "windows-installation",
                    "project": "windows-project",
                }
            )
        ),
    )
    assert backup_state.main([]) == 2
    assert json.loads(capsys.readouterr().out) == {"code": "backup_platform_unsupported"}


@pytest.mark.parametrize(
    "raw",
    (
        "not json",
        "x" * 17000,
        '{"op":"restore"}',
        '{"op":"inspect","installation_id":"x","project":"x"}',
    ),
)
def test_bridge_invalid_input_returns_only_safe_code(monkeypatch, capsys, raw) -> None:
    from operations import backup_state

    monkeypatch.setattr(backup_state.sys, "stdin", io.StringIO(raw))
    monkeypatch.setattr(backup_state, "get_engine", lambda: pytest.fail("Invalid input opened DB"))
    assert backup_state.main([]) == 2
    assert json.loads(capsys.readouterr().out) == {"code": "backup_command_invalid"}


def test_adoption_requires_full_existing_finalized_marker_document() -> None:
    from pydantic import ValidationError

    from operations import backup_state

    command = {
        "op": "adopt",
        "installation_id": "restored-installation",
        "project": "restored-project",
        "restore_marker": {
            "source_installation_id": "old-installation",
            "target_instance_id": "restored-installation",
            "target_project": "restored-project",
        },
    }
    with pytest.raises(ValidationError):
        backup_state.COMMAND_ADAPTER.validate_python(command)
