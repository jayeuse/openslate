"""Real crash-after-claim recovery, confined to the release runner's disposable stack.

No SQL writes or synthetic claims: API upload creates work, Docker kills the
actual worker, and the operator CLI acknowledges replacement of the old engine.
This proves uncertainty after a durable claim, not that INSTREAM had begun.
"""

import json
import random
import re
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from PIL import Image
from sqlalchemy import Connection, create_engine, text

# The release runner also runs directly as `python tests/fullstack_runner.py`.
# Resolve only this checkout's trusted backend root, as backend scripts do.
if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.systems.platform.files.worker import LEADER_LOCK
from tests.postgres_runtime import POSTGRES_DATABASE, assert_runner_database_url

if TYPE_CHECKING:
    from tests.scanner_runtime import DisposableScanner

API = "http://127.0.0.1:8008"
MANIFEST = "/run/scanner-manifest.json"


def _guard(
    scanner: "DisposableScanner", application_env: dict[str, str], admin_identity: dict[str, str]
) -> None:
    target = urlsplit(application_env["DATABASE_URL"])
    try:
        assert_runner_database_url(
            application_env["DATABASE_URL"],
            application_env,
            allowed_roles=frozenset({"openslate_runtime"}),
        )
    except RuntimeError:
        disposable_database = False
    else:
        disposable_database = target.path == f"/{POSTGRES_DATABASE}"
    if (
        re.fullmatch(r"[a-f0-9]{32}", scanner.run_id) is None
        or not disposable_database
        or application_env["ENVIRONMENT"] != "test"
        or admin_identity["email"] != f"p5-{scanner.run_id}-admin@example.com"
        or scanner.worker != f"openslate-scan-worker-e2e-{scanner.run_id}"
        or scanner.container != f"openslate-clamav-e2e-{scanner.run_id}"
        or {scanner.worker, scanner.container} - scanner.containers
        or {scanner.network, scanner.egress} - set(scanner.networks)
    ):
        raise RuntimeError("Recovery requires the exact disposable scanner stack")
    UUID(admin_identity["id"])
    for name in (scanner.worker, scanner.container):
        label = scanner._run(
            ["inspect", "--format", '{{index .Config.Labels "openslate.test.run"}}', name],
            capture=True,
            timeout=10,
        ).stdout.strip()
        if label != scanner.run_id:
            raise RuntimeError("Recovery container ownership mismatch")


def _headers(application_env: dict[str, str], identity: dict[str, str]) -> dict[str, str]:
    # Authenticate at each API phase rather than reusing a token across engine startup.
    with httpx.Client(timeout=10, trust_env=False) as client:
        response = client.post(
            API + "/api/auth/token",
            json={"email": identity["email"], "password": identity["password"]},
        )
    if response.status_code != 200:
        raise RuntimeError("Recovery fixture authentication failed")
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def _large_png() -> bytes:
    # Incompressible RGB data keeps the real storage download substantial enough
    # to observe its preceding durable claim; no sleeps or faults enter production.
    pixels = random.Random(61734).randbytes(2940 * 2940 * 3)
    output = BytesIO()
    with Image.frombytes("RGB", (2940, 2940), pixels) as picture:
        picture.save(output, format="PNG", compress_level=0)
    content = output.getvalue()
    if not 24 * 1024**2 < len(content) <= 25 * 1024**2:
        raise RuntimeError("Recovery PNG fixture exceeds its admitted size")
    return content


def _claim(connection: Connection, identity: UUID, creator: UUID) -> tuple[str, UUID | None, int]:
    row = connection.execute(
        text(
            "SELECT state, operation_id, scan_attempts FROM public.files "
            "WHERE id=:id AND creator_id=:creator"
        ),
        {"id": identity, "creator": creator},
    ).one()
    return row.state, row.operation_id, row.scan_attempts


def _wait_leadership_release(connection: Connection) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        held = connection.scalar(
            text(
                "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' "
                "AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) "
                "AND classid=:upper AND objid=:lower AND objsubid=1 AND granted)"
            ),
            {"upper": LEADER_LOCK >> 32, "lower": LEADER_LOCK & 0xFFFFFFFF},
        )
        if not held:
            return
        time.sleep(0.05)
    raise RuntimeError("Crashed worker leadership did not release before restart")


