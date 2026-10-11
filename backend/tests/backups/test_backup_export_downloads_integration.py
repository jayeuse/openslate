"""Real signed-cookie/file/ASGI export admission; no provider or host data effects."""

import hashlib
import os
from datetime import timedelta
from threading import Event
from uuid import UUID, uuid4

import anyio
import httpx
import pytest
from sqlalchemy import event, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.backups import downloads

pytest_plugins = ("tests.backups.test_backup_exports_integration",)
pytestmark = pytest.mark.integration


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


def _stored(world):
    from app.systems.manage.backups.models import BackupExportOperation

    with Session(world.auth.owner) as db:
        row = db.get(BackupExportOperation, world.export_id)
        events = list(db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id == row.id)))
        return row, events


def test_cookie_password_admission_is_private_bounded_and_native_get_consumes_once(ready_export):
    world = ready_export
    response = world.admit()
    assert response.status_code == 200 and set(response.json()) == {"expires_at"}
    assert response.headers["cache-control"] == "no-store"
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert f"Path={world.path}/content" in cookie and "Domain=" not in cookie
    handle = world.auth.client.cookies.get("openslate_export_admission")
    assert handle and handle not in response.text
    row, events = _stored(world)
    assert row.admission_digest == hashlib.sha256(handle.encode()).hexdigest()
    assert row.admission_actor_id == world.auth.actor_id
    assert row.admission_session_id == world.auth.session_ids[0] and not events
    with Session(world.auth.owner) as db:
        now = db.scalar(select(func.clock_timestamp()))
        session = db.get(IdentitySession, world.auth.session_ids[0])
        assert (
            now < row.admission_expires_at <= min(now + timedelta(seconds=600), session.expires_at)
        )
    assert ("POST", "/auth/v1/logout") in world.auth.calls
    sent = world.auth.client.get(world.path + "/content", headers=world.native_headers)
    assert sent.status_code == 200 and sent.content == world.content
    assert sent.headers["content-length"] == str(len(world.content))
    assert (
        sent.headers["accept-ranges"] == "none"
        and sent.headers["x-content-type-options"] == "nosniff"
    )
    assert f"openslate-backup-export-{world.export_id}.tar" in sent.headers["content-disposition"]
    row, events = _stored(world)
    assert (
        row.admission_digest
        is row.admission_actor_id
        is row.admission_session_id
        is row.admission_expires_at
        is None
    )
    assert (
        len(events) == 1
        and events[0].event_type == "backup.export.download"
        and events[0].outcome == "attempt"
    )
    assert events[0].event_metadata == {
        "backup_run_id": str(world.source_id),
        "size_bytes": len(world.content),
        "sha256": hashlib.sha256(world.content).hexdigest(),
    }
    assert (
        world.auth.client.get(world.path + "/content", headers=world.native_headers).status_code
        == 403
    )


@pytest.mark.parametrize(
    "method,headers,status",
    [
        ("HEAD", {}, 405),
        ("GET", {"Range": "bytes=0-1"}, 416),
        ("GET", {"Purpose": "prefetch"}, 403),
        ("GET", {"Sec-Fetch-Mode": "cors"}, 403),
    ],
)
def test_non_native_requests_do_not_consume_or_emit_attempt(ready_export, method, headers, status):
    world = ready_export
    assert world.admit().status_code == 200
    before = _stored(world)[0].admission_digest
    response = world.auth.client.request(method, world.path + "/content", headers=headers)
    assert response.status_code == status
    row, events = _stored(world)
    assert row.admission_digest == before and not events


@pytest.mark.parametrize(
    "defect", ["symlink", "hardlink", "mode", "root-mode", "hash", "size", "group"]
)
def test_confined_artifact_refusals_leave_confirmation_unconsumed(
    ready_export, defect, monkeypatch
):
    world = ready_export
    assert world.admit().status_code == 200
    if defect == "symlink":
        other = world.root / "unowned.tar"
        world.artifact.rename(other)
        world.artifact.symlink_to(other)
    elif defect == "hardlink":
        os.link(world.artifact, world.root / "unowned.tar")
    elif defect == "mode":
        world.artifact.chmod(0o660)
    elif defect == "root-mode":
        world.root.chmod(0o770)
    elif defect == "hash":
        with world.artifact.open("r+b") as output:
            output.write(b"Changed")
    elif defect == "size":
        world.artifact.write_bytes(b"short")
    else:
        monkeypatch.setattr(downloads, "EXPORT_GROUP", 10001)
    response = world.auth.client.get(world.path + "/content", headers=world.native_headers)
    assert response.status_code == 503 and "content-disposition" not in response.headers
    row, events = _stored(world)
    assert row.admission_digest is not None and not events


@pytest.mark.parametrize("fault", ["audit", "commit"])
def test_consumption_and_attempt_failure_never_send_attachment_bytes(
    ready_export, monkeypatch, fault
):
    world = ready_export
    assert world.admit().status_code == 200
    if fault == "audit":

        def deny(*args, **kwargs):
            raise SQLAlchemyError("Owned audit fault")

        monkeypatch.setattr(downloads, "append_security_event", deny)
    else:

        def observed(db, *_args):
            from app.systems.manage.backups.models import BackupExportOperation

            if any(
                isinstance(row, BackupExportOperation)
                and row.state == "ready"
                and row.admission_digest is None
                for row in db.dirty
            ):
                db.info["owned_export_consumption"] = True

        def deny(db):
            observed(db)
            if db.info.get("owned_export_consumption"):
                raise SQLAlchemyError("Owned consume commit fault")

        event.listen(AuditSession, "before_flush", observed)
        event.listen(AuditSession, "before_commit", deny)
    try:
        response = world.auth.client.get(world.path + "/content", headers=world.native_headers)
        assert response.status_code == 503 and "content-disposition" not in response.headers
        assert response.content != world.content
        row, events = _stored(world)
        assert row.admission_digest is not None and not events
    finally:
        if fault == "commit":
            event.remove(AuditSession, "before_commit", deny)
            event.remove(AuditSession, "before_flush", observed)


