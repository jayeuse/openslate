import json
import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest
import yaml

from app.core.config import instance
from app.core.config.disposable_instance import (
    PROVIDER_BIND_MOUNTS,
    PROVIDER_IMAGES,
    PROVIDER_NETWORKS,
    PROVIDER_VOLUMES,
)
from app.core.config.instance import (
    InstanceTargetError,
    instance_target_for_process,
)
from tests import postgres_runtime
from tests.conftest import _guard_for_test, _guard_integration_database
from tests.postgres_runtime import DisposablePostgres, assert_runner_database_url


def test_runner_resource_inventory_matches_provider_compose() -> None:
    compose_directory = instance.REPOSITORY_ROOT / "infra/supabase"
    base = yaml.safe_load((compose_directory / "compose.yaml").read_text(encoding="utf-8"))
    dev = yaml.safe_load((compose_directory / "compose.dev.yaml").read_text(encoding="utf-8"))
    images = {
        name: service["image"]
        for document in (base, dev)
        for name, service in document["services"].items()
        if "image" in service
    }
    assert set(base["services"]) | set(dev["services"]) == set(PROVIDER_IMAGES)
    assert images == PROVIDER_IMAGES
    assert set(base["volumes"]) | set(dev.get("volumes", {})) == set(PROVIDER_VOLUMES)
    assert set(base["networks"]) | set(dev["networks"]) == set(PROVIDER_NETWORKS)
    declared_binds = {
        (service, source.removeprefix("./"), destination, mode)
        for service, settings in base["services"].items()
        for entry in settings.get("volumes", [])
        if entry.startswith("./")
        for source, destination, mode in [entry.split(":")]
    }
    guarded_binds = {
        (service, source, destination, "ro")
        for service, mounts in PROVIDER_BIND_MOUNTS.items()
        for source, destination in mounts
    }
    assert declared_binds == guarded_binds


