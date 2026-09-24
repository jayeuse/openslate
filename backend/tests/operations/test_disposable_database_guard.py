import json
import os
import subprocess
from pathlib import Path
from secrets import token_urlsafe
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest

from app.core.config import instance
from app.core.config.disposable_instance import POSTGRES_IMAGE
from app.core.config.instance import (
    InstanceTargetError,
    instance_target_for_process,
)
from tests import postgres_runtime
from tests.conftest import _guard_integration_database
from tests.postgres_runtime import (
    POSTGRES_NETWORK_ALIAS,
    DisposablePostgres,
    assert_scanner_worker_database,
    postgres_network_name,
)


@pytest.fixture
def disposable_target(tmp_path, monkeypatch):
    url = f"postgresql+psycopg://openslate_runtime:{token_urlsafe(32)}@127.0.0.1:49152/openslate"
    run_id = "a" * 32
    container_name = f"openslate-postgres-e2e-{run_id}"
    network_name = f"openslate-app-e2e-{run_id}"
    volume_name = f"openslate-postgres-data-e2e-{run_id}"
    worktree = str(instance.REPOSITORY_ROOT.resolve())
    labels = {"openslate.test.run": run_id, "openslate.test.worktree": worktree}
    container = {
        "Id": "b" * 64, "Name": f"/{container_name}", "State": {"Running": True},
        "Config": {"Image": POSTGRES_IMAGE, "Labels": labels},
        "Mounts": [{"Type": "volume", "Name": volume_name,
                    "Destination": "/var/lib/postgresql/data"}],
        "NetworkSettings": {
            "Networks": {network_name: {"NetworkID": "c" * 64}},
            "Ports": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "49152"}]},
        },
    }
    network = {"Id": "c" * 64, "Internal": True, "Labels": labels}
    volume = {"Name": volume_name, "Labels": labels}
    facts = {"container": container, "network": network, "volume": volume}
    def inspect(arguments):
        if arguments[0] == "inspect":
            return [facts["container"]]
        if arguments[0] == "network":
            return [facts["network"]]
        return [facts["volume"]]
    monkeypatch.setattr(instance, "_docker_json", inspect)
    connection = MagicMock()
    connection.exec_driver_sql.return_value.one.return_value = (
        "openslate", "openslate_runtime", container_name
    )
    engine = MagicMock()
    engine.connect.return_value.__enter__.return_value = connection
    monkeypatch.setattr(postgres_runtime, "create_engine", lambda *_args, **_kwargs: engine)
    facts["connection"] = connection
    manifest = tmp_path / "database.json"
    manifest.write_text(json.dumps({
        "run_id": run_id, "urls": [url],
        "ownership": {
            "container_id": "b" * 64, "container": container_name,
            "network": network_name, "network_id": "c" * 64,
            "volume": volume_name, "host_port": 49152,
            "image": container["Config"]["Image"],
            "cluster_name": container_name, "worktree": worktree,
        },
    }))
    manifest.chmod(0o600)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("OPENSLATE_TEST_DATABASE_MANIFEST", str(manifest))
    monkeypatch.setenv("E2E_ALLOW_MUTATIONS", "true")
    monkeypatch.setenv("OPENSLATE_FULLSTACK_RUN_ID", run_id)
    return url, facts


def test_only_run_owned_exact_disposable_target_is_accepted(disposable_target):
    url, _facts = disposable_target
    _guard_integration_database(url)
    for unsafe in (
        url.replace("postgresql+psycopg", "postgresql"),
        url.replace("127.0.0.1", "localhost"),
        url.replace("127.0.0.1", "production.example"),
        url.replace("49152", "54322"),
        url.replace("/openslate", "/production"),
        url.replace("openslate_runtime", "other_role"),
        url.replace(":49152/openslate", ":49152/openslate?host=production.example"),
    ):
        with pytest.raises(RuntimeError):
            _guard_integration_database(unsafe)


@pytest.mark.parametrize(
    "missing",
    [
        "E2E_ALLOW_MUTATIONS",
        "OPENSLATE_FULLSTACK_RUN_ID",
        "OPENSLATE_TEST_DATABASE_MANIFEST",
    ],
)
def test_missing_run_authorization_refuses_before_connection(
    disposable_target, monkeypatch, missing
):
    url, _facts = disposable_target
    monkeypatch.delenv(missing)
    with pytest.raises(RuntimeError):
        _guard_integration_database(url)