def _replace_engine(scanner: "DisposableScanner") -> None:
    manifest = json.loads(scanner.manifest.read_text())
    image = scanner._run(
        ["inspect", "--format", "{{.Image}}", scanner.container],
        capture=True,
        timeout=10,
    ).stdout.strip()
    if image != manifest["image_digest"] or scanner._hashes() != manifest["signature_hashes"]:
        raise RuntimeError("Recovery generation differs from its immutable manifest")
    scanner._remove_container(scanner.container)
    present = scanner._run(
        ["ps", "--all", "--quiet", "--filter", f"name=^/{scanner.container}$"],
        capture=True,
        timeout=10,
    ).stdout.strip()
    if present:
        raise RuntimeError("Old scanner engine removal was not confirmed")
    scanner.containers.add(scanner.container)
    scanner._run(
        [
            "run",
            "--detach",
            "--name",
            scanner.container,
            "--log-driver",
            "none",
            *scanner._security(engine=True),
            "--network",
            scanner.network,
            "--mount",
            f"type=bind,src={scanner.definitions},dst=/var/lib/clamav,readonly",
            "--env",
            "FILES_CLAMAV_PORT=3310",
            image,
        ],
        timeout=30,
    )
    code = (
        "import json,sys; from app.systems.platform.files.clamav import ClamAVScanner; "
        "scanner=ClamAVScanner(sys.argv[1],3310,sys.argv[2]); "
        "scanner.probe(); print(json.dumps({'ready':True}))"
    )
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            if scanner._sidecar(["-c", code, scanner.container, MANIFEST], manifest=True) == {
                "ready": True
            }:
                scanner._runtime_posture()
                return
        except subprocess.CalledProcessError:
            running = scanner._run(
                ["inspect", "--format", "{{.State.Running}}", scanner.container],
                capture=True,
                timeout=10,
            ).stdout.strip()
            if running != "true":
                raise RuntimeError("Replacement engine exited before readiness") from None
        time.sleep(0.5)
    raise RuntimeError("Replacement engine did not become ready before deadline")


def verify_worker_recovery(
    scanner: "DisposableScanner", application_env: dict[str, str], admin_identity: dict[str, str]
) -> None:
    """Run after normal file acceptance; outer DisposableScanner owns cleanup."""
    _guard(scanner, application_env, admin_identity)
    content = _large_png()
    scanner._run(["stop", "--time", "5", scanner.worker], timeout=15)
    with httpx.Client(base_url=API, timeout=60, trust_env=False) as api:
        api.headers.update(_headers(application_env, admin_identity))
        reserved = api.post(
            "/api/files",
            json={
                "purpose": "library_document",
                "filename": "worker-recovery.png",
                "expected_size": len(content),
            },
        )
        if reserved.status_code != 201:
            raise RuntimeError("Recovery file reservation failed")
        identity = UUID(reserved.json()["id"])
        uploaded = api.put(
            f"/api/files/{identity}/content",
            content=content,
            headers={"Content-Type": "application/octet-stream"},
        )
        if uploaded.status_code != 200 or uploaded.json()["state"] != "pending_scan":
            raise RuntimeError("Recovery upload did not enter quarantine")
        engine = create_engine(
            application_env["DATABASE_URL"],
            isolation_level="AUTOCOMMIT",
            connect_args={
                "connect_timeout": 5,
                "options": "-c default_transaction_read_only=on -c statement_timeout=2000",
            },
        )
        try:
            with engine.connect() as connection:
                creator = UUID(admin_identity["id"])
                if _claim(connection, identity, creator) != ("pending_scan", None, 0):
                    raise RuntimeError("Recovery file was admitted while worker was stopped")
                scanner._run(["start", scanner.worker], timeout=15)
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    claimed = _claim(connection, identity, creator)
                    if claimed[1] is not None:
                        scanner._run(["kill", scanner.worker], timeout=10)
                        break
                    if claimed[0] != "pending_scan" or claimed[2] != 0:
                        raise RuntimeError(
                            "Recovery fixture missed the claim-before-completion window"
                        )
                    time.sleep(0.01)
                else:
                    raise RuntimeError("Recovery worker did not claim the uploaded file")
                crashed = _claim(connection, identity, creator)
                if crashed != claimed or crashed[0] != "pending_scan" or crashed[2] != 1:
                    raise RuntimeError("Recovery fixture did not crash before claim completion")
                _wait_leadership_release(connection)
                scanner._run(["start", scanner.worker], timeout=15)
                status = scanner._run(
                    ["wait", scanner.worker], capture=True, timeout=20
                ).stdout.strip()
                if status != "2" or _claim(connection, identity, creator) != crashed:
                    raise RuntimeError(
                        "Worker restart on the same engine did not preserve its fence"
                    )
                _replace_engine(scanner)
                scanner._remove_container(scanner.worker)
                scanner.start_worker(application_env, acknowledge_engine_replacement=True)
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    final = _claim(connection, identity, creator)
                    if final[0] == "ready":
                        break
                    if final[0] != "pending_scan":
                        raise RuntimeError(
                            "Recovery file was not accepted after engine replacement"
                        )
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Recovery file did not become ready before deadline")
                if final != ("ready", None, crashed[2] + 1):
                    raise RuntimeError(
                        "Recovery did not fence the old operation and consume one attempt"
                    )
        finally:
            engine.dispose()
        api.headers.update(_headers(application_env, admin_identity))
        downloaded = api.get(f"/api/files/{identity}/content")
        if downloaded.status_code != 200 or downloaded.content != content:
            raise RuntimeError("Recovered file bytes do not match the original API upload")
    scanner.observations["worker_crash_recovery"] = {
        "crash_after_durable_claim": True,
        "instream_started": "not asserted",
        "same_engine_restart_exit": 2,
        "same_engine_claim_unchanged": True,
        "old_leadership_released_before_restart": True,
        "old_engine_removed": True,
        "replacement_engine_ready": True,
        "operator_acknowledgement": True,
        "recovery_attempts": 2,
        "download_matches_upload": True,
        "fixture_bytes": len(content),
    }