@pytest.fixture
def disposable_target(tmp_path, monkeypatch):
    url = "postgresql+psycopg://openslate_runtime:test-only-placeholder@127.0.0.1:49152/postgres"
    run_id = "a" * 32
    project = f"openslate-e2e-{run_id}"
    worktree = str(instance.REPOSITORY_ROOT.resolve())
    labels = {"openslate.test.run": run_id, "openslate.test.worktree": worktree}
    network_ids = {name: f"{index + 12:064x}" for index, name in enumerate(PROVIDER_NETWORKS)}
    service_ids = {name: f"{index + 1:064x}" for index, name in enumerate(PROVIDER_IMAGES)}
    project_ids = list(service_ids.values())
    compose = yaml.safe_load(
        (instance.REPOSITORY_ROOT / "infra/supabase/compose.yaml").read_text(encoding="utf-8")
    )
    containers = {}
    for service, image in PROVIDER_IMAGES.items():
        networks = {
            "db": ["provider", "operator", "db-host"],
            "auth": ["provider", "mail-egress"],
            "meta": ["operator"],
            "studio": ["operator", "studio-ingress"],
            "api-gw": ["provider", "studio-ingress", "gateway-host"],
            "mailpit": ["mail-egress"],
        }.get(service, ["provider"])
        mounts = []
        for owner, name, destination in (
            ("db", "supabase-db-data", "/var/lib/postgresql/data"),
            ("db", "supabase-db-config", "/etc/postgresql-custom"),
            ("imgproxy", "supabase-storage-data", "/var/lib/storage"),
            ("provider-volume-init", "supabase-storage-data", "/var/lib/storage"),
            ("provider-volume-init", "supabase-studio-snippets", "/app/snippets"),
            ("storage", "supabase-storage-data", "/var/lib/storage"),
            ("studio", "supabase-studio-snippets", "/app/snippets"),
        ):
            if service == owner:
                mounts.append(
                    {
                        "Type": "volume",
                        "Name": f"{project}_{name}",
                        "Destination": destination,
                        "RW": service != "imgproxy",
                    }
                )
        for entry in compose["services"].get(service, {}).get("volumes", []):
            if entry.startswith("./"):
                source, destination, mode = entry.split(":")
                mounts.append(
                    {
                        "Type": "bind",
                        "Source": str((Path(worktree) / "infra/supabase" / source).resolve()),
                        "Destination": destination,
                        "RW": mode != "ro",
                    }
                )
        ports = {}
        if service in {"db", "api-gw", "mailpit"}:
            internal, host_port = {
                "db": ("5432/tcp", "49152"),
                "api-gw": ("8000/tcp", "49153"),
                "mailpit": ("8025/tcp", "49154"),
            }[service]
            ports[internal] = [{"HostIp": "127.0.0.1", "HostPort": host_port}]
        if service == "api-gw":
            ports["8001/tcp"] = [{"HostIp": "127.0.0.1", "HostPort": "49155"}]
        containers[service] = {
            "Id": service_ids[service],
            "Name": f"/{project}-{service}-1",
            "State": {
                "Running": service != "provider-volume-init",
                "ExitCode": 0,
            },
            "Config": {
                "Image": image,
                "Labels": {
                    **labels,
                    "com.docker.compose.project": project,
                    "com.docker.compose.service": service,
                    "com.docker.compose.project.working_dir": f"{worktree}/infra/supabase",
                },
            },
            "Mounts": mounts,
            "NetworkSettings": {
                "Networks": {
                    f"{project}_{name}": {"NetworkID": network_ids[name]} for name in networks
                },
                "Ports": ports,
            },
        }
    networks = {
        name: {
            "Id": network_ids[name],
            "Name": f"{project}_{name}",
            "Internal": name in {"provider", "operator", "studio-ingress"},
            "Labels": {
                **labels,
                "com.docker.compose.project": project,
                "com.docker.compose.network": name,
            },
        }
        for name in PROVIDER_NETWORKS
    }
    volumes = {
        name: {
            "Name": f"{project}_{name}",
            "Labels": {
                **labels,
                "com.docker.compose.project": project,
                "com.docker.compose.volume": name,
            },
        }
        for name in PROVIDER_VOLUMES
    }
    facts = {
        "container": containers["db"],
        "network": networks["provider"],
        "volume": volumes["supabase-db-data"],
        "containers": containers,
        "networks": networks,
        "volumes": volumes,
        "project_ids": project_ids,
    }
    inspection_calls = []
    inspection_faults = {}
    reverse_inspections = False

    def inspect(arguments):
        inspection_calls.append(arguments)
        if arguments[0] == "ps":
            return project_ids
        if arguments[0] == "inspect":
            return [
                container for container in containers.values() if container["Id"] in arguments[1:]
            ]
        kind, names = arguments[0], arguments[2:]
        source = networks if kind == "network" else volumes
        results = [source[name.removeprefix(f"{project}_")] for name in names]
        fault = inspection_faults.get(kind)
        if fault == "missing":
            results.pop()
        elif fault == "duplicate":
            results.append(dict(results[0]))
        elif fault == "extra":
            results.append({**results[0], "Name": f"{project}_unowned"})
        if reverse_inspections:
            results.reverse()
        return results

    facts["inspection_calls"] = inspection_calls
    facts["inspection_faults"] = inspection_faults

    def reverse_results():
        nonlocal reverse_inspections
        reverse_inspections = True

    facts["reverse_results"] = reverse_results
    monkeypatch.setattr(instance, "_docker_json", inspect)
    connection = MagicMock()
    connection.exec_driver_sql.return_value.one.return_value = (
        "postgres",
        "openslate_runtime",
        project,
    )
    engine = MagicMock()
    engine.connect.return_value.__enter__.return_value = connection
    monkeypatch.setattr(postgres_runtime, "create_engine", lambda *_args, **_kwargs: engine)
    facts["connection"] = connection
    manifest = tmp_path / "database.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 2,
                "run_id": run_id,
                "urls": [url],
                "provider": {
                    "api_url": "http://127.0.0.1:49153",
                    "auth_issuer": "http://127.0.0.1:49153/auth/v1",
                    "storage_url": "http://127.0.0.1:49153/storage/v1",
                    "mail_url": "http://127.0.0.1:49154",
                    "publish_url": "http://127.0.0.1:49155/realtime/v1/api/broadcast",
                },
                "ownership": {
                    "project": project,
                    "worktree": worktree,
                    "compose_directory": f"{worktree}/infra/supabase",
                    "service_ids": service_ids,
                    "network_ids": network_ids,
                    "db_port": 49152,
                    "api_port": 49153,
                    "mail_port": 49154,
                    "publisher_port": 49155,
                    "cluster_name": project,
                },
            }
        )
    )
    manifest.chmod(0o600)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("OPENSLATE_TEST_DATABASE_MANIFEST", str(manifest))
    monkeypatch.setenv("E2E_ALLOW_MUTATIONS", "true")
    monkeypatch.setenv("OPENSLATE_FULLSTACK_RUN_ID", run_id)
    monkeypatch.setenv("SUPABASE_URL", "http://127.0.0.1:49153")
    monkeypatch.setenv("REALTIME_PUBLISH_URL", "http://127.0.0.1:49155/realtime/v1/api/broadcast")
    monkeypatch.setenv("SUPABASE_AUTH_ISSUER", "http://127.0.0.1:49153/auth/v1")
    monkeypatch.setenv("SUPABASE_STORAGE_URL", "http://127.0.0.1:49153/storage/v1")
    return url, facts


