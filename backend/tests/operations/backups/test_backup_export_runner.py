"""Export host journeys; API state is a closed fake, not PostgreSQL or crypto proof."""

import copy
import hashlib
import json
import os
import subprocess
import tarfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from operations import backup_runner, backup_state
from operations.backups import export_files
from operations.backups.host import Host, RunnerError, physical_archive
from tests.operations.backups.backup_runner_fixtures import (
    NOW,
    SyntheticCommands,
    execute,
    runner_config,
)
from tests.operations.backups.export_runner_fixtures import (
    EXPORT_OPS,
    ExportCommands,
    ResticCommands,
    command_document,
    expired_artifact,
    inline_export_child,
    published_cleanup_fixture,
    simulate_slow_cleanup_hash,
)


@pytest.mark.parametrize("op", sorted(EXPORT_OPS))
def test_private_bridge_admits_the_closed_export_command(op: str) -> None:
    # Run only after API-owned DTOs exist: rejection then exposes missing host registration.
    command = backup_state.COMMAND_ADAPTER.validate_python(command_document(op))
    assert command.op == op


def test_specific_export_inspection_requires_its_exact_claim() -> None:
    document = command_document("inspect-export")
    document.pop("claim_id")
    with pytest.raises(ValidationError):
        backup_state.COMMAND_ADAPTER.validate_python(document)


