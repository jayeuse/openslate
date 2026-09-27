"""A privileged provider client cannot target a neighboring installation."""

import json
from copy import deepcopy
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.core.config import provider_instance as guard
from app.core.config.disposable_instance import PROVIDER_IMAGES
from app.core.config.instance import InstanceTarget, InstanceTargetError


def _installation(tmp_path: Path) -> tuple[dict[str, str], InstanceTarget, list[dict]]:
    project = "openslate-provider-test"
    network = project + "_provider"
    path = tmp_path / "attestation.json"
    path.write_text(json.dumps({"ownership": {"network_id": "network-id"}}))
    values = {
        "ENVIRONMENT": "development", "SUPABASE_URL": "http://127.0.0.1:58000",
        "SUPABASE_AUTH_ISSUER": "http://127.0.0.1:58000/auth/v1",
    }
    target = InstanceTarget(project, "127.0.0.1", 55432, "postgres", path, project)
    containers = []
    root = Path(__file__).resolve().parents[3] / "infra/supabase"
    for service in ("api-gw", "auth", "storage"):
        containers.append({
            "Config": {"Image": PROVIDER_IMAGES[service], "Labels": {
                "com.docker.compose.project": project,
                "com.docker.compose.service": service,
                "com.docker.compose.project.working_dir": str(root),
            }, "Env": ["GOTRUE_JWT_ISSUER=" + values["SUPABASE_AUTH_ISSUER"]]},
            "State": {"Running": True},
            "NetworkSettings": {"Networks": {network: {"NetworkID": "network-id"}},
                "Ports": {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "58000"}]}},
            "Mounts": [{"Type": "volume", "Name": project + "_supabase-storage-data",
                "Destination": "/var/lib/storage"}],
        })
    return values, target, containers


@pytest.mark.parametrize("fault", [None, "url", "issuer", "network", "image", "volume"])
def test_provider_operations_admit_only_the_database_installation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fault: str | None,
) -> None:
    values, target, containers = _installation(tmp_path)
    inspected = deepcopy(containers)
    if fault == "url":
        values["SUPABASE_URL"] = "http://127.0.0.1:58001"
    elif fault == "issuer":
        values["SUPABASE_AUTH_ISSUER"] = "http://other.test/auth/v1"
    elif fault == "network":
        inspected[2]["NetworkSettings"]["Networks"][target.instance_id + "_provider"] = {
            "NetworkID": "another-network",
        }
    elif fault == "image":
        inspected[0]["Config"]["Image"] = "untrusted:latest"
    elif fault == "volume":
        inspected[2]["Mounts"][0]["Name"] = "neighbor-storage"
    monkeypatch.setattr(guard, "instance_target_for_process", lambda *a, **k: target, raising=False)
    monkeypatch.setattr(guard, "_docker_json", MagicMock(return_value=inspected), raising=False)
    if fault:
        with pytest.raises(InstanceTargetError):
            guard.assert_provider_instance(
                values, database_url="owned-test-url", expected_user="owner",
            )
    else:
        guard.assert_provider_instance(values, database_url="owned-test-url", expected_user="owner")
