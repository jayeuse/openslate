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

POSTGRES_IMAGE = (
    "postgres:17@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232"
)
_RUN_ID = re.compile(r"[a-f0-9]{32}\Z")
_DOCKER_ID = re.compile(r"[a-f0-9]{64}\Z")
_ROLES = frozenset({"postgres", "openslate_owner", "openslate_runtime", "openslate_inspector"})


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


def load_disposable_target(
    database_url: str,
    expected_user: str,
    process: Mapping[str, str],
    *,
    repository_root: Path,
    inspect: Callable[[list[str]], Any],
) -> DisposableTarget:
    """Require an exact private manifest, then independently inspect the host target."""
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
        url = make_url(database_url)
        parts = urlsplit(database_url)
        ownership = manifest["ownership"]
        port = ownership["host_port"]
        container = f"openslate-postgres-e2e-{run_id}"
        network = f"openslate-app-e2e-{run_id}"
        volume = f"openslate-postgres-data-e2e-{run_id}"
        worktree = ownership["worktree"]
        if (
            manifest["run_id"] != run_id
            or not isinstance(manifest["urls"], list)
            or url.drivername != "postgresql+psycopg"
            or url.username != expected_user
            or not url.password
            or url.database != "openslate"
            or parts.query
            or parts.fragment
            or not isinstance(port, int)
            or not 1 <= port <= 65535
            or not isinstance(worktree, str)
            or not Path(worktree).is_absolute()
            or ownership
            != {
                "container_id": ownership["container_id"],
                "container": container,
                "network": network,
                "network_id": ownership["network_id"],
                "volume": volume,
                "host_port": port,
                "image": POSTGRES_IMAGE,
                "cluster_name": container,
                "worktree": worktree,
            }
            or _DOCKER_ID.fullmatch(ownership["container_id"]) is None
            or _DOCKER_ID.fullmatch(ownership["network_id"]) is None
        ):
            raise ValueError
        host_target = (
            parts.hostname == "127.0.0.1"
            and parts.port == port
            and database_url in manifest["urls"]
            and worktree == str(repository_root.resolve())
        )
        runtime_hosts = [make_url(value) for value in manifest["urls"]]
        container_target = (
            expected_user == "openslate_runtime"
            and parts.hostname == "openslate-postgres"
            and parts.port == 5432
            and manifest.get("container_runtime")
            == {
                "url": database_url,
                "network": network,
                "alias": "openslate-postgres",
                "port": 5432,
            }
            and Path("/.dockerenv").is_file()
            and any(
                host.username == "openslate_runtime"
                and host.password == url.password
                and host.host == "127.0.0.1"
                and host.port == port
                and host.database == "openslate"
                and not host.query
                for host in runtime_hosts
            )
        )
        if not host_target and not container_target:
            raise ValueError
    except (KeyError, OSError, TypeError, ValueError, AttributeError, SQLAlchemyError):
        raise DisposableTargetError("Disposable test manifest does not match the target") from None
    if host_target:
        assert_live_disposable_ownership(ownership, run_id, inspect)
    return DisposableTarget(
        run_id=run_id,
        host="127.0.0.1" if host_target else "openslate-postgres",
        port=port if host_target else 5432,
        database="openslate",
        cluster_name=container,
        manifest_path=path,
    )


def assert_live_disposable_ownership(
    ownership: dict[str, Any], run_id: str, inspect: Callable[[list[str]], Any]
) -> None:
    """Check the container, private network, port, and labeled data volume now."""
    try:
        container = inspect(["inspect", ownership["container_id"]])[0]
        network = inspect(["network", "inspect", ownership["network"]])[0]
        volume = inspect(["volume", "inspect", ownership["volume"]])[0]
        labels = {
            "openslate.test.run": run_id,
            "openslate.test.worktree": ownership["worktree"],
        }
        mounts = [
            mount for mount in container["Mounts"]
            if mount.get("Destination") == "/var/lib/postgresql/data"
        ]
        owned = (
            container["Id"] == ownership["container_id"]
            and container["Name"] == f"/{ownership['container']}"
            and container["State"]["Running"] is True
            and container["Config"]["Image"] == POSTGRES_IMAGE
            and all(
                container["Config"]["Labels"].get(key) == value for key, value in labels.items()
            )
            and len(mounts) == 1
            and mounts[0].get("Type") == "volume"
            and mounts[0].get("Name") == ownership["volume"]
            and container["NetworkSettings"]["Ports"]["5432/tcp"]
            == [{"HostIp": "127.0.0.1", "HostPort": str(ownership["host_port"])}]
            and container["NetworkSettings"]["Networks"][ownership["network"]]["NetworkID"]
            == ownership["network_id"]
            and network["Id"] == ownership["network_id"]
            and network["Internal"] is True
            and all(network["Labels"].get(key) == value for key, value in labels.items())
            and volume["Name"] == ownership["volume"]
            and all(volume["Labels"].get(key) == value for key, value in labels.items())
        )
    except (IndexError, KeyError, TypeError, ValueError, AttributeError):
        owned = False
    if not owned:
        raise DisposableTargetError("Live disposable PostgreSQL ownership does not match")
