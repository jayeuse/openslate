"""Live ownership proof for the runner's disposable PostgreSQL instance."""

from __future__ import annotations

import json
import re
import stat
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

SUPABASE_DB_IMAGE = (
    "supabase/postgres:17.11.0.004@sha256:"
    "6058a6759ab9268cff8ee70641d61f1bd75953316281b76427cf5a6b4db2eafc"
)
POSTGRES_IMAGE = SUPABASE_DB_IMAGE
PROVIDER_IMAGES = {
    "db": SUPABASE_DB_IMAGE,
    "auth": (
        "supabase/gotrue:v2.196.0@sha256:"
        "c0c25187a6b835e65a6f6e6c6b39d090e832d40e6de5186f2c038e0411944232"
    ),
    "imgproxy": (
        "darthsim/imgproxy:v3.31.4@sha256:"
        "73c5dda13199745b0d2d00e4149d4a589c5b2e205dbf335ca05eca8276b54712"
    ),
    "provider-volume-init": (
        "supabase/storage-api:v1.81.0@sha256:"
        "98ffec5d0678803783c30e404c27f4ec65e97efbe014088f2a86b4b8b54b9f54"
    ),
    "storage": (
        "supabase/storage-api:v1.81.0@sha256:"
        "98ffec5d0678803783c30e404c27f4ec65e97efbe014088f2a86b4b8b54b9f54"
    ),
    "meta": (
        "supabase/postgres-meta:v0.100.0@sha256:"
        "145325b7e39f8ef4931d6e8cfd3f6f4d655de09d72a2ccc96d9513542c2202bd"
    ),
    "studio": (
        "supabase/studio:2026.10.05-sha-94b8b06@sha256:"
        "d878dcd9dba73b66d1c2c19aeaf53d07704e71604d93013225be1d1c51475237"
    ),
    "api-gw": (
        "envoyproxy/envoy:v1.39.1@sha256:"
        "57e14a549d7bd43c8d3f6d03e8cfa653e037d4b38e133acd9b54f38c524401b4"
    ),
    "mailpit": (
        "axllent/mailpit:v1.27.9@sha256:"
        "b004cc0672d0692f097ba8ab9e5956ae08eeafee3d0a6bf2ab239750101ac538"
    ),
}
PROVIDER_VOLUMES = (
    "supabase-db-data",
    "supabase-db-config",
    "supabase-storage-data",
    "supabase-studio-snippets",
)
PROVIDER_NETWORKS = (
    "provider", "operator", "studio-ingress", "mail-egress", "gateway-host", "db-host"
)
PROVIDER_BIND_MOUNTS = {
    "db": (
        ("upstream/db/realtime.sql", "/docker-entrypoint-initdb.d/migrations/99-realtime.sql"),
        ("upstream/db/webhooks.sql", "/docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql"),
        ("upstream/db/roles.sql", "/docker-entrypoint-initdb.d/init-scripts/99-roles.sql"),
        ("upstream/db/jwt.sql", "/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql"),
        ("upstream/db/_supabase.sql", "/docker-entrypoint-initdb.d/migrations/97-_supabase.sql"),
        ("upstream/db/logs.sql", "/docker-entrypoint-initdb.d/migrations/99-logs.sql"),
        ("upstream/db/pooler.sql", "/docker-entrypoint-initdb.d/migrations/99-pooler.sql"),
    ),
    "api-gw": (
        ("upstream/envoy/envoy.yaml", "/etc/envoy/envoy.yaml"),
        ("upstream/envoy/cds.yaml", "/etc/envoy/cds.yaml"),
        ("upstream/envoy/lds.template.yaml", "/etc/envoy/lds.template.yaml"),
        ("upstream/envoy/docker-entrypoint.sh", "/docker-entrypoint.sh"),
    ),
}
_RUN_ID = re.compile(r"[a-f0-9]{32}\Z")
_DOCKER_ID = re.compile(r"[a-f0-9]{12,64}\Z")
_ROLES = frozenset({"supabase_admin", "openslate_owner", "openslate_runtime"})


class DisposableTargetError(ValueError):
    """A test process cannot prove ownership of its database target."""


@dataclass(frozen=True, slots=True)
class DisposableTarget:
    run_id: str
    host: str
    port: int
    database: str
    cluster_name: str
    manifest_path: Path