def test_only_run_owned_exact_disposable_target_is_accepted(disposable_target):
    url, _facts = disposable_target
    _guard_integration_database(url)
    for unsafe in (
        url.replace("postgresql+psycopg", "postgresql"),
        url.replace("127.0.0.1", "localhost"),
        url.replace("127.0.0.1", "production.example"),
        url.replace("49152", "54322"),
        url.replace("/postgres", "/production"),
        url.replace("openslate_runtime", "other_role"),
        url.replace(":49152/postgres", ":49152/postgres?host=production.example"),
    ):
        with pytest.raises(RuntimeError):
            _guard_integration_database(unsafe)


def test_provider_endpoint_from_another_run_is_denied_before_database_connection(
    disposable_target, monkeypatch
) -> None:
    url, _facts = disposable_target
    for name, value in (
        ("SUPABASE_URL", "http://127.0.0.1:59000"),
        ("REALTIME_PUBLISH_URL", "http://127.0.0.1:59000/realtime/v1/api/broadcast"),
        ("SUPABASE_AUTH_ISSUER", "http://127.0.0.1:59000/auth/v1"),
        ("SUPABASE_STORAGE_URL", "http://127.0.0.1:59000/storage/v1"),
    ):
        with monkeypatch.context() as change:
            change.setenv(name, value)
            with pytest.raises(RuntimeError, match="runner-owned"):
                _guard_integration_database(url)


@pytest.mark.parametrize("name", ["SUPABASE_URL", "SUPABASE_AUTH_ISSUER", "SUPABASE_STORAGE_URL"])
def test_missing_provider_endpoint_is_denied_before_database_connection(
    disposable_target, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    url, _facts = disposable_target
    monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError, match="runner-owned"):
        _guard_integration_database(url)


def test_disposable_database_urls_target_provider_postgres_not_legacy_database(
    tmp_path: Path,
) -> None:
    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        runtime.port = 49152
        urls = runtime.urls()
    assert all(urlsplit(url).path == "/postgres" for url in urls.values())


def test_runner_exposes_owned_provider_and_mail_endpoints(tmp_path: Path) -> None:
    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        runtime.port = 49152
        runtime.api_port = 49153
        runtime.mail_port = 49154
        runtime.publisher_port = 49155
        endpoint = runtime.provider_environment()
    assert endpoint["SUPABASE_URL"] == "http://127.0.0.1:49153"
    assert endpoint["SUPABASE_AUTH_ISSUER"] == "http://127.0.0.1:49153/auth/v1"
    assert runtime.mail_url == "http://127.0.0.1:49154"


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
    fixture = getattr(conftest, fixture_name).__wrapped__(_TestItem())
    with pytest.raises(RuntimeError, match="runner-owned"):
        next(fixture)
    engine.assert_not_called()


@pytest.mark.parametrize(
    "change",
    [
        "volume",
        "port",
        "network",
        "container",
        "extra-project-container",
        "extra-published-port",
        "extra-bind-mount",
    ],
)
def test_live_ownership_mismatch_is_rejected_before_connection(disposable_target, change):
    url, facts = disposable_target
    if change == "volume":
        facts["container"]["Mounts"][0]["Name"] = "other-volume"
    elif change == "port":
        facts["container"]["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"] = "54322"
    elif change == "network":
        facts["network"]["Id"] = "d" * 64
    elif change == "extra-project-container":
        facts["project_ids"].append("f" * 64)
    elif change == "extra-published-port":
        facts["containers"]["auth"]["NetworkSettings"]["Ports"]["9999/tcp"] = [
            {"HostIp": "127.0.0.1", "HostPort": "59199"}
        ]
    elif change == "extra-bind-mount":
        facts["containers"]["auth"]["Mounts"].append(
            {
                "Type": "bind",
                "Source": "/tmp/unowned-auth-config",
                "Destination": "/etc/auth/override",
                "RW": False,
            }
        )
    else:
        facts["container"]["State"]["Running"] = False
    with pytest.raises(RuntimeError, match="live runner-owned"):
        _guard_integration_database(url)