def test_idle_tick_inspects_cleanup_and_attempts_only_one_export_claim(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.queue = False
    assert execute(config, state, commands) == {"state": "idle"}
    ops = [request["op"] for request in commands.export_operations]
    assert "inspect-export" in ops
    assert ops.count("claim-export") == 1
    assert not (state / "client-a" / "active.json").exists()
    assert not any("stop" in args or args[:2] == ["docker", "start"] for args, _ in commands.calls)


def test_existing_backup_priority_leaves_export_queue_for_a_later_tick(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    commands.queue = True
    result = execute(config, state, commands)
    assert result["state"] == "succeeded"
    assert commands.pending == 1 and commands.secret_handoffs == 0
    assert not any(item["op"] == "claim-export" for item in commands.export_operations)


@pytest.mark.parametrize("failure", ["source_unavailable", "source_unproven"])
def test_claim_time_source_failure_resolves_one_job_without_secret_or_copy(
    tmp_path: Path,
    failure: str,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    commands.pending = 2
    commands.source_failure = failure
    result = execute(config, state, commands)
    assert result["state"] == "failed"
    assert result["export_id"] == commands.export_id
    assert commands.pending == 1 and commands.secret_handoffs == 0
    assert commands.export_claim is not None
    assert commands.export_claim["export"]["failure_code"] == failure
    assert sum(item["op"] == "claim-export" for item in commands.export_operations) == 1
    assert not any(args[0] == "restic" for args, _ in commands.calls)
    assert not any(args[:2] == ["docker", "start"] or "stop" in args for args, _ in commands.calls)
    assert not any(item["op"] == "export-outcome" for item in commands.export_operations)
    assert not (state / "client-a" / "active.json").exists()


def test_lost_export_secret_handoff_interrupts_exact_claim_without_reissuing(
    tmp_path: Path,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    commands.ack_loss = "claim-export"
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands)
    assert commands.secret_handoffs == 1 and commands.export_claim is not None
    claim_id = commands.export_claim["claim_id"]
    result = execute(config, state, commands, recover=True)
    assert result["state"] == "interrupted"
    assert commands.secret_handoffs == 1
    outcomes = [item for item in commands.export_operations if item["op"] == "export-outcome"]
    assert len(outcomes) == 1 and outcomes[0]["claim_id"] == claim_id
    assert outcomes[0]["failure_code"] == "export_interrupted"
    assert not any(args[0] == "restic" for args, _ in commands.calls)
    assert not any("stop" in args or args[:2] == ["docker", "start"] for args, _ in commands.calls)


def test_foreign_source_marker_fails_before_any_copy(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    marker = state / "client-a" / "claims" / commands.source["claim_id"] / "backup-complete.json"
    facts = json.loads(marker.read_text())
    facts["source_installation_id"] = "another-installation"
    marker.write_text(json.dumps(facts))
    result = execute(config, state, commands)
    assert result["state"] == "failed"
    assert commands.export_claim is not None
    assert commands.export_claim["export"]["failure_code"] == "source_unproven"
    assert not any(args[0] == "restic" and "copy" in args for args, _ in commands.calls)
    assert not any((tmp_path / "backup-exports").iterdir())


@pytest.mark.parametrize("fault", ["writable", "source_repository", "missing"])
def test_export_mount_refuses_before_claim_or_service_mutation(tmp_path: Path, fault: str) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    api = next(
        item
        for item in commands.containers
        if item["Config"]["Labels"]["com.docker.compose.service"] == "api"
    )
    mount = next(
        item for item in api["Mounts"] if item["Destination"] == "/var/lib/openslate/backup-exports"
    )
    if fault == "writable":
        mount["RW"] = True
    elif fault == "source_repository":
        mount["Source"] = str(tmp_path / "repository")
    else:
        api["Mounts"].remove(mount)
    with pytest.raises(RunnerError, match="admission_failed"):
        execute(config, state, commands)
    assert not commands.operations and not commands.export_operations
    assert not any("stop" in args or args[:2] == ["docker", "start"] for args, _ in commands.calls)


def test_copy_publishes_only_checked_repository_and_safe_ready_facts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ResticCommands(config, state)
    inline_export_child(monkeypatch, commands)
    assert execute(config, state, commands)["state"] == "ready"
    artifact = tmp_path / "backup-exports" / (commands.export_id + ".tar")
    with tarfile.open(artifact) as archive:
        assert "repository/config" in archive.getnames()
        assert all(
            name == "repository" or name.startswith("repository/") for name in archive.getnames()
        )
    assert commands.export_claim is not None
    facts = commands.export_claim["export"]
    assert facts["size_bytes"] == artifact.stat().st_size
    assert facts["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert commands.copies == 1 and commands.secret_handoffs == 1
    journal_bytes = b"".join(path.read_bytes() for path in state.rglob("*.json"))
    assert commands.passphrase.encode() not in journal_bytes, (
        "Journal must contain no export secret"
    )
    assert not any("restore" in args or "stop" in args for args, _ in commands.calls)
    assert not any((tmp_path / "backup-export-staging").rglob("*"))


@pytest.mark.parametrize(
    "failure,code",
    [
        ("copy", "copy_failed"),
        ("check", "verification_failed"),
        ("manifest", "verification_failed"),
        ("multiple_snapshots", "verification_failed"),
    ],
)
def test_copy_or_verification_failure_never_publishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    code: str,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ResticCommands(config, state, failure=failure)
    inline_export_child(monkeypatch, commands)
    assert execute(config, state, commands)["state"] == "failed"
    assert commands.export_claim is not None
    assert commands.export_claim["export"]["failure_code"] == code
    assert not any((tmp_path / "backup-exports").iterdir())
    assert not any((tmp_path / "backup-export-staging").rglob("*"))


def test_lost_ready_ack_replays_verified_result_after_source_retention(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ResticCommands(config, state)
    commands.ack_loss = "export-outcome"
    inline_export_child(monkeypatch, commands)
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands)
    assert commands.export_claim is not None
    before = copy.deepcopy(commands.export_claim["export"])
    commands.source["run"]["expired_at"] = NOW.isoformat()
    assert execute(config, state, commands, recover=True)["state"] == "ready"
    assert commands.copies == 1 and commands.secret_handoffs == 1
    assert commands.export_claim["export"] == before
    outcomes = [item for item in commands.export_operations if item["op"] == "export-outcome"]
    assert len(outcomes) == 2 and outcomes[0] == outcomes[1]


def test_publication_never_overwrites_an_unknown_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ResticCommands(config, state)
    artifact = tmp_path / "backup-exports" / (commands.export_id + ".tar")
    artifact.write_bytes(b"operator-owned artifact")
    artifact.chmod(0o640)
    inline_export_child(monkeypatch, commands)
    assert execute(config, state, commands)["state"] == "failed"
    assert artifact.read_bytes() == b"operator-owned artifact"


def test_idle_cleanup_is_bounded_and_preserves_unowned_files(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    root = tmp_path / "backup-exports"
    files = [expired_artifact(root, commands) for _ in range(17)]
    unrelated = root / "operator-owned.tar"
    unrelated.write_bytes(b"retain")
    assert execute(config, state, commands) == {"state": "idle"}
    assert sum(path.exists() for path in files) == 1
    assert unrelated.read_bytes() == b"retain"
    cleaned = [item for item in commands.export_operations if item["op"] == "export-cleaned"]
    assert len(cleaned) == 16
    assert all(not (root / (item["export_id"] + ".tar")).exists() for item in cleaned)


def test_published_large_expired_export_makes_bounded_cleanup_progress_without_rehash(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config, state, commands, path = published_cleanup_fixture(tmp_path, monkeypatch, large=True)
    assert path.stat().st_size > 4 * 1048576
    elapsed = simulate_slow_cleanup_hash(monkeypatch)
    for _ in range(2):
        assert execute(config, state, commands, now=lambda: NOW + timedelta(hours=25)) == {
            "state": "idle"
        }
    assert not path.exists()
    assert elapsed[0] <= 15
    acks = [item for item in commands.export_operations if item["op"] == "export-cleaned"]
    assert len(acks) == 1
    assert commands.copies == 1


def test_lost_cleanup_ack_reuses_exact_absence_acknowledgement(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    path = expired_artifact(tmp_path / "backup-exports", commands)
    commands.ack_loss = "export-cleaned"
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands)
    assert not path.exists()
    execute(config, state, commands, recover=True)
    acks = [item for item in commands.export_operations if item["op"] == "export-cleaned"]
    assert len(acks) == 2 and acks[0] == acks[1]


def test_real_wrong_group_refuses_without_projection(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    if (tmp_path / "backup-exports").stat().st_gid == 10001:
        pytest.skip("This native temp directory already has the required export group")
    commands = SyntheticCommands(config)
    commands.queue = False
    with pytest.raises(RunnerError, match="admission_failed"):
        execute(config, state, commands, project_export_group=False)
    assert not commands.operations and not commands.export_operations


@pytest.mark.parametrize("disposition", ["term", "kill", "survives"])
def test_export_deadline_terminates_reaps_or_retains_registered_child(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    disposition: str,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    waits: list[int] = []
    signals: list[int] = []

    class Child:
        pid, ended = 771, False

        def __init__(self, args: list[str], **kwargs: Any) -> None:
            assert kwargs["start_new_session"] is True
            host = Host(config, state, commands)
            host.config = physical_archive().parse_config(config)
            assert kwargs["pass_fds"] == (int(args[args.index("--lock-fd") + 1]),)
            journal = host.active()
            assert journal is not None
            journal["child"] = {"pid": self.pid, "pgid": self.pid}
            host.save(journal)

        def wait(self, *, timeout: int) -> int:
            waits.append(timeout)
            if (
                disposition == "term"
                and len(waits) == 2
                or disposition == "kill"
                and len(waits) == 3
            ):
                Child.ended = True
                return -15
            raise subprocess.TimeoutExpired("owned export child", timeout)

    def signal_group(pgid: int, signal: int) -> None:
        assert pgid == Child.pid
        if signal == 0 and Child.ended:
            raise ProcessLookupError
        signals.append(signal)

    monkeypatch.setattr(subprocess, "Popen", Child)
    monkeypatch.setattr(os, "killpg", signal_group)
    if disposition == "survives":
        with pytest.raises(RunnerError, match="child_unresolved"):
            execute(config, state, commands)
        with pytest.raises(RunnerError, match="child_unresolved"):
            execute(config, state, commands, recover=True)
    else:
        assert execute(config, state, commands)["state"] == "interrupted"
    assert waits == ([1800, 10] if disposition == "term" else [1800, 10, 10])
    assert signals[0] == 15 and (disposition == "term" or 9 in signals)


def test_ended_export_child_recovery_removes_only_exact_private_residuals(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)

    class Child:
        pid = 771

        def __init__(self, args: list[str], **kwargs: Any) -> None:
            host = Host(config, state, commands)
            host.config = physical_archive().parse_config(config)
            journal = host.active()
            assert journal is not None
            journal["child"] = {"pid": self.pid, "pgid": self.pid}
            host.save(journal)

        def wait(self, *, timeout: int) -> int:
            raise subprocess.TimeoutExpired("owned export child", timeout)

    monkeypatch.setattr(subprocess, "Popen", Child)
    monkeypatch.setattr(os, "killpg", lambda pgid, signal: None)
    with pytest.raises(RunnerError, match="child_unresolved"):
        execute(config, state, commands)
    assert commands.export_claim is not None
    stage = tmp_path / "backup-export-staging" / commands.export_claim["claim_id"]
    assert (stage / "password").is_file()
    repository = stage / "repository"
    repository.mkdir(mode=0o700)
    (repository / "partial").write_bytes(b"owned partial repository")
    sibling = stage.parent / "unknown-private-material"
    sibling.mkdir(mode=0o700)
    (sibling / "retain").write_bytes(b"retain sibling")
    unknown = tmp_path / "backup-exports/operator-owned.tar"
    unknown.write_bytes(b"retain finished-root material")
    with pytest.raises(RunnerError, match="child_unresolved"):
        execute(config, state, commands, recover=True)
    assert (stage / "password").is_file() and (repository / "partial").is_file()

    def ended(pgid: int, signal: int) -> None:
        assert pgid == Child.pid and signal == 0
        raise ProcessLookupError

    monkeypatch.setattr(os, "killpg", ended)
    assert execute(config, state, commands, recover=True)["state"] == "interrupted"
    assert not stage.exists()
    assert (sibling / "retain").read_bytes() == b"retain sibling"
    assert unknown.read_bytes() == b"retain finished-root material"
    assert commands.secret_handoffs == 1
    assert not any(args[0] == "restic" for args, _ in commands.calls)
    assert not (state / "client-a/active.json").exists()


def test_export_wait_cancellation_reaps_cleans_and_preserves_cli_interrupt_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    commands.last_release_checked_at = datetime.now(UTC).isoformat()
    waits: list[int] = []
    signals: list[int] = []

    class Child:
        pid, ended = 771, False

        def __init__(self, args: list[str], **kwargs: Any) -> None:
            host = Host(config, state, commands)
            host.config = physical_archive().parse_config(config)
            journal = host.active()
            assert journal is not None
            journal["child"] = {"pid": self.pid, "pgid": self.pid}
            host.save(journal)

        def wait(self, *, timeout: int) -> int:
            waits.append(timeout)
            if len(waits) == 1:
                raise KeyboardInterrupt
            if len(waits) == 2:
                raise subprocess.TimeoutExpired("owned export child", timeout)
            Child.ended = True
            return -9

    def signal_group(pgid: int, signal: int) -> None:
        assert pgid == Child.pid
        if signal == 0 and Child.ended:
            raise ProcessLookupError
        signals.append(signal)

    monkeypatch.setattr(subprocess, "Popen", Child)
    monkeypatch.setattr(subprocess, "run", commands)
    monkeypatch.setattr(os, "killpg", signal_group)
    assert export_files.EXPORT_GID == 10001
    monkeypatch.setattr(export_files, "EXPORT_GID", os.getegid())
    assert (
        backup_runner.main(
            [
                "run",
                "--backup-config",
                str(config),
                "--state-directory",
                str(state),
            ]
        )
        == 3
    )
    assert json.loads(capsys.readouterr().out) == {"code": "backup_interrupted"}
    assert waits == [1800, 10, 10] and signals == [15, 9]
    assert commands.export_claim is not None
    assert commands.export_claim["export"]["state"] == "interrupted"
    assert commands.export_claim["export"]["failure_code"] == "export_interrupted"
    assert not any((tmp_path / "backup-export-staging").rglob("*"))
    assert not (state / "client-a/active.json").exists()
    assert commands.secret_handoffs == 1
    assert not any("stop" in args or args[:2] == ["docker", "start"] for args, _ in commands.calls)
