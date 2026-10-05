"""Destructive reset acceptance gets a fixed, fresh, noninteractive runner phase."""

from unittest.mock import MagicMock

import pytest

from tests import fullstack_runner as runner
from tests.operations.runner.test_fullstack_runner import _stub_fullstack_prerequisites


def test_reset_phase_selects_only_its_fixed_target_without_starting_application(
    tmp_path, monkeypatch
):
    commands = []
    _stub_fullstack_prerequisites(
        monkeypatch, tmp_path, lambda command, **_kwargs: commands.append(command) or MagicMock()
    )
    observed = {}

    def batch(_run, _backend, _private, environment, _run_id, selection):
        observed.update(environment=environment, selection=selection)
        return 0

    monkeypatch.setattr(runner, "run_backend_batches", batch)
    assert runner.main(["--reset-acceptance-only"]) == 0
    assert observed["selection"] == {
        "targets": ["tests/reset_application_data/provider_reset_acceptance.py"],
        "layer": "integration",
        "interactive": False,
    }
    assert observed["environment"]["OPENSLATE_TEST_RESET_ACCEPTANCE"] == "1"
    assert observed["environment"]["OPENSLATE_ENV_SOURCE"] == "process"
    assert "OPENSLATE_TEST_DATABASE_MANIFEST" in observed["environment"]
    assert not any(command[:2] == ["npm", "run"] for command in commands)


def test_reset_phase_rejects_custom_targets_before_creating_a_stack(monkeypatch):
    setup = MagicMock()
    monkeypatch.setattr(runner, "DisposablePostgres", setup)
    with pytest.raises(SystemExit):
        runner.main(["--reset-acceptance-only", "tests/arbitrary.py"])
    setup.assert_not_called()
