"""Exact Docker source admission before any production claim or service stop."""

from __future__ import annotations

import time
from pathlib import Path

from operations.backup_runner_host import SERVICES, Host, Json, RunnerError, physical_archive


def admit_docker(host: Host, values: dict[str, str]) -> None:
    physical = physical_archive()
    all_containers = host.inventory()
    host.containers = [
        item
        for item in all_containers
        if host.labels(item).get("com.docker.compose.project") == host.config.project_name
    ]
    by_service: dict[str, Json] = {}
    for item in host.containers:
        labels = host.labels(item)
        service = labels.get("com.docker.compose.service", "")
        if (
            service not in SERVICES
            or service in by_service
            or labels.get("com.docker.compose.project.working_dir") != str(host.config.compose_root)
            or item.get("State", {}).get("Status") not in {"running", "exited"}
            or not isinstance(item.get("Id"), str)
            or not str(item.get("Image", "")).startswith("sha256:")
        ):
            raise RunnerError("admission_failed")
        by_service[service] = item
    if set(by_service) != SERVICES:
        raise RunnerError("admission_failed")
    actual_env = by_service["api"].get("Config", {}).get("Env")
    keys = (
        "ENVIRONMENT",
        "OPENSLATE_INSTANCE_ID",
        "DATABASE_URL",
        "POSTGRES_HOST",
        "POSTGRES_PORT",
        "POSTGRES_DATABASE",
        "PUBLIC_ORIGIN",
    )
    if not isinstance(actual_env, list) or any(
        [value for value in actual_env if isinstance(value, str) and value.startswith(key + "=")]
        != [key + "=" + values[key]]
        for key in keys
    ):
        raise RunnerError("admission_failed")
    for service, logical, destination in (
        ("db", "supabase-db-data", "/var/lib/postgresql/data"),
        ("db", "supabase-db-config", "/etc/postgresql-custom"),
        ("storage", "supabase-storage-data", "/var/lib/storage"),
        ("imgproxy", "supabase-storage-data", "/var/lib/storage"),
        ("studio", "supabase-studio-snippets", "/app/snippets"),
        ("provider-volume-init", "supabase-storage-data", "/var/lib/storage"),
        ("provider-volume-init", "supabase-studio-snippets", "/app/snippets"),
        ("caddy", "caddy-data", "/data"),
    ):
        mounted = [
            mount
            for mount in by_service[service].get("Mounts", [])
            if mount.get("Destination") == destination
        ]
        if (
            len(mounted) != 1
            or mounted[0].get("Type") != "volume"
            or mounted[0].get("Name") != host.config.project_name + "_" + logical
        ):
            raise RunnerError("admission_failed")
    images = physical._compose_images(host.config, host._physical_command)
    if (
        set(images) != SERVICES
        or any(item["Config"].get("Image") != images[name] for name, item in by_service.items())
        or any(
            "@sha256:" not in images[name]
            for name in SERVICES
            - {"provider-volume-init", "api", "scanner-worker", "clamav", "caddy"}
        )
    ):
        raise RunnerError("admission_failed")
    network = host.docker_json(["network", "inspect", host.config.project_name + "_provider"])
    if (
        not isinstance(network, list)
        or len(network) != 1
        or network[0].get("Labels", {}).get("com.docker.compose.project")
        != host.config.project_name
        or network[0].get("Labels", {}).get("com.docker.compose.network") != "provider"
        or by_service["db"]
        .get("NetworkSettings", {})
        .get("Networks", {})
        .get(host.config.project_name + "_provider", {})
        .get("NetworkID")
        != network[0].get("Id")
    ):
        raise RunnerError("admission_failed")
    volumes = physical._docker_inventory(host._physical_command, "volume", host.config.project_name)
    expected = {host.config.project_name + "_" + name for name in host.config.volume_names}
    if {item.get("Name") for item in volumes} != expected:
        raise RunnerError("admission_failed")
    for item in volumes:
        labels = item.get("Labels", {})
        if (
            labels.get("com.docker.compose.project") != host.config.project_name
            or item["Name"]
            != host.config.project_name + "_" + labels.get("com.docker.compose.volume", "")
            or host.state_directory.resolve().is_relative_to(Path(item["Mountpoint"]).resolve())
        ):
            raise RunnerError("admission_failed")
    host.image = by_service["api"]["Image"]
    host.check_readers(all_containers, {item["Id"] for item in host.containers})


def start_existing(host: Host, journal: Json, services: set[str]) -> None:
    identities = [
        identity
        for identity, value in journal["services"].items()
        if value["running"] and value["service"] in services
    ]
    if not identities:
        return
    host.command(["docker", "start", *identities], failure="restart_failed", timeout=60)
    deadline = time.monotonic() + 120
    while True:
        values = host.docker_json(["container", "inspect", *identities])
        if not isinstance(values, list) or {item.get("Id") for item in values} != set(identities):
            raise RunnerError("restart_failed")
        for item in values:
            prior = journal["services"][item["Id"]]
            if (
                item.get("Image") != prior["image"]
                or host.labels(item).get("com.docker.compose.service") != prior["service"]
            ):
                raise RunnerError("restart_failed")
        if all(
            item.get("State", {}).get("Status") == "running"
            and (
                item.get("State", {}).get("Health") is None
                or item["State"]["Health"].get("Status") == "healthy"
            )
            for item in values
        ):
            return
        if time.monotonic() >= deadline:
            raise RunnerError("restart_failed")
        time.sleep(0.25)


def resume_existing(host: Host, journal: Json) -> None:
    values = host.inventory()
    prior = journal["services"]
    permitted = {identity for identity, value in prior.items() if value["running"]}
    source = {
        item["Id"]: item
        for item in values
        if host.labels(item).get("com.docker.compose.project") == host.config.project_name
    }
    if set(source) != set(prior) or any(
        item.get("Image") != prior[identity]["image"]
        or (item.get("State", {}).get("Status") != "exited" and identity not in permitted)
        for identity, item in source.items()
    ):
        raise RunnerError("restart_failed")
    host.check_readers(values, permitted)
    services = {value["service"] for value in prior.values() if value["running"]}
    journal["phase"] = "restarting"
    host.save(journal)
    for stage in (
        {"db"},
        {"auth", "rest", "storage", "imgproxy", "meta", "studio", "api-gw"},
        {"clamav", "api"},
        {"scanner-worker"},
    ):
        start_existing(host, journal, stage)
    if "api" in services:
        identity = next(identity for identity, value in prior.items() if value["service"] == "api")
        code = (
            "import os,urllib.request; from urllib.parse import urlsplit; "
            "r=urllib.request.Request('http://127.0.0.1:8000/api/ready',"
            "headers={'Host':urlsplit(os.environ['PUBLIC_ORIGIN']).netloc}); "
            "urllib.request.urlopen(r,timeout=3).read(65536)"
        )
        host.command(
            ["docker", "exec", identity, "python", "-c", code],
            failure="readiness_failed",
            timeout=10,
        )
    if "caddy" in services:
        if "api" not in services:
            raise RunnerError("readiness_failed")
        start_existing(host, journal, {"caddy"})
