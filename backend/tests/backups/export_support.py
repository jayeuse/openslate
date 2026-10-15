"""Committed export worlds shared by the backup export tests (plan item 20, B10).

``export_world`` commits a verified source backup for the signed-cookie policy world and
removes every export, event, audit row and policy change it caused. ``ready_export`` adds
one ready export with a real artifact on disk. ``tests/backups/conftest.py`` registers
both fixtures for this folder.
"""

import hashlib
import os
from collections.abc import Awaitable, Callable
from datetime import timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import anyio
import httpx
import pytest
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.backups import downloads
from app.systems.manage.backups.models import BackupExportOperation, BackupPolicy, BackupRun

SECRET = "Example export 🌿 passphrase"


@pytest.fixture
def export_world(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        saved_policy = db.execute(select(BackupPolicy.__table__)).mappings().one_or_none()
        instance = db.scalar(select(func.current_setting("cluster_name")))
        now = db.scalar(select(func.clock_timestamp()))
        source_id = uuid4()
        db.add(
            BackupRun(
                id=source_id,
                installation_id=instance,
                name="Owned export source",
                provenance="manual",
                requester_id=world.actor_id,
                idempotency_hash=uuid4().hex * 2,
                schedule="disabled",
                retention_days=30,
                requested_at=now - timedelta(hours=3),
                state="succeeded",
                claim_id=uuid4(),
                claimed_schedule="disabled",
                claimed_retention_days=30,
                started_at=now - timedelta(hours=2),
                finished_at=now - timedelta(hours=1),
                reconciled_at=now - timedelta(minutes=59),
                verified_at=now - timedelta(minutes=61),
                snapshot_id="a" * 64,
                manifest_sha256="b" * 64,
            )
        )
        db.commit()
    ids = []
    source_ids = [source_id]

    def create(key=None, **body):
        response = world.client.post(
            "/api/backups/exports",
            headers={**world.headers(), "Idempotency-Key": key or uuid4().hex},
            json={"backup_run_id": str(source_id), "passphrase": SECRET, **body},
        )
        if response.status_code == 201:
            ids.append(UUID(response.json()["id"]))
        return response

    yield SimpleNamespace(
        auth=world,
        source_id=source_id,
        instance=instance,
        runtime=get_engine(),
        create=create,
        ids=ids,
        source_ids=source_ids,
    )
    with Session(world.owner) as db:
        if ids:
            for event in db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id.in_(ids))):
                db.delete(event)
            for audit in db.scalars(
                select(AuditLog).where(AuditLog.entity_id.in_(ids + source_ids))
            ):
                db.delete(audit)
            for row in db.scalars(
                select(BackupExportOperation).where(
                    BackupExportOperation.backup_run_id == source_id
                )
            ):
                db.delete(row)
            db.flush()
        for source in db.scalars(select(BackupRun).where(BackupRun.id.in_(source_ids))):
            db.delete(source)
        policy = db.scalar(select(BackupPolicy))
        if saved_policy is None:
            if policy is not None:
                assert policy.installation_id == instance
                db.delete(policy)
        else:
            assert policy is not None and policy.id == saved_policy["id"]
            db.execute(
                update(BackupPolicy).where(BackupPolicy.id == policy.id).values(**saved_policy)
            )
        db.commit()


@pytest.fixture
def ready_export(export_world, tmp_path, monkeypatch):
    world = export_world
    created = world.create()
    assert created.status_code == 201
    from app.systems.manage.backups import exports
    from app.systems.manage.backups.schemas import ExportOutcomeCommand

    world.export_id = UUID(created.json()["id"])
    world.path = f"/api/backups/exports/{world.export_id}"
    world.content = b"Owned encrypted archive boundary" * 70000
    world.root = tmp_path / "backup-exports"
    world.root.mkdir(mode=0o750)
    world.root.chmod(0o750)
    world.artifact = world.root / f"{world.export_id}.tar"
    world.artifact.write_bytes(world.content)
    world.artifact.chmod(0o640)
    # Owned macOS group projection; actual gid10001 is a Linux-container acceptance proof.
    monkeypatch.setattr(downloads, "EXPORT_GROUP", os.getegid())
    monkeypatch.setattr(get_settings(), "backup_export_root", world.root)
    with AuditSession(world.runtime) as db:
        first = exports.claim_export(db, world.instance, uuid4())
        db.commit()
        outcome = ExportOutcomeCommand(
            op="export-outcome",
            installation_id=world.instance,
            project="owned-export-test",
            export_id=world.export_id,
            claim_id=first.claim.claim_id,
            state="ready",
            finished_at=db.scalar(select(func.clock_timestamp())),
            size_bytes=len(world.content),
            sha256=hashlib.sha256(world.content).hexdigest(),
            failure_code=None,
        )
        exports.record_export_outcome(db, world.instance, outcome)
        db.commit()
    world.auth.client.cookies.set("openslate_access", world.auth.access())
    world.auth.client.cookies.set("openslate_refresh", world.auth.handles[0])
    world.auth.client.cookies.set("openslate_csrf", world.auth.csrf[0])
    world.csrf_headers = {"X-CSRF-Token": world.auth.csrf[0]}
    world.native_headers = {"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}

    def temporary_password(request):
        if request.url.path == "/auth/v1/token":
            return httpx.Response(
                200,
                json={
                    "access_token": world.auth.access(slot=4),
                    "refresh_token": "owned-temporary-refresh",
                    "expires_in": 600,
                    "user": {"id": str(world.auth.provider_id), "email": world.auth.email},
                },
            )

    world.auth.hook = temporary_password

    def admit(password=None):
        return world.auth.client.post(
            world.path + "/download-admission",
            headers=world.csrf_headers,
            json={"password": password or world.auth.password},
        )

    world.admit = admit
    return world


def stored_export(world: Any) -> tuple[BackupExportOperation, list[SecurityEvent]]:
    """The committed export row of *world* and its security events."""

    with Session(world.auth.owner) as db:
        row = db.get(BackupExportOperation, world.export_id)
        events = list(
            db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id == world.export_id))
        )
        return row, events


def content_scope(world: Any) -> dict[str, Any]:
    """The raw ASGI scope of a native GET of the export content with the cookies."""

    request = httpx.Request(
        "GET",
        str(world.auth.client.base_url).rstrip("/") + world.path + "/content",
        headers={**world.native_headers, "Origin": get_settings().public_origin},
    )
    world.auth.client.cookies.set_cookie_header(request)
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": request.url.scheme,
        "path": world.path + "/content",
        "raw_path": (world.path + "/content").encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(name.lower(), value) for name, value in request.headers.raw],
        "client": ("testclient", 12345),
        "server": (request.url.host, request.url.port or 80),
    }


def request_then_wait(
    disconnect: anyio.Event | None = None,
) -> Callable[[], Awaitable[dict[str, object]]]:
    """An ASGI receive: one empty request body, then a disconnect once *disconnect* is set.

    Without *disconnect*, the client never disconnects.
    """

    received = False

    async def receive() -> dict[str, object]:
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await (disconnect or anyio.Event()).wait()
        return {"type": "http.disconnect"}

    return receive
