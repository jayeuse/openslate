"""Admit provider endpoints only within the selected database installation."""

import json
from collections.abc import Mapping

from app.core.config.disposable_instance import PROVIDER_IMAGES
from app.core.config.instance import (
    REPOSITORY_ROOT,
    InstanceTargetError,
    _docker_json,
    instance_target_for_process,
)


def assert_provider_instance(
    values: Mapping[str, str], *, database_url: str, expected_user: str,
) -> None:
    target = instance_target_for_process(database_url, expected_user, process=values)
    if not values.get("SUPABASE_URL") or not values.get("SUPABASE_AUTH_ISSUER"):
        raise InstanceTargetError("Provider endpoints must be explicit")
    environment = values.get("ENVIRONMENT", "").strip().casefold()
    if environment == "test":
        # The runner admission above checks both endpoints against its private
        # manifest and verifies all provider service IDs and network ownership.
        return
    if target is None:
        raise InstanceTargetError("Provider installation target is unavailable")
    if environment in {"production", "prod"}:
        if (
            target.host != "db" or target.port != 5432
            or values["SUPABASE_URL"] != "http://api-gw:8000"
        ):
            raise InstanceTargetError("Production providers must use the installation network")
        return
    try:
        if target.attestation_path is None:
            raise ValueError
        attestation = json.loads(target.attestation_path.read_text())
        network_id = attestation["ownership"]["network_id"]
        services = ("api-gw", "auth", "storage")
        containers = _docker_json([
            "inspect", *(f"{target.instance_id}-{service}-1" for service in services),
        ])
        if len(containers) != len(services):
            raise ValueError
        network = target.instance_id + "_provider"
        for service, container in zip(services, containers, strict=True):
            labels = container["Config"]["Labels"]
            if (
                labels.get("com.docker.compose.project") != target.instance_id
                or labels.get("com.docker.compose.service") != service
                or labels.get("com.docker.compose.project.working_dir")
                != str(REPOSITORY_ROOT / "infra/supabase")
                or container["Config"]["Image"] != PROVIDER_IMAGES[service]
                or container["State"]["Running"] is not True
                or container["NetworkSettings"]["Networks"][network]["NetworkID"] != network_id
            ):
                raise ValueError
        gateway, auth, storage = containers
        bindings = gateway["NetworkSettings"]["Ports"]["8000/tcp"]
        if (
            len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1"
            or values["SUPABASE_URL"] != "http://127.0.0.1:" + bindings[0]["HostPort"]
        ):
            raise ValueError
        issuer_entries = [entry for entry in auth["Config"]["Env"]
                          if entry.startswith("GOTRUE_JWT_ISSUER=")]
        if issuer_entries != ["GOTRUE_JWT_ISSUER=" + values["SUPABASE_AUTH_ISSUER"]]:
            raise ValueError
        storage_mounts = [mount for mount in storage["Mounts"]
                          if mount.get("Destination") == "/var/lib/storage"]
        if (
            len(storage_mounts) != 1 or storage_mounts[0].get("Type") != "volume"
            or storage_mounts[0].get("Name") != target.instance_id + "_supabase-storage-data"
        ):
            raise ValueError
    except (OSError, KeyError, TypeError, ValueError, IndexError):
        raise InstanceTargetError("Provider endpoints do not match the admitted database") from None
