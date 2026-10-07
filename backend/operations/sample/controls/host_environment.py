"""Owned sample topology handoff and restoration."""

from __future__ import annotations

import re
import sys
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import urlsplit
from uuid import UUID

from operations.backups.host import SERVICES, Host, Json, RunnerError, digest, physical_archive
from operations.sample.phases.actions import PhaseSubstep, SamplePhaseActionError

if TYPE_CHECKING:
    from operations.sample.controls.host_delivery import _Delivery
    from operations.sample.controls.host_verification import NativeDownloadRequest


@dataclass(frozen=True, repr=False)
class HostControlRuntime:
    host: Host
    development_env_file: Path
    origin: str
    ca_file: Path
    journal_path: Path
    capture_development: Callable[[], Mapping[str, object]]
    stop_api: Callable[[Mapping[str, object]], None]
    start_api: Callable[[Mapping[str, object]], None]
    permission_probe: Callable[[], None]
    native_delivery: Callable[[NativeDownloadRequest], Mapping[str, object]]
    reconciliation: dict[str, object] = field(default_factory=dict, init=False)


def require(valid: bool, step: str) -> None:
    if not valid:
        raise SamplePhaseActionError("Host control prerequisite or proof differs", step=step)


def runner(runtime: HostControlRuntime, mode: str) -> Json:
    """Invoke the existing registered-child CLI without alternative archive functions."""
    import json

    host = runtime.host
    args = [
        sys.executable,
        str(Path(__file__).resolve().parents[2] / "backup_runner.py"),
        mode,
        "--backup-config",
        str(host.config_path),
        "--state-directory",
        str(host.state_directory),
    ]
    try:
        body = json.loads(host.command(args, failure="host_runner", timeout=7200))
    except (OSError, ValueError, RunnerError):
        raise SamplePhaseActionError(
            "Host runner outcome is not confirmed", step="host_runner"
        ) from None
    require(isinstance(body, dict) and "code" not in body, "host_runner")
    return cast(Json, body)


def admit_development(runtime: HostControlRuntime) -> Json:
    """Observe through the trusted guarded callback; idle is an entry condition only."""
    try:
        before = dict(runtime.capture_development())
        runtime.permission_probe()
        host, physical = runtime.host, physical_archive()
        host.config = physical.parse_config(host.config_path)
        for path, label, directory in (
            (host.config_path, "host config", False),
            (host.state_directory, "host state", True),
            (runtime.development_env_file, "original development environment", False),
            (runtime.ca_file, "owned HTTPS certificate", False),
        ):
            physical._private(path, label, directory=directory)
        origin = urlsplit(runtime.origin)
        require(
            origin.scheme == "https"
            and origin.hostname in {"localhost", "127.0.0.1", "::1"}
            and not origin.username
            and not origin.password
            and origin.path in {"", "/"}
            and not origin.query
            and not origin.fragment,
            "host_origin",
        )
        require(
            host.config.deployment == "production"
            and before.get("instance_id")
            == before.get("cluster_name")
            == host.config.installation_id
            and before.get("project") == host.config.project_name,
            "host_development",
        )
        require(
            all(
                isinstance(before.get(key), str)
                and re.fullmatch(r"[0-9a-f]{64}", cast(str, before[key]))
                for key in ("api_identity", "production_api_identity")
            ),
            "host_development",
        )
        for key in ("owner_user_id", "owner_provider_user_id"):
            require(str(UUID(str(before.get(key)))) == before.get(key), "host_development")
        observed = datetime.fromisoformat(str(before.get("observed_at")).replace("Z", "+00:00"))
        require(observed.utcoffset() is not None, "host_development")
        require(
            all(
                type(before.get(k)) is int and before[k] == 0
                for k in ("pending_exports", "unresolved_runs")
            ),
            "host_idle",
        )
        require(not tuple(host.state_directory.iterdir()), "host_state")
        process = before.get("api_process")
        require(
            isinstance(process, dict)
            and type(process.get("pid")) is int
            and process["pid"] > 0
            and bool(process.get("argv_sha256"))
            and bool(process.get("cwd"))
            and process.get("env_source_sha256") == digest(runtime.development_env_file),
            "host_process",
        )
        _survivors(host, before)
        _original_rows(host, before)
        return cast(Json, deepcopy(before))
    except SamplePhaseActionError:
        raise
    except (OSError, ValueError, TypeError, KeyError, RunnerError, physical_archive().BackupError):
        raise SamplePhaseActionError(
            "Original host admission failed", step="host_development"
        ) from None


def _fingerprint(host: Host, row: Json) -> tuple[object, ...]:
    return (
        row.get("Id"),
        row.get("Image"),
        row.get("Config", {}).get("Image"),
        host.labels(row),
        row.get("Mounts"),
        tuple(
            sorted(
                (name, network.get("NetworkID"))
                for name, network in row.get("NetworkSettings", {}).get("Networks", {}).items()
            )
        ),
    )


