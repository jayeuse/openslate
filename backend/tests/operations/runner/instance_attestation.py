"""Owner-only instance attestation files for the instance-guard tests."""

import json
from pathlib import Path

from app.core.config import instance


def write_attestation(root: Path, identity: str, *, legacy: bool = False) -> Path:
    """Write the attestation that the guard reads for *identity* under the repository *root*.

    The tests point ``instance.REPOSITORY_ROOT`` at *root*, so the Compose working directory
    is ``root/infra/supabase``. *legacy* writes the retired version 1 file.
    """
    path = root / ".agent-runtime" / "instances" / f"{identity}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1 if legacy else 2,
        "instance_id": identity,
        "compose_project": identity,
        "postgres": {
            "host": "127.0.0.1",
            "port": 55432,
            "database": "postgres",
            "cluster_name": identity,
        },
        "compose": {
            "volume": f"{identity}_supabase-db-data",
            "network": f"{identity}_provider",
        },
        "ownership": {
            "compose_project": identity,
            "container_port": 5432,
            "container_id": "a" * 64,
            "host_port": 55432,
            "image": instance.SUPABASE_DB_IMAGE,
            "network_id": "b" * 64,
            "working_dir": str(root / "infra" / "supabase"),
            "network": f"{identity}_provider",
            "volume": f"{identity}_supabase-db-data",
        },
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)
    return path