def test_changed_credentials_and_run_identity_are_rejected(disposable_target, monkeypatch):
    url, _facts = disposable_target
    with pytest.raises(RuntimeError):
        _guard_integration_database(url.replace("@", "changed@"))
    monkeypatch.setenv("OPENSLATE_FULLSTACK_RUN_ID", "b" * 32)
    with pytest.raises(RuntimeError):
        _guard_integration_database(url)


@pytest.mark.parametrize("fixture_name", ["integration_db", "integration_owner_db"])
def test_swapped_authorized_roles_are_refused_before_connect(
    disposable_target, monkeypatch, fixture_name
):
    from tests import conftest

    url, _facts = disposable_target
    owner_url = url.replace("openslate_runtime", "postgres")
    manifest = Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"])
    contents = json.loads(manifest.read_text())
    contents["urls"] = [url, owner_url]
    manifest.write_text(json.dumps(contents))
    monkeypatch.setenv("TEST_DATABASE_URL", owner_url)
    monkeypatch.setenv("MIGRATION_DATABASE_URL", url)
    engine = MagicMock(side_effect=AssertionError("Guard allowed a swapped role to connect"))
    monkeypatch.setattr(conftest, "create_engine", engine)
    fixture = getattr(conftest, fixture_name).__wrapped__()
    with pytest.raises(RuntimeError, match="runner-owned"):
        next(fixture)
    engine.assert_not_called()


@pytest.mark.parametrize("change", ["volume", "port", "network", "container"])
def test_live_ownership_mismatch_is_rejected_before_connection(disposable_target, change):
    url, facts = disposable_target
    if change == "volume":
        facts["container"]["Mounts"][0]["Name"] = "other-volume"
    elif change == "port":
        facts["container"]["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"] = "54322"
    elif change == "network":
        facts["network"]["Id"] = "d" * 64
    else:
        facts["container"]["State"]["Running"] = False
    with pytest.raises(RuntimeError, match="live runner-owned"):
        _guard_integration_database(url)


def test_scanner_startup_rechecks_live_database_ownership(disposable_target):
    url, facts = disposable_target
    application_env = {**os.environ, "DATABASE_URL": url}
    assert_scanner_worker_database(application_env)
    facts["volume"]["Labels"]["openslate.test.run"] = "other-run"
    with pytest.raises(RuntimeError, match="exact disposable runtime credentials"):
        assert_scanner_worker_database(application_env)


@pytest.mark.parametrize(
    ("database", "user", "cluster"),
    [("other", "openslate_runtime", True), ("openslate", "other", True),
     ("openslate", "openslate_runtime", False)],
)
def test_test_mode_connected_identity_must_match_before_write(
    disposable_target, database, user, cluster
):
    url, facts = disposable_target
    target = instance_target_for_process(url, "openslate_runtime", os.environ)
    connection = facts["connection"]
    connection.exec_driver_sql.return_value.one.return_value = (
        database, user, target.cluster_name if cluster else "other-cluster"
    )
    with pytest.raises(RuntimeError, match="matching live database identity"):
        _guard_integration_database(url)