def _valid_id_map(value: object, names: set[str]) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == names
        and all(isinstance(item, str) and _DOCKER_ID.fullmatch(item) for item in value.values())
    )


def _provider_endpoints(ownership: dict[str, Any]) -> dict[str, str]:
    api_url = f"http://127.0.0.1:{ownership['api_port']}"
    return {
        "api_url": api_url,
        "auth_issuer": f"{api_url}/auth/v1",
        "storage_url": f"{api_url}/storage/v1",
        "mail_url": f"http://127.0.0.1:{ownership['mail_port']}",
    }


def load_disposable_target(
    database_url: str,
    expected_user: str,
    process: Mapping[str, str],
    *,
    repository_root: Path,
    inspect: Callable[[list[str]], Any],
) -> DisposableTarget:
    """Require a private per-run manifest and a live installation for host connections."""
    run_id = process.get("OPENSLATE_FULLSTACK_RUN_ID", "")
    if (
        process.get("ENVIRONMENT") != "test"
        or process.get("E2E_ALLOW_MUTATIONS") != "true"
        or _RUN_ID.fullmatch(run_id) is None
        or expected_user not in _ROLES
    ):
        raise DisposableTargetError("Disposable test identity is unavailable")
    try:
        path = Path(process["OPENSLATE_TEST_DATABASE_MANIFEST"])
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise ValueError
        manifest = json.loads(path.read_text(encoding="utf-8"))
        ownership = manifest["ownership"]
        project = f"openslate-e2e-{run_id}"
        worktree = str(repository_root.resolve())
        if (
            manifest.get("version") != 2
            or manifest.get("run_id") != run_id
            or not isinstance(manifest.get("urls"), list)
            or not isinstance(ownership, dict)
            or set(ownership)
            != {
                "project",
                "worktree",
                "compose_directory",
                "service_ids",
                "network_ids",
                "db_port",
                "api_port",
                "mail_port",
                "cluster_name",
            }
            or ownership["project"] != project
            or not isinstance(ownership["worktree"], str)
            or not ownership["worktree"]
            or not isinstance(ownership["compose_directory"], str)
            or not ownership["compose_directory"]
            or ownership["cluster_name"] != project
            or not _valid_id_map(ownership["service_ids"], set(PROVIDER_IMAGES))
            or not _valid_id_map(ownership["network_ids"], set(PROVIDER_NETWORKS))
            or not all(
                isinstance(ownership[key], int) and 1 <= ownership[key] <= 65535
                for key in ("db_port", "api_port", "mail_port")
            )
            or len({ownership["db_port"], ownership["api_port"], ownership["mail_port"]}) != 3
            or manifest.get("provider") != _provider_endpoints(ownership)
        ):
            raise ValueError
        endpoints = _provider_endpoints(ownership)
        url = make_url(database_url)
        parts = urlsplit(database_url)
        if (
            url.drivername != "postgresql+psycopg"
            or url.username != expected_user
            or not url.password
            or url.database != "postgres"
            or parts.query
            or parts.fragment
        ):
            raise ValueError
        host_target = (
            parts.hostname == "127.0.0.1"
            and parts.port == ownership["db_port"]
            and database_url in manifest["urls"]
        )
        container_url = manifest.get("container_runtime")
        container_target = (
            expected_user == "openslate_runtime"
            and parts.hostname == "db"
            and parts.port == 5432
            and container_url
            == {
                "url": database_url,
                "network": f"{project}_provider",
                "alias": "db",
                "port": 5432,
            }
            and Path("/.dockerenv").is_file()
            and any(
                (host := make_url(value)).username == "openslate_runtime"
                and host.password == url.password
                and host.host == "127.0.0.1"
                and host.port == ownership["db_port"]
                and host.database == "postgres"
                and not host.query
                for value in manifest["urls"]
            )
        )
        if not host_target and not container_target:
            raise ValueError
        # Host admission verifies the live Compose checkout. A container image has
        # its own filesystem layout; its private runtime manifest is created only
        # after that host check, and the connected cluster identity is still checked.
        if host_target and (
            ownership["worktree"] != worktree
            or ownership["compose_directory"] != str(repository_root.resolve() / "infra/supabase")
        ):
            raise ValueError
        accepted_api = endpoints["api_url"] if host_target else "http://api-gw:8000"
        accepted_storage = (
            endpoints["storage_url"] if host_target else "http://api-gw:8000/storage/v1"
        )
        if (
            process.get("SUPABASE_URL") != accepted_api
            or process.get("SUPABASE_AUTH_ISSUER") != endpoints["auth_issuer"]
            or process.get("SUPABASE_STORAGE_URL") != accepted_storage
        ):
            raise ValueError
    except (KeyError, OSError, TypeError, ValueError, AttributeError, SQLAlchemyError):
        raise DisposableTargetError("Disposable test manifest does not match the target") from None
    if host_target:
        assert_live_disposable_ownership(ownership, run_id, inspect)
    return DisposableTarget(
        run_id=run_id,
        host="127.0.0.1" if host_target else "db",
        port=ownership["db_port"] if host_target else 5432,
        database="postgres",
        cluster_name=project,
        manifest_path=path,
    )