@pytest.mark.parametrize("resource", ["network", "volume"])
@pytest.mark.parametrize("malformation", ["missing", "duplicate", "extra"])
def test_malformed_live_resource_inspection_is_rejected(disposable_target, resource, malformation):
    url, facts = disposable_target
    facts["inspection_faults"][resource] = malformation

    with pytest.raises(RuntimeError, match="live runner-owned"):
        _guard_integration_database(url)


def test_live_resource_inspections_are_batched_and_accept_reordered_results(disposable_target):
    url, facts = disposable_target
    facts["reverse_results"]()

    _guard_integration_database(url)

    calls = facts["inspection_calls"]
    assert len(calls) == 4
    assert sum(call[0] == "ps" for call in calls) == 1
    assert sum(call[0] == "inspect" for call in calls) == 1
    network_calls = [call for call in calls if call[:2] == ["network", "inspect"]]
    volume_calls = [call for call in calls if call[:2] == ["volume", "inspect"]]
    assert len(network_calls) == len(volume_calls) == 1
    assert set(network_calls[0][2:]) == {network["Name"] for network in facts["networks"].values()}
    assert set(volume_calls[0][2:]) == {volume["Name"] for volume in facts["volumes"].values()}


class _TestItem:
    def __init__(self) -> None:
        self.node = MagicMock(stash=pytest.Stash())


def test_fixture_guards_verify_docker_once_per_process_and_identity_every_test(
    disposable_target, monkeypatch
):
    from tests import conftest

    url, facts = disposable_target
    calls, connection = facts["inspection_calls"], facts["connection"]
    monkeypatch.setattr(conftest, "_OWNERSHIP_CACHE", {})
    item = _TestItem()

    _guard_for_test(item, url)
    _guard_for_test(item, url)
    assert (len(calls), connection.exec_driver_sql.call_count) == (4, 1)

    # The next test reuses live Docker ownership but rechecks the database identity.
    _guard_for_test(_TestItem(), url)
    assert (len(calls), connection.exec_driver_sql.call_count) == (4, 2)

    # Unrelated settings that tests change do not discard the verdict.
    monkeypatch.setenv("AUTH_REFRESH_TOKEN_DAYS", "3")
    _guard_for_test(_TestItem(), url)
    assert (len(calls), connection.exec_driver_sql.call_count) == (4, 3)

    # A changed ownership input is a new verdict, and here a refusal.
    monkeypatch.setenv("SUPABASE_URL", "http://127.0.0.1:59000")
    with pytest.raises(RuntimeError, match="runner-owned"):
        _guard_for_test(_TestItem(), url)


def test_a_cached_owner_is_still_refused_when_the_database_identity_changes(
    disposable_target, monkeypatch
):
    from tests import conftest

    url, facts = disposable_target
    monkeypatch.setattr(conftest, "_OWNERSHIP_CACHE", {})
    _guard_for_test(_TestItem(), url)
    facts["connection"].exec_driver_sql.return_value.one.return_value = (
        "postgres",
        "openslate_runtime",
        "another-cluster",
    )

    with pytest.raises(RuntimeError, match="matching live database identity"):
        _guard_for_test(_TestItem(), url)


def test_a_refused_guard_is_never_reused_within_a_test(disposable_target, monkeypatch):
    from tests import conftest

    url, facts = disposable_target
    monkeypatch.setattr(conftest, "_OWNERSHIP_CACHE", {})
    item = _TestItem()
    facts["volume"]["Labels"]["openslate.test.run"] = "other-run"

    for _attempt in range(2):
        with pytest.raises(RuntimeError, match="live runner-owned"):
            _guard_for_test(item, url)


def test_runtime_database_guard_rechecks_live_database_ownership(disposable_target):
    url, facts = disposable_target
    runtime = frozenset({"openslate_runtime"})
    assert_runner_database_url(url, dict(os.environ), allowed_roles=runtime)
    facts["volume"]["Labels"]["openslate.test.run"] = "other-run"
    with pytest.raises(RuntimeError, match="live runner-owned instance"):
        assert_runner_database_url(url, dict(os.environ), allowed_roles=runtime)