def test_disposable_postgres_discovers_a_pinned_image_loopback_port_and_private_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[:2] == ["volume", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, json.dumps([{
                "Name": runtime.volume,
                "Labels": {"openslate.test.run": runtime.run_id,
                           "openslate.test.worktree": runtime.worktree},
            }]))
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(arguments, 0, json.dumps([{
                "Name": f"/{runtime.container}",
                "Config": {"Image": POSTGRES_IMAGE, "Labels": {
                    "openslate.test.run": runtime.run_id,
                    "openslate.test.worktree": runtime.worktree,
                }},
                "Mounts": [{"Destination": "/var/lib/postgresql/data", "Type": "volume",
                            "Name": runtime.volume}],
            }]))
        if arguments[:2] == ["network", "inspect"]:
            return subprocess.CompletedProcess(
                arguments, 0, f"{runtime.run_id} {runtime.worktree}"
            )
        if arguments[0] == "port":
            return subprocess.CompletedProcess(arguments, 0, "127.0.0.1:49152\n")
        if arguments[:3] == ["exec", runtime.container, "psql"]:
            return subprocess.CompletedProcess(
                arguments, 0, f"openslate|postgres|{runtime.container}\n"
            )
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    monkeypatch.setattr(runtime, "_ownership", lambda: {"host_port": runtime.port})
    try:
        runtime.start()
        manifest = runtime.write_manifest()
        runtime.stop()
    finally:
        log.close()

    launch = next(arguments for arguments in commands if arguments[0] == "run")
    assert [
        "network",
        "create",
        "--internal",
        "--label",
        f"openslate.test.run={'a' * 32}",
        "--label",
        f"openslate.test.worktree={runtime.worktree}",
        postgres_network_name("a" * 32),
    ] in commands
    assert POSTGRES_IMAGE in launch
    assert launch[-3:] == ["postgres", "-c", f"cluster_name={runtime.container}"]
    assert "127.0.0.1::5432" in launch
    assert "--network" not in launch
    assert [
        "network",
        "connect",
        "--alias",
        POSTGRES_NETWORK_ALIAS,
        postgres_network_name("a" * 32),
        runtime.container,
    ] in commands
    assert f"openslate.test.run={'a' * 32}" in launch
    assert f"openslate.test.worktree={runtime.worktree}" in launch
    assert f"type=volume,src={runtime.volume},dst=/var/lib/postgresql/data" in launch
    assert ["volume", "create", "--label", f"openslate.test.run={runtime.run_id}",
            "--label", f"openslate.test.worktree={runtime.worktree}", runtime.volume] in commands
    assert manifest.stat().st_mode & 0o077 == 0
    contents = json.loads(manifest.read_text())
    assert contents["run_id"] == "a" * 32
    assert all(":49152/openslate" in url for url in contents["urls"])
    assert {urlsplit(url).username for url in contents["urls"]} == {
        "postgres",
        "openslate_owner",
        "openslate_runtime",
        "openslate_inspector",
    }
    assert ["rm", "--force", runtime.container] in commands
    assert ["volume", "rm", runtime.volume] in commands
    assert ["network", "rm", runtime.network] in commands


def test_disposable_postgres_rejects_wrong_live_cluster_before_migrations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(
                arguments, 0, f"{runtime.run_id} {runtime.worktree} {POSTGRES_IMAGE}\n"
            )
        if arguments[0] == "port":
            return subprocess.CompletedProcess(arguments, 0, "127.0.0.1:49152\n")
        if arguments[:3] == ["exec", runtime.container, "psql"]:
            return subprocess.CompletedProcess(arguments, 0, "openslate|postgres|other-cluster\n")
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    monkeypatch.setattr(runtime, "assert_owned", lambda: None)
    try:
        with pytest.raises(RuntimeError, match="cluster identity"):
            runtime.start()
    finally:
        log.close()


def test_disposable_postgres_rejects_a_missing_or_non_loopback_discovered_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(
                arguments, 0, f"{runtime.run_id} {runtime.worktree} {POSTGRES_IMAGE}\n"
            )
        if arguments[0] == "port":
            return subprocess.CompletedProcess(arguments, 0, "0.0.0.0:49152\n")
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    monkeypatch.setattr(runtime, "assert_owned", lambda: None)
    try:
        with pytest.raises(RuntimeError, match="loopback port mapping"):
            runtime.start()
    finally:
        log.close()


def test_disposable_postgres_never_removes_an_unowned_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(arguments, 0, "different-run " + POSTGRES_IMAGE)
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        with pytest.raises(RuntimeError, match="ownership"):
            runtime.stop()
    finally:
        log.close()
    assert not any(arguments[0] == "rm" for arguments in commands)


def test_disposable_postgres_never_removes_an_unowned_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            raise subprocess.CalledProcessError(1, arguments)
        if arguments[:2] == ["volume", "inspect"]:
            raise subprocess.CalledProcessError(1, arguments)
        if arguments[:2] == ["network", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, "different-run")
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        with pytest.raises(RuntimeError, match="network without ownership"):
            runtime.stop()
    finally:
        log.close()

    assert ["network", "rm", runtime.network] not in commands


