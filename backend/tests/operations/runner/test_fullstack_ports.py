"""Port admission follows the services selected by the runner mode."""

from unittest.mock import MagicMock

import pytest

from tests import fullstack_runner as runner


@pytest.mark.parametrize("mode", ["coverage", "batch", "acceptance", "full"])
@pytest.mark.parametrize("occupied_port", [8008, 3448])
def test_runner_requires_only_ports_used_by_selected_mode(
    tmp_path, monkeypatch, mode, occupied_port
):
    backend = tmp_path / "backend"
    (backend / "tests").mkdir(parents=True)
    (backend / "tests/test_sample.py").touch()
    monkeypatch.setattr(runner, "BACKEND", backend)
    arguments = {
        "coverage": ["--backend-coverage-only"],
        "batch": ["--backend-batch", "tests/test_sample.py"],
        "acceptance": ["--acceptance-only"],
        "full": [],
    }[mode]

    def bind(address):
        if address[1] == occupied_port:
            raise OSError("Port occupied")

    listener = MagicMock()
    listener.__enter__.return_value.bind.side_effect = bind
    monkeypatch.setattr(runner.socket, "socket", lambda: listener)
    # Stop at the first post-preflight boundary; no stack or private files are created.
    prepare = MagicMock(side_effect=RuntimeError("Reached disposable setup"))
    monkeypatch.setattr(runner.tempfile, "mkdtemp", prepare)
    if mode in {"coverage", "batch"}:
        with pytest.raises(RuntimeError, match="Reached disposable setup"):
            runner.main(arguments)
        prepare.assert_called_once()
    else:
        assert runner.main(arguments) == 1
        prepare.assert_not_called()


@pytest.mark.parametrize("mode", ["acceptance", "full"])
def test_runner_does_not_reserve_the_retired_frontend_server_port(
    tmp_path, monkeypatch, mode
):
    monkeypatch.setattr(runner, "BACKEND", tmp_path / "backend")
    arguments = {
        "acceptance": ["--acceptance-only"],
        "full": [],
    }[mode]

    listener = MagicMock()

    def bind(address):
        if address[1] == 3008:
            raise OSError("retired frontend port occupied")

    listener.__enter__.return_value.bind.side_effect = bind
    monkeypatch.setattr(runner.socket, "socket", lambda: listener)
    prepare = MagicMock(side_effect=RuntimeError("Reached disposable setup"))
    monkeypatch.setattr(runner.tempfile, "mkdtemp", prepare)

    with pytest.raises(RuntimeError, match="Reached disposable setup"):
        runner.main(arguments)
    prepare.assert_called_once()