def _original_rows(host: Host, before: Json) -> list[Json]:
    expected = before.get("containers")
    require(isinstance(expected, list) and bool(expected), "host_containers")
    rows = [
        r
        for r in host.inventory()
        if host.labels(r).get("com.docker.compose.project") == host.config.project_name
    ]
    require(
        len(rows) == len(cast(list[Json], expected))
        and len({r.get("Id") for r in rows}) == len(rows),
        "host_containers",
    )
    by_id = {r.get("Id"): r for r in cast(list[Json], expected)}
    require(
        all(
            r.get("Id") in by_id
            and _fingerprint(host, r) == _fingerprint(host, by_id[r["Id"]])
            and host.labels(r).get("com.docker.compose.project.working_dir")
            == str(host.config.compose_root)
            for r in rows
        ),
        "host_containers",
    )
    host.check_readers(host.inventory(), {r["Id"] for r in rows})
    return rows


def _survivors(host: Host, before: Json) -> None:
    expected = before.get("provider_volumes")
    require(isinstance(expected, dict) and len(expected) == 4, "host_volumes")
    names = sorted(cast(dict[str, Any], expected))
    require(all(n.startswith(host.config.project_name + "_") for n in names), "host_volumes")
    rows = host.docker_json(["volume", "inspect", *names])
    require(
        isinstance(rows, list)
        and {r.get("Name") for r in rows} == set(names)
        and {r["Name"]: r for r in rows} == expected,
        "host_volumes",
    )
    network = host.docker_json(["network", "inspect", host.config.project_name + "_provider"])
    require(
        isinstance(network, list)
        and len(network) == 1
        and network[0].get("Id") == before.get("provider_network_id")
        and network[0].get("Labels", {}).get("com.docker.compose.project")
        == host.config.project_name
        and network[0].get("Labels", {}).get("com.docker.compose.network") == "provider",
        "host_network",
    )


def _remove(host: Host, captured: list[Json]) -> None:
    ids = [r["Id"] for r in captured]
    current = host.docker_json(["container", "inspect", *ids])
    require(
        isinstance(current, list)
        and len(current) == len(captured)
        and {_fingerprint_key(host, r) for r in current}
        == {_fingerprint_key(host, r) for r in captured},
        "host_containers",
    )
    host.command(["docker", "stop", "--time", "10", *ids], failure="host_stop", timeout=180)
    current = host.docker_json(["container", "inspect", *ids])
    require(
        isinstance(current, list)
        and len(current) == len(ids)
        and all(r.get("State", {}).get("Status") == "exited" for r in current)
        and {_fingerprint_key(host, r) for r in current}
        == {_fingerprint_key(host, r) for r in captured},
        "host_containers",
    )
    host.command(["docker", "container", "rm", *ids], failure="host_remove", timeout=180)


def _fingerprint_key(host: Host, row: Json) -> str:
    import json

    return json.dumps(_fingerprint(host, row), sort_keys=True)


def _settled(runtime: HostControlRuntime) -> None:
    host = runtime.host
    host.admit()
    active = host.active()
    if active is not None:
        runner(runtime, "recover")
    else:
        pending = host.bridge({"op": "inspect"}).get("unresolved")
        exported = host.bridge({"op": "inspect-export"}).get("unresolved")
        if pending is not None or exported is not None:
            runner(runtime, "recover")
    require(
        host.active() is None
        and host.bridge({"op": "inspect"}).get("unresolved") is None
        and host.bridge({"op": "inspect-export"}).get("unresolved") is None,
        "host_recovery",
    )


def _restore(runtime: HostControlRuntime, before: Json, admitted: bool) -> None:
    host = runtime.host
    if admitted:
        _settled(runtime)
    rows = [
        r
        for r in host.inventory()
        if host.labels(r).get("com.docker.compose.project") == host.config.project_name
    ]
    require(
        all(
            host.labels(r).get("com.docker.compose.service") in SERVICES
            and host.labels(r).get("com.docker.compose.project.working_dir")
            == str(host.config.compose_root)
            for r in rows
        ),
        "host_restore",
    )
    if rows:
        host.check_readers(host.inventory(), {r["Id"] for r in rows})
        _remove(host, rows)
    _survivors(host, before)
    root = Path(__file__).resolve().parents[4]
    host.command(
        [
            sys.executable,
            str(root / "scripts/dev.py"),
            "db",
            "--env-file",
            str(runtime.development_env_file),
        ],
        failure="host_restore",
        timeout=180,
    )
    runtime.start_api(before)
    restored = dict(runtime.capture_development())
    require(
        all(
            restored.get(k) == before.get(k)
            for k in (
                "instance_id",
                "cluster_name",
                "project",
                "owner_user_id",
                "owner_provider_user_id",
                "api_identity",
                "provider_network_id",
                "provider_volumes",
            )
        ),
        "host_restore",
    )
    process = restored.get("api_process")
    require(
        isinstance(process, dict)
        and all(
            process.get(k) == before["api_process"].get(k)
            for k in ("argv_sha256", "cwd", "env_source_sha256")
        ),
        "host_restore",
    )
    _survivors(host, before)
    require(
        digest(runtime.development_env_file) == before["api_process"]["env_source_sha256"],
        "host_restore",
    )
    runtime.reconciliation.update(
        development_restored=True,
        pending_exports=restored.get("pending_exports"),
        unresolved_runs=restored.get("unresolved_runs"),
    )