def test_disposable_postgres_never_removes_an_unowned_volume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            raise subprocess.CalledProcessError(1, arguments)
        if arguments[:2] == ["volume", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, json.dumps([{
                "Name": runtime.volume, "Labels": {"openslate.test.run": "other-run"},
            }]))
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        with pytest.raises(RuntimeError, match="volume without ownership"):
            runtime.stop()
    finally:
        log.close()
    assert ["volume", "rm", runtime.volume] not in commands

def test_test_process_rejects_a_self_written_manifest_without_live_instance(tmp_path: Path) -> None:
    database_url = "postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55322/openslate"
    manifest = tmp_path / "database.json"
    manifest.write_text(json.dumps({"run_id": "a" * 32, "urls": [database_url]}))
    manifest.chmod(0o600)
    process = {
        "ENVIRONMENT": "test",
        "E2E_ALLOW_MUTATIONS": "true",
        "OPENSLATE_FULLSTACK_RUN_ID": "a" * 32,
        "OPENSLATE_TEST_DATABASE_MANIFEST": str(manifest),
    }

    with pytest.raises(InstanceTargetError):
        instance_target_for_process(database_url, "openslate_runtime", process)
    with pytest.raises(InstanceTargetError):
        instance_target_for_process(
            database_url.replace("55322", "54322"), "openslate_runtime", process
        )


def _container_runtime_process(
    tmp_path: Path, mode: int = 0o600, network: str | None = None
) -> tuple[str, dict[str, str]]:
    run_id = "a" * 32
    database_url = "postgresql+psycopg://openslate_runtime:secret@openslate-postgres:5432/openslate"
    manifest = tmp_path / "database.json"
    manifest.write_text(json.dumps({
            "run_id": run_id,
            "urls": ["postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55322/openslate"],
            "container_runtime": {
                "url": database_url, "network": network or f"openslate-app-e2e-{run_id}",
                "alias": "openslate-postgres", "port": 5432,
            },
        }), encoding="utf-8")
    manifest.chmod(mode)
    return database_url, {
        "ENVIRONMENT": "test", "E2E_ALLOW_MUTATIONS": "true",
        "OPENSLATE_FULLSTACK_RUN_ID": run_id,
        "OPENSLATE_TEST_DATABASE_MANIFEST": str(manifest)}


def test_test_process_rejects_a_container_manifest_without_live_identity(tmp_path: Path) -> None:
    database_url, process = _container_runtime_process(tmp_path)
    with pytest.raises(InstanceTargetError):
        instance_target_for_process(database_url, "openslate_runtime", process)


@pytest.mark.parametrize(
    ("old", "new", "network", "name", "value"),
    [
        ("openslate-postgres", "other-postgres", None, "", ""),
        (":5432", ":5433", None, "", ""),
        ("openslate_runtime", "openslate_owner", None, "", ""),
        ("", "", "shared-test-network", "", ""),
        ("", "", None, "E2E_ALLOW_MUTATIONS", "false"),
        ("", "", None, "OPENSLATE_FULLSTACK_RUN_ID", "b" * 32),
    ],
)
def test_test_process_rejects_a_wrong_container_target(
    tmp_path: Path, old: str, new: str, network: str | None, name: str, value: str
) -> None:
    database_url, process = _container_runtime_process(tmp_path, network=network)
    if name:
        process[name] = value
    with pytest.raises(InstanceTargetError):
        instance_target_for_process(database_url.replace(old, new), "openslate_runtime", process)


@pytest.mark.parametrize("state", ["missing", "public"])
def test_test_process_rejects_a_missing_or_unsafe_container_manifest(
    tmp_path: Path, state: str
) -> None:
    database_url, process = _container_runtime_process(tmp_path)
    path = Path(process["OPENSLATE_TEST_DATABASE_MANIFEST"])
    if state == "missing":
        path = tmp_path / "missing.json"
    else:
        path.chmod(0o644)
    process["OPENSLATE_TEST_DATABASE_MANIFEST"] = str(path)
    with pytest.raises(InstanceTargetError):
        instance_target_for_process(database_url, "openslate_runtime", process)
