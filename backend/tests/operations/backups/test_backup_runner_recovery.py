"""Interrupted host work requires disposition and exact-claim reconciliation."""

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

from operations.backups import archive as backup_runner_archive
from operations.backups import export_files
from operations.backups.host import Host, RunnerError, physical_archive
from tests.operations.backups.backup_runner_fixtures import (
    SNAPSHOT,
    SyntheticCommands,
    claim_document,
    execute,
    runner_config,
    successful_archive,
)


def active_journal(state: Path) -> tuple[Path, dict[str, Any]]:
    pointer = json.loads((state / "client-a" / "active.json").read_text())
    path = state / "client-a" / "claims" / pointer["claim_id"] / "journal.json"
    return path, json.loads(path.read_text())


def test_failed_backup_stays_quiescent_until_explicit_recovery_without_new_backup(
    tmp_path: Path,
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    backups = 0

    def fail_archive(host: Any, journal: dict[str, Any]) -> None:
        nonlocal backups
        backups += 1
        raise RunnerError("backup_failed")

    with pytest.raises(RunnerError, match="backup_failed"):
        execute(config, state, commands, archive_runner=fail_archive)
    assert all(item["State"]["Status"] == "exited" for item in commands.containers)
    _, journal = active_journal(state)
    assert journal["outcome"]["state"] == "failed"
    assert journal["outcome"]["reconciled_at"] is None
    with pytest.raises(RunnerError, match="recovery_required"):
        execute(config, state, commands)
    result = execute(
        config,
        state,
        commands,
        archive_runner=fail_archive,
        recover=True,
    )
    assert result["state"] == "failed"
    assert backups == 1
    assert commands.claim and commands.claim["run"]["reconciled_at"] is not None


def test_lost_claim_acknowledgement_never_stops_and_recovers_by_claim_identity(
    tmp_path: Path,
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.ack_loss = "claim"
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands)
    assert not any("stop" in args for args, _ in commands.calls)
    assert commands.claim
    result = execute(config, state, commands, recover=True)
    assert result["state"] == "interrupted"
    assert sum(request["op"] == "claim" for request in commands.operations) == 1
    lookups = [
        item for item in commands.operations if item["op"] == "inspect" and "claim_id" in item
    ]
    assert lookups and all(item["claim_id"] == commands.claim["claim_id"] for item in lookups)
    assert not any(item["run"]["snapshot_id"] for item in [commands.claim])


def test_lost_final_ack_replays_identical_outcome_without_second_archive(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.ack_loss = "outcome"
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands)
    _, journal = active_journal(state)
    exact = journal["outcome"]
    result = execute(config, state, commands, recover=True)
    assert result["state"] == "succeeded"
    assert [request for request in commands.operations if request["op"] == "outcome"] == [
        exact,
        exact,
    ]
    assert sum("stop" in args for args, _ in commands.calls) == 1


def test_failed_readiness_keeps_caddy_closed(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.readiness = False
    with pytest.raises(RunnerError, match="readiness_failed"):
        execute(config, state, commands)
    caddy = next(
        item
        for item in commands.containers
        if item["Config"]["Labels"]["com.docker.compose.service"] == "caddy"
    )
    assert caddy["State"]["Status"] == "exited"
    _, journal = active_journal(state)
    assert journal["outcome"]["snapshot_id"] == SNAPSHOT
    assert journal["outcome"]["reconciled_at"] is None


def test_recovery_refuses_daemon_volume_reader_before_restart(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)

    def interruption(host: Any, journal: dict[str, Any]) -> None:
        raise RunnerError("backup_interrupted")

    with pytest.raises(RunnerError):
        execute(config, state, commands, archive_runner=interruption)
    commands.orphan = True
    before = len(commands.calls)
    with pytest.raises(RunnerError, match="child_unresolved"):
        execute(config, state, commands, recover=True)
    assert not any("up" in args for args, _ in commands.calls[before:])


def test_marker_for_another_installation_cannot_resume_writes(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)

    def wrong_marker(host: Any, journal: dict[str, Any]) -> None:
        successful_archive(host, journal)
        path = host.run_directory(journal) / "backup-complete.json"
        marker = json.loads(path.read_text())
        marker["source_installation_id"] = "other-client"
        path.write_text(json.dumps(marker))

    with pytest.raises(RunnerError, match="verification_failed"):
        execute(config, state, commands, archive_runner=wrong_marker)
    assert all(item["State"]["Status"] == "exited" for item in commands.containers)
    with pytest.raises(RunnerError, match="verification_failed"):
        execute(config, state, commands, recover=True)
    assert not any("up" in args for args, _ in commands.calls)


def test_recovery_refuses_live_registered_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.ack_loss = "claim"
    with pytest.raises(RunnerError):
        execute(config, state, commands)
    path, journal = active_journal(state)
    journal["child"] = {"pid": 771, "pgid": 771}
    path.write_text(json.dumps(journal))
    probes: list[tuple[int, int]] = []
    monkeypatch.setattr(os, "killpg", lambda pgid, signal: probes.append((pgid, signal)))
    before = len(commands.calls)
    with pytest.raises(RunnerError, match="child_unresolved"):
        execute(config, state, commands, recover=True)
    assert probes == [(771, 0)]
    assert not any("up" in args for args, _ in commands.calls[before:])


def test_child_registers_group_before_existing_physical_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    assert export_files.EXPORT_GID == 10001
    monkeypatch.setattr(export_files, "EXPORT_GID", os.getegid())
    host = Host(config, state, commands)
    host.admit()
    archive_called: list[Path] = []
    monkeypatch.setattr(os, "getpid", lambda: 771)
    monkeypatch.setattr(os, "getpgid", lambda pid: 771)

    def archive(config_path: Path) -> None:
        _, saved = active_journal(state)
        assert saved["child"] == {"pid": 771, "pgid": 771}
        assert saved["phase"] == "backup_started"
        archive_called.append(config_path)

    monkeypatch.setattr(physical_archive(), "run_backup", archive)
    with host.locked():
        journal = host.prepare("00000000-0000-4000-8000-000000000001", [])
        journal["claim"] = claim_document(claim_id=journal["claim_id"])
        journal["phase"] = "stopped"
        host.save(journal)
        backup_runner_archive.backup_child(host, journal["claim_id"], host.lock_fd)
        assert archive_called == [host.run_config(journal)]


def test_archive_launcher_inherits_lock_and_uses_dedicated_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    assert export_files.EXPORT_GID == 10001
    monkeypatch.setattr(export_files, "EXPORT_GID", os.getegid())
    host = Host(config, state, commands)
    host.admit()
    launches: list[dict[str, Any]] = []

    class Child:
        def __init__(self, args: list[str], **kwargs: Any) -> None:
            launches.append(kwargs)

        def wait(self, *, timeout: int) -> int:
            assert timeout <= 1800
            successful_archive(host, journal)
            return 0

    import subprocess

    monkeypatch.setattr(subprocess, "Popen", Child)
    with host.locked():
        journal = host.prepare("00000000-0000-4000-8000-000000000001", [])
        backup_runner_archive.run_archive(host, journal)
        assert launches and launches[0]["pass_fds"] == (host.lock_fd,)
        assert launches[0]["start_new_session"] is True


def test_archive_timeout_signals_only_owned_group_and_requires_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    assert export_files.EXPORT_GID == 10001
    monkeypatch.setattr(export_files, "EXPORT_GID", os.getegid())
    host = Host(config, state, commands)
    host.admit()
    signals: list[tuple[int, int]] = []

    class Child:
        pid = 771
        attempts = 0

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def wait(self, *, timeout: int) -> int:
            self.attempts += 1
            if self.attempts == 1:
                raise subprocess.TimeoutExpired("owned backup child", timeout)
            return -15

    monkeypatch.setattr(subprocess, "Popen", Child)
    monkeypatch.setattr(os, "killpg", lambda pgid, signal: signals.append((pgid, signal)))
    with host.locked():
        journal = host.prepare("00000000-0000-4000-8000-000000000001", [])
        with pytest.raises(RunnerError, match="backup_interrupted"):
            backup_runner_archive.run_archive(host, journal)
    assert signals and all(pgid == 771 for pgid, _ in signals)


@pytest.mark.skipif(os.name == "nt", reason="Native Windows is refused by the production runner")
def test_external_child_keeps_host_lock_after_parent_descriptor_closes(tmp_path: Path) -> None:
    import fcntl

    config, state = runner_config(tmp_path)
    path = state / "child-inheritance-lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    ready = threading.Event()
    children: list[subprocess.Popen[bytes]] = []

    def controlled_child(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import sys; sys.stdout.buffer.write(b'R'); "
                "sys.stdout.buffer.flush(); sys.stdin.buffer.read(1)",
            ],
            pass_fds=kwargs.get("pass_fds", ()),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        children.append(child)
        assert child.stdout and child.stdout.read(1) == b"R"
        ready.set()
        code = child.wait(timeout=10)
        return subprocess.CompletedProcess(args, code, b"", b"")

    host = Host(config, state, controlled_child)
    host.lock_fd = descriptor
    worker = threading.Thread(
        target=lambda: host.command(["owned-child"], failure="result_unconfirmed")
    )
    worker.start()
    probe = -1
    try:
        assert ready.wait(timeout=5), "Controlled child did not reach its pipe barrier"
        os.close(descriptor)
        descriptor = -1
        probe = os.open(path, os.O_RDWR)
        blocked = False
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            blocked = True
        assert blocked, "A surviving external child must prevent recovery from taking the lock"
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if probe >= 0:
            os.close(probe)
        if children:
            assert children[0].stdin
            children[0].stdin.write(b"Q")
            children[0].stdin.flush()
        worker.join(timeout=5)
    assert not worker.is_alive()


def test_timeout_preserves_child_registration_in_failure_journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)

    class Child:
        pid = 771
        attempts = 0

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            path, saved = active_journal(state)
            saved["child"] = {"pid": 771, "pgid": 771}
            saved["phase"] = "backup_started"
            path.write_text(json.dumps(saved))

        def wait(self, *, timeout: int) -> int:
            self.attempts += 1
            if self.attempts == 1:
                raise subprocess.TimeoutExpired("owned child", timeout)
            return -15

    monkeypatch.setattr(subprocess, "Popen", Child)
    monkeypatch.setattr(os, "killpg", lambda *args: None)
    with pytest.raises(RunnerError, match="backup_interrupted"):
        execute(config, state, commands, archive_runner=backup_runner_archive.run_archive)
    _, saved = active_journal(state)
    assert saved["child"] == {"pid": 771, "pgid": 771}
    assert saved["outcome"]["reconciled_at"] is None
