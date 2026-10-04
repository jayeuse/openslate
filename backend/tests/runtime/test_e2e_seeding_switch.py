"""The release smoke runner may relax anonymous sign-up limits only on a test stack."""

import pytest
from pydantic import ValidationError

import app.systems.access.auth.router as auth_router
from app.core.config import Settings
from tests.config_support import settings_values

SWITCH = "e2e_seeding_without_anonymous_limits"


@pytest.mark.parametrize(
    ("environment", "public_origin"),
    [("development", "http://127.0.0.1:3000"), ("production", "https://app.example.test")],
)
def test_the_seeding_switch_is_refused_outside_test(environment: str, public_origin: str) -> None:
    values = settings_values(
        environment=environment, public_origin=public_origin, web_assets_root="/srv/web"
    )
    with pytest.raises(ValidationError, match="only for a test stack"):
        Settings(**values, **{SWITCH: True}, _env_file=None)


def test_test_mode_keeps_anonymous_limits_unless_the_runner_is_seeding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    strict = Settings(**settings_values(), _env_file=None)
    seeding = Settings(**settings_values(), **{SWITCH: True}, _env_file=None)

    monkeypatch.setattr(auth_router, "get_settings", lambda: strict)
    assert auth_router._anonymous_rate_limits_enabled() is True
    monkeypatch.setattr(auth_router, "get_settings", lambda: seeding)
    assert auth_router._anonymous_rate_limits_enabled() is False


def test_the_background_worker_switch_is_refused_outside_test() -> None:
    values = settings_values(
        environment="production", public_origin="https://app.example.test", web_assets_root="/srv"
    )
    with pytest.raises(ValidationError, match="only for a test stack"):
        Settings(**values, e2e_background_workers=True, _env_file=None)


def test_a_test_stack_runs_background_workers_only_when_asked() -> None:
    from app.systems.platform.scheduling.worker import ReportSchedulingWorker
    from app.systems.sandbox.record_triggers.worker import TriggerWorker

    quiet = Settings(**settings_values(), _env_file=None)
    smoke = Settings(**settings_values(), e2e_background_workers=True, _env_file=None)

    for worker in (TriggerWorker, ReportSchedulingWorker):
        assert worker(quiet)._enabled is False
        assert worker(smoke)._enabled is True