@pytest.mark.parametrize(
    ("database", "user", "cluster"),
    [
        ("other", "openslate_runtime", True),
        ("openslate", "other", True),
        ("openslate", "openslate_runtime", False),
    ],
)
def test_test_mode_connected_identity_must_match_before_write(
    disposable_target, database, user, cluster
):
    url, facts = disposable_target
    target = instance_target_for_process(url, "openslate_runtime", os.environ)
    connection = facts["connection"]
    connection.exec_driver_sql.return_value.one.return_value = (
        database,
        user,
        target.cluster_name if cluster else "other-cluster",
    )
    with pytest.raises(RuntimeError, match="matching live database identity"):
        _guard_integration_database(url)


def test_disposable_supabase_starts_pinned_compose_and_writes_private_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tests import supabase_runtime

    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        ports = iter((49152, 49153, 49154, 49155))
        monkeypatch.setattr(supabase_runtime, "_available_port", lambda: next(ports))
        commands: list[list[str]] = []

        def compose(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            commands.append(arguments)
            mapping = {"db": 49152, "api-gw": 49153, "mailpit": 49154}
            mapped = (
                49155
                if arguments[-1] == "8001"
                else mapping.get(arguments[1] if len(arguments) > 1 else "")
            )
            output = f"127.0.0.1:{mapped}\n" if arguments[0] == "port" else ""
            return subprocess.CompletedProcess(arguments, 0, output)

        monkeypatch.setattr(runtime, "_pull_images", lambda: None)
        monkeypatch.setattr(runtime, "_compose", compose)
        monkeypatch.setattr(runtime, "_free_network_block", lambda: 7)
        monkeypatch.setattr(
            runtime,
            "_ownership",
            lambda: {
                "project": runtime.project,
                "service_ids": {"db": "b" * 64},
                "db_port": runtime.port,
                "api_port": runtime.api_port,
                "mail_port": runtime.mail_port,
                "publisher_port": runtime.publisher_port,
            },
        )
        monkeypatch.setattr(runtime, "_inspect_json", lambda _: [{"Name": f"/{runtime.container}"}])
        checked = []
        monkeypatch.setattr(runtime, "assert_cluster_identity", lambda: checked.append(True))
        runtime.start()
        manifest = runtime.write_manifest()

    assert commands[0] == ["config", "--quiet"]
    assert commands[1] == ["create"]
    assert commands[2] == ["up", "-d", "--wait", "--wait-timeout", "180"]
    assert "subnet: 10.199.7.0/27" in runtime.overlay_file.read_text()
    assert {tuple(command) for command in commands if command[0] == "port"} == {
        ("port", "db", "5432"),
        ("port", "api-gw", "8000"),
        ("port", "mailpit", "8025"),
        ("port", "api-gw", "8001"),
    }
    assert checked == [True]
    assert runtime.env_file.stat().st_mode & 0o077 == 0
    assert runtime.overlay_file.stat().st_mode & 0o077 == 0
    assert manifest.stat().st_mode & 0o077 == 0
    contents = json.loads(manifest.read_text(encoding="utf-8"))
    assert contents["version"] == 2
    assert contents["provider"]["auth_issuer"] == "http://127.0.0.1:49153/auth/v1"
    assert contents["provider"]["storage_url"] == "http://127.0.0.1:49153/storage/v1"
    assert contents["provider"]["publish_url"] == "http://127.0.0.1:49155/realtime/v1/api/broadcast"
    assert contents["container_runtime"]["url"].endswith("@db:5432/postgres")
    assert all(urlsplit(url).path == "/postgres" for url in contents["urls"])
    assert not any(runtime.keys["SUPABASE_SECRET_KEY"] in str(command) for command in commands)


def test_disposable_supabase_rejects_wrong_live_cluster_before_migrations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        monkeypatch.setattr(
            runtime,
            "_run",
            lambda arguments, **_: subprocess.CompletedProcess(
                arguments, 0, "postgres|postgres|other-cluster\n"
            ),
        )
        with pytest.raises(RuntimeError, match="cluster identity"):
            runtime.assert_cluster_identity()


def test_disposable_supabase_rejects_non_loopback_provider_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tests import supabase_runtime

    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        ports = iter((49152, 49153, 49154, 49155))
        monkeypatch.setattr(supabase_runtime, "_available_port", lambda: next(ports))
        monkeypatch.setattr(
            runtime,
            "_compose",
            lambda arguments, **_: subprocess.CompletedProcess(
                arguments, 0, "0.0.0.0:49152\n" if arguments[0] == "port" else ""
            ),
        )
        monkeypatch.setattr(runtime, "_pull_images", lambda: None)
        monkeypatch.setattr(runtime, "_free_network_block", lambda: 7)
        with pytest.raises(RuntimeError, match="unexpected host port"):
            runtime.start()


@pytest.mark.parametrize("unowned", ["container", "container-id", "network", "volume"])
def test_disposable_supabase_never_removes_unowned_resources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, unowned: str
) -> None:
    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        commands: list[list[str]] = []
        labels = {"openslate.test.run": runtime.run_id, "openslate.test.worktree": runtime.worktree}

        def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            commands.append(arguments)
            output = (
                "b" * 64 + "\n"
                if unowned in {"container", "container-id"} and arguments[0] == "ps"
                else ""
            )
            return subprocess.CompletedProcess(arguments, 0, output)

        def inspect(arguments: list[str]) -> list[dict[str, object]]:
            if arguments[0] == "inspect":
                if unowned == "container-id":
                    return [
                        {
                            "Id": "c" * 64,
                            "Config": {
                                "Image": PROVIDER_IMAGES["db"],
                                "Labels": {
                                    **labels,
                                    "com.docker.compose.project": runtime.project,
                                    "com.docker.compose.service": "db",
                                    "com.docker.compose.project.working_dir": str(
                                        runtime.worktree + "/infra/supabase"
                                    ),
                                },
                            },
                        }
                    ]
                return [{"Config": {"Image": "postgres:17", "Labels": labels}}]
            if arguments[0] == "volume":
                if unowned != "volume":
                    raise subprocess.CalledProcessError(1, arguments)
                return [
                    {
                        "Name": runtime.volume,
                        "Labels": {
                            **labels,
                            "com.docker.compose.project": runtime.project,
                            "com.docker.compose.volume": "wrong-volume",
                        },
                    }
                ]
            if unowned != "network":
                raise subprocess.CalledProcessError(1, arguments)
            return [
                {
                    "Name": f"{runtime.project}_provider",
                    "Labels": {
                        **labels,
                        "com.docker.compose.project": runtime.project,
                        "com.docker.compose.network": "wrong-network",
                    },
                }
            ]

        monkeypatch.setattr(runtime, "_run", command)
        monkeypatch.setattr(runtime, "_inspect_json", inspect)
        with pytest.raises(RuntimeError, match="unowned"):
            runtime.stop()
    assert not any(
        arguments[0] == "rm"
        or arguments[:2] == ["volume", "rm"]
        or arguments[:2] == ["network", "rm"]
        for arguments in commands
    )