@pytest.mark.parametrize("change", ["role", "session", "rotation", "expiry", "path-replacement"])
def test_preparation_rechecks_authority_and_streams_only_retained_descriptor(
    ready_export, monkeypatch, change
):
    world = ready_export
    assert world.admit().status_code == 200
    original = downloads.prepare_artifact

    def prepared(*args, **kwargs):
        value = original(*args, **kwargs)
        if change == "rotation":
            assert world.admit().status_code == 200
        elif change == "expiry":
            from app.systems.manage.backups.models import BackupExportOperation

            with Session(world.auth.owner) as db:
                db.get(BackupExportOperation, world.export_id).admission_expires_at = db.scalar(
                    select(func.clock_timestamp())
                )
                db.commit()
        elif change == "path-replacement":
            world.artifact.unlink()
            world.artifact.write_bytes(b"Unrelated replacement")
        else:
            with Session(world.auth.owner) as db:
                if change == "role":
                    db.get(User, world.auth.actor_id).role = "member"
                else:
                    db.get(IdentitySession, world.auth.session_ids[0]).revoked_at = world.auth.clock
                db.commit()
        return value

    monkeypatch.setattr(downloads, "prepare_artifact", prepared)
    cookie = world.auth.client.cookies.get("openslate_export_admission")
    access_cookie = f"openslate_access={world.auth.access()}"
    response = world.auth.client.get(
        world.path + "/content",
        headers={
            **world.native_headers,
            "Cookie": f"{access_cookie}; openslate_export_admission={cookie}",
        },
    )
    assert (
        response.status_code
        == {"role": 403, "session": 401, "rotation": 403, "expiry": 403, "path-replacement": 200}[
            change
        ]
    )
    if change == "path-replacement":
        assert response.content == world.content
    else:
        assert "content-disposition" not in response.headers and not _stored(world)[1]


def _scope(world):
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


@pytest.mark.parametrize("end", ["complete", "disconnect", "wall", "slow-send"])
def test_real_asgi_stream_is_bounded_and_closes_descriptor_on_terminal_paths(
    ready_export, monkeypatch, end
):
    world = ready_export
    assert world.admit().status_code == 200
    lengths, digest, statuses, opened = [], hashlib.sha256(), [], []
    original = downloads.prepare_artifact

    def prepare(*args, **kwargs):
        artifact = original(*args, **kwargs)
        opened.append(artifact)
        return artifact

    monkeypatch.setattr(downloads, "prepare_artifact", prepare)
    ticks = [0.0]
    if end == "wall":
        monkeypatch.setattr(downloads, "monotonic", lambda: ticks[0])
    if end == "slow-send":
        monkeypatch.setattr(downloads, "SEND_SECONDS", 0.01)

    async def execute():
        disconnect = anyio.Event()
        received = False

        async def receive():
            nonlocal received
            if not received:
                received = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                statuses.append(message["status"])
            elif message.get("body"):
                lengths.append(len(message["body"]))
                digest.update(message["body"])
                if end == "disconnect":
                    disconnect.set()
                elif end == "wall":
                    ticks[0] = 7201
                elif end == "slow-send":
                    await anyio.Event().wait()

        await world.auth.client.app(_scope(world), receive, send)

    anyio.run(execute)
    assert statuses == [200] and lengths and max(lengths) <= 1024 * 1024
    if end == "complete":
        assert (
            sum(lengths) == len(world.content)
            and digest.hexdigest() == hashlib.sha256(world.content).hexdigest()
        )
    else:
        assert sum(lengths) < len(world.content)
    assert opened and all(artifact.closed for artifact in opened)
    assert len(_stored(world)[1]) == 1
    assert (
        world.auth.client.get(world.path + "/content", headers=world.native_headers).status_code
        == 403
    )


def test_cancelled_preparation_retains_physical_slot_until_worker_really_exits(
    ready_export, monkeypatch
):
    world = ready_export
    assert world.admit().status_code == 200
    entered, release, exited = Event(), Event(), Event()
    original = downloads.prepare_artifact

    def held(*args, **kwargs):
        entered.set()
        try:
            assert release.wait(10), "Owned physical preparation was not released"
            return original(*args, **kwargs)
        finally:
            exited.set()

    monkeypatch.setattr(downloads, "prepare_artifact", held)

    async def execute():
        received = False

        async def receive():
            nonlocal received
            if not received:
                received = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await anyio.Event().wait()

        async def send(message):
            raise AssertionError("Cancelled preparation must not start headers")

        async with anyio.create_task_group() as group:
            group.start_soon(world.auth.client.app, _scope(world), receive, send)
            assert await anyio.to_thread.run_sync(entered.wait, 10)
            group.cancel_scope.cancel()
        with anyio.CancelScope(shield=True):
            response = await anyio.to_thread.run_sync(
                lambda: world.auth.client.get(world.path + "/content", headers=world.native_headers)
            )
            assert response.status_code == 503 and response.headers["retry-after"] == "5"
            release.set()
            assert await anyio.to_thread.run_sync(exited.wait, 10)

    try:
        anyio.run(execute)
    finally:
        release.set()
        assert exited.wait(10)
    row, events = _stored(world)
    assert row.admission_digest is not None and not events
    monkeypatch.setattr(downloads, "prepare_artifact", original)
    assert world.admit().status_code == 200
    assert (
        world.auth.client.get(world.path + "/content", headers=world.native_headers).status_code
        == 200
    )
