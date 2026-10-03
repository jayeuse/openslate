"""Snapshot expiry is bounded to private verified ownership and confirmed removal."""

import json
from datetime import timedelta
from pathlib import Path

import pytest

from operations.backup_runner_host import RunnerError, digest
from tests.operations.backup_runner_fixtures import (
    MANIFEST,
    NOW,
    SNAPSHOT,
    SyntheticCommands,
    claim_document,
    execute,
    private_file,
    runner_config,
)
from tests.operations.test_backup_runner_recovery import active_journal


def candidate(
    config: Path, state: Path, commands: SyntheticCommands, snapshot: str, days: int
) -> dict:
    completed = (NOW - timedelta(days=days)).isoformat()
    claim = claim_document(snapshot=snapshot, completed=completed)
    claim["run"]["requested_at"] = completed
    claim["run"]["started_at"] = completed
    directory = state / "client-a" / "claims" / claim["claim_id"]
    directory.mkdir(mode=0o700, parents=True)
    raw = json.loads(config.read_text())
    raw["completion_marker"] = str(directory / "backup-complete.json")
    copied = private_file(directory / "backup.json", json.dumps(raw))
    private_file(
        directory / "journal.json",
        json.dumps(
            {
                "claim_id": claim["claim_id"],
                "installation_id": "client-a",
                "project": "client-a",
                "config_sha256": digest(copied),
                "claim": claim,
            }
        ),
    )
    private_file(
        directory / "backup-complete.json",
        json.dumps(
            {
                "format_version": 3,
                "source_installation_id": "client-a",
                "source_project": "client-a",
                "snapshot_id": snapshot,
                "manifest_sha256": MANIFEST,
                "completed_at": completed,
            }
        ),
    )
    commands.snapshots.add(snapshot)
    commands.candidates.append(claim)
    return claim


def test_retention_protects_new_snapshot_and_newest_committed_recovery_point(
    tmp_path: Path,
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    oldest = candidate(config, state, commands, "1" * 64, 90)
    newest = candidate(config, state, commands, "2" * 64, 60)
    foreign = candidate(config, state, commands, "3" * 64, 100)
    foreign["installation_id"] = "previous-instance"
    foreign["run"]["installation"] = "previous"
    incomplete = candidate(config, state, commands, "4" * 64, 120)
    incomplete["run"]["reconciled_at"] = None
    result = execute(config, state, commands)
    assert result["state"] == "succeeded"
    assert commands.snapshots == {SNAPSHOT, newest["run"]["snapshot_id"], "3" * 64, "4" * 64}
    assert oldest["run"]["expired_at"] is not None
    assert newest["run"]["expired_at"] is None
    assert [item["op"] for item in commands.operations if item["op"] != "inspect"] == [
        "claim",
        "expire",
        "outcome",
    ]
    assert not any("prune" in args for args, _ in commands.calls)


def test_lost_expiry_ack_replays_exact_command_after_confirming_absence(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    oldest = candidate(config, state, commands, "1" * 64, 90)
    candidate(config, state, commands, "2" * 64, 60)
    commands.ack_loss = "expire"
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands)
    _, journal = active_journal(state)
    exact = journal["expiry"]
    assert exact["run_id"] == oldest["run"]["id"]
    assert commands.claim and commands.claim["run"]["reconciled_at"] is None
    assert not any(item["op"] == "outcome" for item in commands.operations)
    result = execute(config, state, commands, recover=True)
    assert result["state"] == "succeeded"
    assert [item for item in commands.operations if item["op"] == "expire"] == [exact, exact]
    assert sum(args[:2] == ["restic", "forget"] for args, _ in commands.calls) == 1


def test_retention_failure_keeps_verification_and_reconciliation_truth(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    oldest = candidate(config, state, commands, "1" * 64, 90)
    candidate(config, state, commands, "2" * 64, 60)
    commands.fail_forget = True
    result = execute(config, state, commands)
    assert result["state"] == "failed"
    assert commands.claim and commands.claim["run"]["failure_code"] == "retention_failed"
    assert commands.claim["run"]["snapshot_id"] == SNAPSHOT
    assert commands.claim["run"]["verified_at"] is not None
    assert commands.claim["run"]["reconciled_at"] is not None
    assert oldest["run"]["expired_at"] is None and "1" * 64 in commands.snapshots


def test_missing_protected_marker_never_deletes_older_snapshots(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    candidate(config, state, commands, "1" * 64, 90)
    latest = candidate(config, state, commands, "2" * 64, 60)
    (state / "client-a" / "claims" / latest["claim_id"] / "backup-complete.json").unlink()
    result = execute(config, state, commands)
    assert result["state"] == "failed"
    assert not any(args[:2] == ["restic", "forget"] for args, _ in commands.calls)