def test_disposable_supabase_cleans_only_owned_partial_resources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        commands: list[list[str]] = []
        labels = {
            "openslate.test.run": runtime.run_id,
            "openslate.test.worktree": runtime.worktree,
            "com.docker.compose.project": runtime.project,
        }

        def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            commands.append(arguments)
            return subprocess.CompletedProcess(arguments, 0, "")

        def inspect(arguments: list[str]) -> list[dict[str, object]]:
            if arguments[:2] == ["volume", "inspect"] and arguments[2] == runtime.volume:
                return [
                    {
                        "Name": runtime.volume,
                        "Labels": {**labels, "com.docker.compose.volume": "supabase-db-data"},
                    }
                ]
            if arguments[:2] == ["network", "inspect"] and arguments[2] == runtime.network:
                return [
                    {
                        "Name": runtime.network,
                        "Labels": {**labels, "com.docker.compose.network": "provider"},
                    }
                ]
            raise subprocess.CalledProcessError(1, arguments)

        monkeypatch.setattr(runtime, "_run", command)
        monkeypatch.setattr(runtime, "_inspect_json", inspect)
        runtime.stop()
    assert ["volume", "rm", runtime.volume] in commands
    assert ["network", "rm", runtime.network] in commands
    assert not any(arguments[0] == "rm" for arguments in commands)


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
    manifest.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "urls": ["postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55322/openslate"],
                "container_runtime": {
                    "url": database_url,
                    "network": network or f"openslate-app-e2e-{run_id}",
                    "alias": "openslate-postgres",
                    "port": 5432,
                },
            }
        ),
        encoding="utf-8",
    )
    manifest.chmod(mode)
    return database_url, {
        "ENVIRONMENT": "test",
        "E2E_ALLOW_MUTATIONS": "true",
        "OPENSLATE_FULLSTACK_RUN_ID": run_id,
        "OPENSLATE_TEST_DATABASE_MANIFEST": str(manifest),
    }


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
