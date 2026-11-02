"""Read-only check that the ready file rows and the private Storage objects agree.

Run from backend/: uv run python operations/check_file_storage.py
Exit 0: no difference; 1: differences to review; 2: visibility unavailable.

It reads every organization's file rows in one read-only transaction and closes it, then
lists both private buckets, so no transaction stays open while Storage answers. It
reports each ready row without its object, each object that no file row explains, and
each object whose size differs from the row's ``actual_size``, with the bucket and the
file ID. Objects of uploads and deletions still in progress, and Comms export artifacts,
are expected and not reported. It changes nothing; an upload or a purge that finishes
during the check can show as a difference, so run it again before acting on one.
"""

import json
import logging
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypedDict
from uuid import UUID

import httpx
from sqlalchemy import text
from sqlalchemy.engine import Connection

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config.environment import environment_inputs
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from app.core.database.session import get_engine
from app.core.observability import configure_observability_logging, log_event
from app.systems.platform.files.supabase_storage import bucket_for
from operations.storage.listing import list_bucket

BUCKETS = ("slateops-ready", "slateops-avatars")
# Their objects may or may not exist yet; file reconciliation owns them, not this check.
_IN_PROGRESS = frozenset({"uploading", "deleting"})
_REPORTED = 100

_ORGANIZATIONS = text("SELECT id FROM public.organizations ORDER BY id")
_SCOPE = text("SELECT set_config('slateops.org_id', :org, true)")
_FILES = text(
    "SELECT id, object_key, state, actual_size FROM public.files "
    "WHERE org_id IS NOT DISTINCT FROM CAST(:org AS uuid) ORDER BY id"
)
_EXPORTS = text(
    "SELECT artifact_key FROM public.comms_exports "
    "WHERE org_id = CAST(:org AS uuid) AND artifact_key IS NOT NULL"
)


@dataclass(frozen=True)
class FileRow:
    file_id: UUID
    object_key: str
    state: str
    actual_size: int | None


@dataclass
class Inventory:
    files: list[FileRow] = field(default_factory=list)
    artifacts: set[str] = field(default_factory=set)


class Difference(TypedDict):
    kind: str
    bucket: str
    file_id: str | None
    object_key: str
    expected_size: int | None
    object_size: int | None


def read_inventory(connection: Connection) -> Inventory:
    """Read the rows of the account files and of every organization.

    Row-level security shows one organization per scope, so the transaction rebinds
    its scope for each one; account files (avatars) have no organization.
    """
    inventory = Inventory()
    organizations = [str(org) for org in connection.scalars(_ORGANIZATIONS)]
    for org in (None, *organizations):
        connection.execute(_SCOPE, {"org": org or ""})
        for row in connection.execute(_FILES, {"org": org}):
            inventory.files.append(FileRow(row.id, row.object_key, row.state, row.actual_size))
        if org is not None:
            inventory.artifacts.update(connection.scalars(_EXPORTS, {"org": org}))
    return inventory


def list_objects(client: httpx.Client) -> dict[str, dict[str, int | None]]:
    return {bucket: list_bucket(client, bucket) for bucket in BUCKETS}


def compare(
    inventory: Inventory, objects: Mapping[str, Mapping[str, int | None]]
) -> list[Difference]:
    differences: list[Difference] = []
    rows = {row.object_key: row for row in inventory.files}
    for row in inventory.files:
        if row.state != "ready":
            continue
        bucket = bucket_for(row.object_key)
        stored = objects.get(bucket, {})
        if row.object_key not in stored:
            kind = "missing_object"
        elif stored[row.object_key] != row.actual_size:
            kind = "size_difference"
        else:
            continue
        differences.append(
            Difference(
                kind=kind, bucket=bucket, file_id=str(row.file_id), object_key=row.object_key,
                expected_size=row.actual_size, object_size=stored.get(row.object_key),
            )
        )
    for bucket in BUCKETS:
        for key, size in sorted(objects.get(bucket, {}).items()):
            owner = rows.get(key)
            if owner is not None and (owner.state == "ready" or owner.state in _IN_PROGRESS):
                continue
            if owner is None and key in inventory.artifacts:
                continue
            differences.append(
                Difference(
                    kind="extra_object", bucket=bucket,
                    file_id=str(owner.file_id) if owner is not None else None,
                    object_key=key, expected_size=None, object_size=size,
                )
            )
    return differences


class StorageReport(TypedDict):
    status: str
    differences: list[Difference]
    truncated: bool
    ready_files: int
    objects: dict[str, int]


def report(
    inventory: Inventory, objects: Mapping[str, Mapping[str, int | None]]
) -> StorageReport:
    differences = compare(inventory, objects)
    return {
        "status": "attention" if differences else "ok",
        "differences": differences[:_REPORTED],
        "truncated": len(differences) > _REPORTED,
        "ready_files": sum(row.state == "ready" for row in inventory.files),
        "objects": {bucket: len(objects.get(bucket, {})) for bucket in BUCKETS},
    }


def _storage_client(values: Mapping[str, str]) -> httpx.Client:
    assert_provider_instance(
        values, database_url=values["DATABASE_URL"], expected_user="slateops_runtime"
    )
    key = values["SUPABASE_SECRET_KEY"]
    return httpx.Client(
        base_url=values["SUPABASE_URL"].rstrip("/") + "/storage/v1/",
        headers={"apikey": key, "authorization": f"Bearer {key}"},
        timeout=10, follow_redirects=False, trust_env=False,
    )


def main() -> int:
    configure_observability_logging()
    try:
        with get_engine().connect() as connection:
            connection.execute(text("SET TRANSACTION READ ONLY"))
            connection.execute(text("SET LOCAL statement_timeout = '30s'"))
            inventory = read_inventory(connection)
            connection.rollback()
        with _storage_client(environment_inputs(DOTENV_PATH)) as client:
            objects = list_objects(client)
    except Exception:
        log_event(
            "operational_check_failed", level=logging.ERROR, reason_code="file_storage_check_failed"
        )
        print(json.dumps({"status": "unavailable", "reason": "check_failed"}))
        return 2
    result = report(inventory, objects)
    print(json.dumps(result, separators=(",", ":")))
    if result["differences"]:
        log_event(
            "operational_attention", level=logging.WARNING, reason_code="file_storage_differs"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