@contextmanager
def production_topology(
    runtime: HostControlRuntime, on_substep: PhaseSubstep | None = None
) -> Iterator[Host]:
    before = admit_development(runtime)
    host, stopped, removed, admitted = runtime.host, False, False, False
    failure: SamplePhaseActionError | None = None
    runtime.reconciliation.clear()
    runtime.reconciliation["development_restored"] = False
    try:
        if on_substep is not None:
            on_substep("host_topology")
        runtime.stop_api(before)
        stopped = True
        rows = _original_rows(host, before)
        _remove(host, rows)
        removed = True
        _survivors(host, before)
        host.compose(["up", "-d", "--no-build"], failure="host_start")
        host.admit()
        _survivors(host, before)
        admitted = True
        yield host
    except SamplePhaseActionError as error:
        failure = error
        raise
    except (
        OSError,
        ValueError,
        TypeError,
        KeyError,
        AssertionError,
        RuntimeError,
        physical_archive().BackupError,
    ):
        failure = SamplePhaseActionError("Owned host transition failed", step="host_topology")
        raise failure from None
    finally:
        if stopped:
            try:
                if removed:
                    _restore(runtime, before, admitted)
                else:
                    # Do not remove uncertain rows after a partial stop/remove error.
                    _original_rows(host, before)
                    runtime.start_api(before)
                    runtime.reconciliation["development_restored"] = True
            except (
                OSError,
                ValueError,
                TypeError,
                KeyError,
                AssertionError,
                RunnerError,
                SamplePhaseActionError,
                physical_archive().BackupError,
            ):
                runtime.reconciliation["restoration_error"] = "host_restore"
                if failure is None:
                    raise SamplePhaseActionError(
                        "Host restoration is not confirmed", step="host_restore"
                    ) from None


def restore_account(run: _Delivery) -> None:
    from operations.sample.controls.mfa_verification import _factor_inventory, _group_members

    run.observed(
        "admin",
        "restore_owner_refresh",
        "POST",
        "/api/auth/refresh",
        run.admin.refresh(),
        200,
    )
    owner = run.read("admin", "restore_owner_identity", "/api/auth/me")
    require(
        all(owner.get(k) == run.owner.get(k) for k in ("id", "role", "status", "email")),
        "host_restore_account",
    )
    current = run.read("admin", "restore_actor_read", f"/api/users/{run.actor_id}")
    require(
        current.get("id") == run.actor_id
        and current.get("status") == "active"
        and current.get("role") in {"member", "admin"},
        "host_restore_account",
    )
    if current["role"] == "admin":
        run.person(
            run.read_response(
                run.request(
                    "admin",
                    "restore_actor_role",
                    "PATCH",
                    f"/api/users/{run.actor_id}",
                    body={"role": "member"},
                ),
                "restore_actor_role",
            ),
            "member",
        )
    for group in run.actor_groups:
        response = run.request(
            "admin", "restore_group_read:" + group, "GET", f"/api/access/groups/{group}"
        )
        body = run.read_response(response, "host_restore_groups")
        members = sorted(body.get("member_ids", []))
        require(
            body.get("id") == group
            and type(body.get("revision")) is int
            and response.headers.get("ETag") == f'"{group}:{body["revision"]}"',
            "host_restore_groups",
        )
        if members == run.groups[group]:
            continue
        require(
            members == [uid for uid in run.groups[group] if uid != run.actor_id],
            "host_restore_groups",
        )
        run.request(
            "admin",
            "restore_group:" + group,
            "PUT",
            f"/api/access/groups/{group}/members",
            body={"member_ids": run.groups[group]},
            headers={"If-Match": response.headers["ETag"]},
        )
    require(_group_members(run.admin) == run.groups, "host_restore_groups")
    for key, client in run.context.clients.items():
        if key == "admin":
            continue
        credential = run.credentials[key]
        run.observed(
            key,
            "restore_primary:" + key,
            "POST",
            "/api/auth/login",
            client.login(credential.email, credential.password),
            200,
        )
        identity = run.read(key, "restore_identity:" + key, "/api/auth/me")
        require(identity.get("id") == credential.user_id, "host_restore_account")
    run.person(run.read(run.action.actor_key, "restored_actor", "/api/auth/me"), "member")
    require(
        _factor_inventory(
            run.read(run.action.actor_key, "restored_factors", "/api/auth/mfa"),
            run.actor_id,
            "host_restore_account",
        )[1]
        == []
        and _factor_inventory(
            run.read("admin", "restored_owner_factors", "/api/auth/mfa"),
            run.owner_id,
            "host_restore_account",
        )[1]
        == run.owner_factors,
        "host_restore_account",
    )
    run.runtime.reconciliation["role_groups_restored"] = True
