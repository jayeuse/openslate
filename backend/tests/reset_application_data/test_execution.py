"""Keep the destructive utility's admission and rollback contracts explicit."""

from secrets import token_urlsafe
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

from scripts import reset_application_data as reset


def test_reset_defaults_to_dry_run_without_database_work() -> None:
    database = Mock()
    assert reset._parser().parse_args([]).execute is False
    reset.apply_reset(database, Mock())
    assert database.mock_calls == []


@pytest.mark.parametrize("tty,confirmation", [(False, "exact"), (True, None), (True, "wrong")])
def test_reset_requires_interactive_exact_confirmation(tty, confirmation) -> None:
    database = Mock()
    plan = SimpleNamespace(impact_digest="exact")
    with pytest.raises(reset.ResetError):
        reset.apply_reset(database, plan, execute=True, stdin_is_tty=tty, confirmation=confirmation)
    assert database.mock_calls == []


@pytest.mark.parametrize("failure", ["lock", "changed_plan"])
def test_reset_rolls_back_before_deleting_when_locked_plan_cannot_be_verified(
    monkeypatch, failure
) -> None:
    canary = token_urlsafe(32)
    database = MagicMock()
    database.info = None
    plan = SimpleNamespace(impact_digest="confirmed", sample_email="admin@example.test")
    if failure == "lock":
        database.execute.side_effect = RuntimeError(canary)
    else:
        monkeypatch.setattr(
            reset, "build_reset_plan", lambda *_: SimpleNamespace(impact_digest="changed")
        )
    with pytest.raises(reset.ResetError) as error:
        reset.apply_reset(
            database, plan, execute=True, stdin_is_tty=True, confirmation=plan.impact_digest
        )
    database.rollback.assert_called_once()
    database.commit.assert_not_called()
    assert canary not in str(error.value)
    assert all("DELETE" not in str(call) for call in database.execute.call_args_list)


def test_reset_rejects_remote_or_mismatched_database_and_missing_owner_environment() -> None:
    password = token_urlsafe(32)
    local = f"postgresql://postgres:{password}@127.0.0.1:54322/postgres"
    assert reset.validate_local_database_url(local) is None
    for url in (local.replace("127.0.0.1", "remote.example"), local.replace("54322", "55322")):
        with pytest.raises(reset.ResetError) as error:
            reset.validate_local_database_url(url)
        assert password not in str(error.value)
    with pytest.raises(reset.ResetError):
        reset.validate_local_database_url(
            local, expected_url=local.replace(password, token_urlsafe(32))
        )
    with pytest.raises(reset.ResetError):
        reset.required_environment({"DATABASE_URL": local, "ADMIN_EMAIL": "admin@example.test"})
