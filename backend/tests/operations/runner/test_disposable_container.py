"""Container paths differ from the host, but run credentials remain exact."""

import json
import os
from pathlib import Path

import pytest

from app.core.config import instance
from app.core.config.instance import InstanceTargetError, instance_target_for_process
from tests.operations.runner.test_disposable_database_guard import (
    disposable_target as disposable_target,
)
from tests.postgres_runtime import container_runtime_database_url, postgres_network_name


@pytest.mark.parametrize("alter", [None, "password", "network", "issuer", "host-checkout"])
def test_container_image_path_does_not_replace_host_manifest_identity(
    disposable_target, monkeypatch, alter
):
    host_url, _facts = disposable_target
    path = Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"])
    manifest = json.loads(path.read_text())
    runtime_url = container_runtime_database_url(host_url)
    manifest["container_runtime"] = {
        "url": runtime_url,
        "network": postgres_network_name(manifest["run_id"]),
        "alias": "db",
        "port": 5432,
    }
    process = {
        name: os.environ[name]
        for name in (
            "ENVIRONMENT",
            "OPENSLATE_TEST_DATABASE_MANIFEST",
            "E2E_ALLOW_MUTATIONS",
            "OPENSLATE_FULLSTACK_RUN_ID",
            "SUPABASE_URL",
            "SUPABASE_AUTH_ISSUER",
            "SUPABASE_STORAGE_URL",
            "REALTIME_PUBLISH_URL",
        )
    }
    process.update(
        SUPABASE_URL="http://api-gw:8000",
        SUPABASE_STORAGE_URL="http://api-gw:8000/storage/v1",
        REALTIME_PUBLISH_URL="http://api-gw:8001/realtime/v1/api/broadcast",
    )
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", Path("/image"))
    original_is_file = Path.is_file
    monkeypatch.setattr(Path, "is_file", lambda p: p == Path("/.dockerenv") or original_is_file(p))
    if alter == "password":
        runtime_url = runtime_url.replace("test-only-placeholder", "wrong-password")
    elif alter == "network":
        manifest["container_runtime"]["network"] = "another-provider"
    elif alter == "issuer":
        process["SUPABASE_AUTH_ISSUER"] = "http://127.0.0.1:59222/auth/v1"
    elif alter == "host-checkout":
        runtime_url = host_url
        process.update(
            SUPABASE_URL="http://127.0.0.1:49153",
            SUPABASE_STORAGE_URL="http://127.0.0.1:49153/storage/v1",
            REALTIME_PUBLISH_URL="http://127.0.0.1:49155/realtime/v1/api/broadcast",
        )
    path.write_text(json.dumps(manifest))
    if alter is not None:
        with pytest.raises(InstanceTargetError):
            instance_target_for_process(runtime_url, "openslate_runtime", process)
    else:
        target = instance_target_for_process(runtime_url, "openslate_runtime", process)
        assert target is not None
        assert (target.host, target.port, target.database) == ("db", 5432, "postgres")
        assert target.cluster_name == manifest["ownership"]["cluster_name"]