def _accepted_bind_sources(compose_directory: str, relative: str) -> set[str]:
    source = str((Path(compose_directory) / relative).resolve())
    accepted = {source}
    if source.startswith("/"):
        accepted.add(f"/host_mnt{source}")
    normalized = source.replace("\\", "/")
    if re.match(r"^[a-zA-Z]:/", normalized):
        drive = normalized[0].lower()
        suffix = normalized[2:]
        accepted.add(f"/run/desktop/mnt/host/{drive}{suffix}")
        accepted.add(f"/host_mnt/{drive}{suffix}")
    return accepted


def _inspect_named_resources(
    inspect: Callable[[list[str]], Any], resource_type: str, names: tuple[str, ...]
) -> dict[str, dict[str, Any]]:
    resources = inspect([resource_type, "inspect", *names])
    if not isinstance(resources, list) or len(resources) != len(names):
        raise ValueError
    by_name = {resource["Name"]: resource for resource in resources}
    if len(by_name) != len(resources) or set(by_name) != set(names):
        raise ValueError
    return by_name


def assert_live_disposable_ownership(
    ownership: dict[str, Any], run_id: str, inspect: Callable[[list[str]], Any]
) -> None:
    """Recheck provider containers, ports, networks, and durable volumes before writes."""
    try:
        project = ownership["project"]
        worktree = ownership["worktree"]
        service_ids = ownership["service_ids"]
        project_ids = inspect(
            [
                "ps", "-a", "-q", "--no-trunc", "--filter",
                f"label=com.docker.compose.project={project}",
            ]
        )
        if (
            not isinstance(project_ids, list)
            or len(project_ids) != len(service_ids)
            or set(project_ids) != set(service_ids.values())
        ):
            raise ValueError
        inspected = inspect(["inspect", *service_ids.values()])
        containers = {container["Id"]: container for container in inspected}
        if set(containers) != set(service_ids.values()):
            raise ValueError
        labels = {"openslate.test.run": run_id, "openslate.test.worktree": worktree}
        for service, identifier in service_ids.items():
            container = containers[identifier]
            actual_labels = container["Config"]["Labels"]
            state = container["State"]
            expected_state = (
                state["Running"] is False and state["ExitCode"] == 0
                if service == "provider-volume-init"
                else state["Running"] is True
            )
            if not (
                expected_state
                and container["Config"]["Image"] == PROVIDER_IMAGES[service]
                and actual_labels.get("com.docker.compose.project") == project
                and actual_labels.get("com.docker.compose.service") == service
                and actual_labels.get("com.docker.compose.project.working_dir")
                == ownership["compose_directory"]
                and all(actual_labels.get(key) == value for key, value in labels.items())
            ):
                raise ValueError
        network_names = tuple(f"{project}_{name}" for name in PROVIDER_NETWORKS)
        networks = _inspect_named_resources(inspect, "network", network_names)
        for name in PROVIDER_NETWORKS:
            network = networks[f"{project}_{name}"]
            actual_labels = network["Labels"]
            if not (
                network["Id"] == ownership["network_ids"][name]
                and network["Name"] == f"{project}_{name}"
                and actual_labels.get("com.docker.compose.project") == project
                and actual_labels.get("com.docker.compose.network") == name
                and all(actual_labels.get(key) == value for key, value in labels.items())
                and network["Internal"] is (name in {"provider", "operator", "studio-ingress"})
            ):
                raise ValueError
        volume_names = tuple(f"{project}_{name}" for name in PROVIDER_VOLUMES)
        volumes = _inspect_named_resources(inspect, "volume", volume_names)
        for name in PROVIDER_VOLUMES:
            volume = volumes[f"{project}_{name}"]
            actual_labels = volume["Labels"]
            if not (
                volume["Name"] == f"{project}_{name}"
                and actual_labels.get("com.docker.compose.project") == project
                and actual_labels.get("com.docker.compose.volume") == name
                and all(actual_labels.get(key) == value for key, value in labels.items())
            ):
                raise ValueError
        expected_networks = {
            service: {"provider"} for service in PROVIDER_IMAGES if service != "mailpit"
        }
        expected_networks["db"].update({"operator", "db-host"})
        expected_networks["auth"].add("mail-egress")
        expected_networks["meta"] = {"operator"}
        expected_networks["studio"] = {"operator", "studio-ingress"}
        expected_networks["api-gw"].update({"studio-ingress", "gateway-host"})
        expected_networks["mailpit"] = {"mail-egress"}
        for service, names in expected_networks.items():
            attached = containers[service_ids[service]]["NetworkSettings"]["Networks"]
            if set(attached) != {f"{project}_{name}" for name in names}:
                raise ValueError
            for name in names:
                if attached[f"{project}_{name}"]["NetworkID"] != ownership["network_ids"][name]:
                    raise ValueError
        expected_mounts = {
            ("db", "supabase-db-data", "/var/lib/postgresql/data"),
            ("db", "supabase-db-config", "/etc/postgresql-custom"),
            ("imgproxy", "supabase-storage-data", "/var/lib/storage"),
            ("provider-volume-init", "supabase-storage-data", "/var/lib/storage"),
            ("provider-volume-init", "supabase-studio-snippets", "/app/snippets"),
            ("storage", "supabase-storage-data", "/var/lib/storage"),
            ("studio", "supabase-studio-snippets", "/app/snippets"),
        }
        actual_mounts = [
            (service, mount.get("Name"), mount.get("Destination"), mount.get("RW"))
            for service, identifier in service_ids.items()
            for mount in containers[identifier]["Mounts"]
            if mount.get("Type") == "volume"
        ]
        expected_volumes = {
            (service, f"{project}_{volume}", destination, service != "imgproxy")
            for service, volume, destination in expected_mounts
        }
        if len(actual_mounts) != len(expected_volumes) or set(actual_mounts) != expected_volumes:
            raise ValueError
        expected_binds = {
            (service, destination): _accepted_bind_sources(
                ownership["compose_directory"], relative
            )
            for service, mounts in PROVIDER_BIND_MOUNTS.items()
            for relative, destination in mounts
        }
        actual_binds = [
            (service, mount)
            for service, identifier in service_ids.items()
            for mount in containers[identifier]["Mounts"]
            if mount.get("Type") == "bind"
        ]
        if len(actual_binds) != len(expected_binds):
            raise ValueError
        for service, mount in actual_binds:
            key = (service, mount.get("Destination"))
            if (
                key not in expected_binds
                or mount.get("Source") not in expected_binds[key]
                or mount.get("RW") is not False
            ):
                raise ValueError
        if len({(service, mount.get("Destination")) for service, mount in actual_binds}) != len(
            expected_binds
        ):
            raise ValueError
        if any(
            mount.get("Type") not in {"volume", "bind"}
            for identifier in service_ids.values()
            for mount in containers[identifier]["Mounts"]
        ):
            raise ValueError
        expected_ports = {
            "db": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(ownership["db_port"])}]},
            "api-gw": {
                "8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(ownership["api_port"])}]
            },
            "mailpit": {
                "8025/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(ownership["mail_port"])}]
            },
        }
        for service, identifier in service_ids.items():
            published = {
                port: bindings
                for port, bindings in containers[identifier]["NetworkSettings"]["Ports"].items()
                if bindings
            }
            if published != expected_ports.get(service, {}):
                raise ValueError
    except (IndexError, KeyError, TypeError, ValueError, AttributeError):
        raise DisposableTargetError("Live disposable Supabase ownership does not match") from None
