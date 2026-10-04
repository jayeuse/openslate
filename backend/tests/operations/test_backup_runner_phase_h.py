"""Phase H regressions: verified-time retention, prune, idle-tick crash, heartbeat."""

from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from operations.backups.host import Host
from tests.operations.backup_runner_fixtures import NOW, SyntheticCommands, execute, runner_config
from tests.operations.test_backup_runner_retention import candidate


def _times(claim: dict[str, Any], *, verified_days: int, finished_days: int) -> None:
    claim["run"]["verified_at"] = (NOW - timedelta(days=verified_days)).isoformat()
    claim["run"]["finished_at"] = (NOW - timedelta(days=finished_days)).isoformat()
    claim["run"]["reconciled_at"] = claim["run"]["finished_at"]


def test_retention_keeps_the_newest_verified_point_like_the_database(tmp_path: Path) -> None:
    # The database protects the newest point by verified_at; keeping the newest by
    # finished_at instead let restic forget the point the database then refused to expire.
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    later_finish = candidate(config, state, commands, "1" * 64, 40)
    later_verify = candidate(config, state, commands, "2" * 64, 55)
    _times(later_finish, verified_days=65, finished_days=40)
    _times(later_verify, verified_days=60, finished_days=55)
    result = execute(config, state, commands)
    assert result["state"] == "succeeded"
    assert "2" * 64 in commands.snapshots and "1" * 64 not in commands.snapshots
    assert later_verify["run"]["expired_at"] is None


def test_prune_runs_once_after_forget_and_never_without_a_removal(tmp_path: Path) -> None:
    (tmp_path / "removal").mkdir()
    (tmp_path / "nothing").mkdir()
    config, state = runner_config(tmp_path / "removal")
    commands = SyntheticCommands(config)
    candidate(config, state, commands, "1" * 64, 90)
    candidate(config, state, commands, "2" * 64, 60)
    assert execute(config, state, commands)["state"] == "succeeded"
    restic = [args[1] for args, _ in commands.calls if args[0] == "restic"]
    assert commands.prunes == 1 and restic.index("prune") > restic.index("forget")

    config, state = runner_config(tmp_path / "nothing")
    commands = SyntheticCommands(config)
    candidate(config, state, commands, "2" * 64, 5)
    assert execute(config, state, commands)["state"] == "succeeded"
    assert commands.prunes == 0


def test_crash_after_an_idle_prepare_does_not_block_the_next_tick(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Every tick writes a journal before it asks for a claim; a crash before the
    # empty journal is closed used to require a manual `recover`.
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.queue = False
    original = Host.finish_empty

    def crash_once(self: Host, journal: dict[str, Any]) -> None:
        monkeypatch.setattr(Host, "finish_empty", original)
        raise OSError("power lost")

    monkeypatch.setattr(Host, "finish_empty", crash_once)
    with pytest.raises(OSError):
        execute(config, state, commands)
    assert execute(config, state, commands) == {"state": "idle"}
    assert not (state / "client-a" / "active.json").exists()


def test_runner_heartbeats_after_resume_so_status_stays_available(tmp_path: Path) -> None:
    # runner_last_seen_at was set only at claim, so a run longer than five minutes
    # showed "recovery required" while retention was still working.
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    candidate(config, state, commands, "1" * 64, 90)
    candidate(config, state, commands, "2" * 64, 60)
    assert execute(config, state, commands)["state"] == "succeeded"
    ops = [item["op"] for item in commands.operations if item["op"] != "inspect"]
    assert ops[0] == "claim" and ops[-1] == "outcome"
    assert ops[1] == "heartbeat", ops
    assert ops.count("heartbeat") >= 2
