"""Host operator admission and journeys through owned synthetic boundaries."""

import json
from pathlib import Path
from typing import Any

import pytest

from operations import backup_runner
from operations.backups.host import Host, RunnerError
from tests.operations.backup_runner_fixtures import (
    NOW,
    SNAPSHOT,
    NoCommands,
    SyntheticCommands,
    execute,
    private_file,
    runner_config,
)


def test_development_runner_refuses_before_claim_or_service_stop(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path, deployment="development")
    commands = NoCommands()
    with pytest.raises(RunnerError, match="production"):
        Host(config, state, commands).admit()
    assert commands.calls == []


def test_backup_commits_verified_result_after_only_original_services_resume(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    result = execute(config, state, commands)
    assert result["state"] == "succeeded"
    assert commands.claim and commands.claim["run"]["snapshot_id"] == SNAPSHOT
    assert commands.claim["run"]["reconciled_at"] is not None
    running = {
        item["Config"]["Labels"]["com.docker.compose.service"]
        for item in commands.containers
        if item["State"]["Status"] == "running"
    }
    assert running == commands.original_running
    mutations = [request["op"] for request in commands.operations if request["op"] != "inspect"]
    assert mutations == ["claim", "heartbeat", "outcome"]
    restart = [args for args, _ in commands.calls if args[:2] == ["docker", "start"]]
    caddy_id = next(
        item["Id"]
        for item in commands.containers
        if item["Config"]["Labels"]["com.docker.compose.service"] == "caddy"
    )
    assert restart and restart[-1][-1] == caddy_id
    assert not any("up" in args for args, _ in commands.calls)
    bridge = [args for args, _ in commands.calls if args[:2] == ["docker", "run"]]
    assert bridge and all("--read-only" in args and "--pull=never" in args for args in bridge)
    assert all(not any("docker.sock" in value for value in args) for args in bridge)


def test_native_windows_refuses_before_external_commands(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = NoCommands()
    with pytest.raises(RunnerError, match="Windows"):
        Host(config, state, commands, platform_name="nt").admit()
    assert commands.calls == []


def test_foreign_application_instance_refuses_before_claim(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    raw = json.loads(config.read_text())
    app = Path(raw["app_env_file"])
    app.write_text(app.read_text().replace("client-a", "other-client"))
    commands = SyntheticCommands(config)
    with pytest.raises(RunnerError):
        execute(config, state, commands)
    assert not commands.operations
    assert not any("stop" in args for args, _ in commands.calls)


def test_distinct_project_and_installation_are_admitted(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    raw = json.loads(config.read_text())
    raw["project_name"] = "client-project"
    private_file(config, json.dumps(raw))
    commands = SyntheticCommands(config)
    assert execute(config, state, commands)["state"] == "succeeded"
    assert all(
        item["installation_id"] == "client-a" and item["project"] == "client-project"
        for item in commands.operations
    )


def test_adoption_sends_complete_private_marker_on_stdin_without_mount(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.adopted = False
    marker = {
        "format_version": 3,
        "snapshot_id": SNAPSHOT,
        "source_installation_id": "source-a",
        "target_instance_id": "client-a",
        "target_project": "client-a",
        "target_db_container_id": "a" * 64,
        "completed_at": NOW.isoformat(),
        "application_sessions_invalidated": True,
    }
    path = private_file(state.parent / "restore-finalized.json", json.dumps(marker))
    assert (
        execute(config, state, commands, recover=True, restore_finalized=path)["state"] == "adopted"
    )
    adoption = next(item for item in commands.operations if item["op"] == "adopt")
    assert set(adoption["restore_marker"]) == set(marker)
    assert adoption["restore_marker"]["source_installation_id"] == "source-a"
    bridge = [args for args, kwargs in commands.calls if args[:2] == ["docker", "run"]]
    assert all(args[args.index("--user") + 1] == "10001:10001" for args in bridge)
    assert all(
        not any(str(path) in value or "--mount" == value for value in args) for args in bridge
    )
    assert not any(item["op"] == "claim" for item in commands.operations)


@pytest.mark.parametrize("invalid", ["foreign_target", "readable_marker", "unfinalized"])
def test_invalid_restore_marker_cannot_adopt_policy(tmp_path: Path, invalid: str) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.adopted = False
    marker = {
        "format_version": 3,
        "snapshot_id": SNAPSHOT,
        "source_installation_id": "source-a",
        "target_instance_id": "other-client" if invalid == "foreign_target" else "client-a",
        "target_project": "client-a",
        "target_db_container_id": "a" * 64,
        "completed_at": NOW.isoformat(),
        "application_sessions_invalidated": invalid != "unfinalized",
    }
    path = private_file(state.parent / "restore-finalized.json", json.dumps(marker))
    if invalid == "readable_marker":
        path.chmod(0o644)
    with pytest.raises(RunnerError, match="restore_marker_invalid"):
        execute(config, state, commands, recover=True, restore_finalized=path)
    assert not any(item["op"] in {"adopt", "claim"} for item in commands.operations)


def test_cli_vendor_failure_has_safe_json_and_nonzero_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    config, state = runner_config(tmp_path)

    def unavailable(*args: Any, **kwargs: Any) -> dict[str, object]:
        raise RuntimeError("synthetic private vendor diagnostic")

    monkeypatch.setattr(backup_runner, "run_once", unavailable)
    assert (
        backup_runner.main(["run", "--backup-config", str(config), "--state-directory", str(state)])
        == 3
    )
    output = capsys.readouterr()
    assert json.loads(output.out) == {"code": "operator_failed"}
    assert "private vendor diagnostic" not in output.out + output.err


def test_idle_ticks_leave_no_per_claim_backup_material(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.queue = False
    assert execute(config, state, commands)["state"] == "idle"
    assert not list((state / "client-a" / "claims").iterdir())


@pytest.mark.parametrize(
    ("service", "destination", "invalid"),
    [
        pytest.param("db", "/var/lib/postgresql/data", "wrong_name", id="db-data-name"),
        pytest.param("db", "/etc/postgresql-custom", "missing", id="db-config-missing"),
        pytest.param("storage", "/var/lib/storage", "wrong_name", id="storage-name"),
        pytest.param("imgproxy", "/var/lib/storage", "wrong_name", id="imgproxy-name"),
        pytest.param("studio", "/app/snippets", "bind", id="studio-bind"),
        pytest.param(
            "provider-volume-init", "/var/lib/storage", "missing", id="init-storage-missing"
        ),
        pytest.param(
            "provider-volume-init", "/app/snippets", "duplicate", id="init-snippets-duplicate"
        ),
        pytest.param("caddy", "/data", "wrong_name", id="caddy-name"),
        pytest.param("api", "", "actual_api_identity", id="api-identity"),
    ],
)
def test_source_runtime_must_match_owned_configuration_before_claim(
    tmp_path: Path, service: str, destination: str, invalid: str
) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    container = next(
        item
        for item in commands.containers
        if item["Config"]["Labels"]["com.docker.compose.service"] == service
    )
    if invalid == "actual_api_identity":
        container["Config"]["Env"] = [
            entry.replace("client-a", "foreign-instance") for entry in container["Config"]["Env"]
        ]
    else:
        mounted = next(
            mount for mount in container["Mounts"] if mount["Destination"] == destination
        )
        if invalid == "missing":
            container["Mounts"].remove(mounted)
        elif invalid == "bind":
            mounted["Type"] = "bind"
            mounted.pop("Name")
            mounted["Source"] = "/owned-test/unarchived"
        elif invalid == "duplicate":
            container["Mounts"].append(dict(mounted))
        else:
            mounted["Name"] = "foreign-project_unarchived"
    archived: list[dict[str, Any]] = []

    def refuse_archive(host: Host, journal: dict[str, Any]) -> None:
        archived.append(journal)
        raise AssertionError("Invalid source mounts must be refused before the archive starts")

    with pytest.raises(RunnerError, match="admission_failed"):
        backup_runner.run_once(
            config,
            state,
            command_runner=commands,
            archive_runner=refuse_archive,
            now=lambda: NOW,
        )
    assert not commands.operations
    assert not any("stop" in args for args, _ in commands.calls)
    assert not archived


def test_restart_preserves_admitted_ids_and_existing_overlay_labels(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.recreate_on_up = True
    original = {item["Id"] for item in commands.containers}
    for item in commands.containers:
        item["Config"]["Labels"]["openslate.test.run"] = "owned-extra-overlay"
    assert execute(config, state, commands)["state"] == "succeeded"
    assert {item["Id"] for item in commands.containers} == original
    assert all(
        item["Config"]["Labels"]["openslate.test.run"] == "owned-extra-overlay"
        for item in commands.containers
    )
