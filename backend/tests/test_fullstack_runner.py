from pathlib import Path
from unittest.mock import MagicMock
from xml.etree.ElementTree import ParseError

import pytest

from tests import fullstack_runner as runner


@pytest.mark.parametrize("failure", ["malformed_report", "summary_write"])
def test_report_failure_still_deletes_private_credentials(tmp_path, monkeypatch, failure):
    private = tmp_path / "private"
    private.mkdir()
    (private / "fixture.json").write_text("private-test-canary")
    if failure == "malformed_report":
        (private / "pytest.xml").write_text("<truncated")
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: str(private))
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")

    def fail_setup(*args, **kwargs):
        raise RuntimeError("controlled setup failure")

    monkeypatch.setattr(runner.shutil, "copytree", fail_setup)
    original_write = Path.write_text

    def write(path, *args, **kwargs):
        if path.name == "fullstack-summary.json":
            raise OSError("controlled summary failure")
        return original_write(path, *args, **kwargs)

    if failure == "summary_write":
        monkeypatch.setattr(Path, "write_text", write)
    with pytest.raises(ParseError if failure == "malformed_report" else OSError):
        runner.main()
    assert not private.exists()


def test_changed_project_identity_cannot_start_or_stop_an_existing_stack(tmp_path, monkeypatch):
    private = tmp_path / "private"
    private.mkdir()
    source = tmp_path / "source"
    (source / "supabase").mkdir(parents=True)
    (source / "supabase/config.toml").write_text('project_id = "another-project"\n')
    monkeypatch.setattr(runner, "ROOT", source)
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: str(private))
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    command = MagicMock()
    monkeypatch.setattr(runner.subprocess, "run", command)
    assert runner.main() == 1
    command.assert_not_called()
    assert not private.exists()
