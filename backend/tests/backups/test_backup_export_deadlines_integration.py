"""Real ASGI deadlines retain physical SQL and file ownership until worker exit."""

import hashlib
from threading import Event

import anyio
import pytest
from sqlalchemy import event
from sqlalchemy.exc import SQLAlchemyError

from app.core.database.session import AuditSession
from app.systems.manage.audit.context import get_audit_context
from app.systems.manage.backups import downloads
from app.systems.manage.backups.models import BackupExportOperation
from tests.backups.export_support import content_scope, request_then_wait, stored_export

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("stage", ["preflight", "commit"])
def test_preparation_deadline_includes_sql_and_retains_worker_owned_session(
    ready_export, monkeypatch, stage
):
    world = ready_export
    assert world.admit().status_code == 200
    monkeypatch.setattr(downloads, "PREPARATION_SECONDS", 1.0)
    entered, release, closed = Event(), Event(), Event()
    statuses, attachment = [], []
    original = downloads._snapshot

    def hold(db):
        original_close = db.close

        def close():
            original_close()
            closed.set()

        monkeypatch.setattr(db, "close", close)
        entered.set()
        assert release.wait(10), "Owned SQL worker was not released"

    def preflight(db, *args):
        facts = original(db, *args)
        hold(db)
        return facts

    def observe(db, *_args):
        if any(
            isinstance(row, BackupExportOperation)
            and row.id == world.export_id
            and row.admission_digest is None
            for row in db.dirty
        ):
            db.info["owned_export_deadline_commit"] = True

    def commit(db):
        observe(db)
        if db.info.get("owned_export_deadline_commit"):
            hold(db)

    if stage == "preflight":
        monkeypatch.setattr(downloads, "_snapshot", preflight)
    else:
        event.listen(AuditSession, "before_flush", observe)
        event.listen(AuditSession, "before_commit", commit)

    async def execute():
        stopped = anyio.Event()
        receive = request_then_wait()

        async def send(message):
            if message["type"] == "http.response.start":
                statuses.append(message["status"])
                attachment.extend(v for k, v in message["headers"] if k == b"content-disposition")

        async def request():
            try:
                await world.auth.client.app(content_scope(world), receive, send)
            finally:
                stopped.set()

        async with anyio.create_task_group() as group:
            group.start_soon(request)
            assert await anyio.to_thread.run_sync(entered.wait, 10), "SQL seam was not reached"
            try:
                with anyio.fail_after(2):
                    await stopped.wait()
                assert statuses == [504] and not attachment
                assert not closed.is_set(), (
                    "SQL Session was closed while its worker remained active"
                )
                busy = await anyio.to_thread.run_sync(
                    lambda: world.auth.client.get(
                        world.path + "/content", headers=world.native_headers
                    )
                )
                assert busy.status_code == 503 and busy.headers["retry-after"] == "5"
            finally:
                release.set()
            assert await anyio.to_thread.run_sync(closed.wait, 10), "SQL worker did not close"

    try:
        anyio.run(execute)
    finally:
        release.set()
        if stage == "commit":
            event.remove(AuditSession, "before_commit", commit)
            event.remove(AuditSession, "before_flush", observe)
    row, events = stored_export(world)
    if stage == "preflight":
        assert row.admission_digest is not None and not events
    else:
        assert row.admission_digest is None and len(events) == 1
        assert events[0].event_type == "backup.export.download" and events[0].outcome == "attempt"


def test_stream_wall_deadline_interrupts_blocked_read_but_retains_open_descriptor(
    ready_export, monkeypatch
):
    world = ready_export
    assert world.admit().status_code == 200
    monkeypatch.setattr(downloads, "STREAM_SECONDS", 1.0)
    entered, release, read_exited = Event(), Event(), Event()
    opened, statuses = [], []
    original = downloads.prepare_artifact

    def prepare(*args, **kwargs):
        archive = original(*args, **kwargs)
        opened.append(archive)
        original_read = archive.read

        def read(size):
            entered.set()
            try:
                assert release.wait(10), "Owned physical read was not released"
                return original_read(size)
            finally:
                read_exited.set()

        monkeypatch.setattr(archive, "read", read)
        return archive

    monkeypatch.setattr(downloads, "prepare_artifact", prepare)

    async def execute():
        stopped = anyio.Event()
        digest = hashlib.sha256()
        receive = request_then_wait()

        async def send(message):
            if message["type"] == "http.response.start":
                statuses.append(message["status"])
            elif message.get("body"):
                digest.update(message["body"])

        async def request():
            try:
                await world.auth.client.app(content_scope(world), receive, send)
            finally:
                stopped.set()

        async with anyio.create_task_group() as group:
            group.start_soon(request)
            assert await anyio.to_thread.run_sync(entered.wait, 10), "Retained read was not reached"
            try:
                with anyio.fail_after(2):
                    await stopped.wait()
                assert statuses == [200] and digest.hexdigest() == hashlib.sha256().hexdigest()
                assert opened and not opened[0].closed
                busy = await anyio.to_thread.run_sync(
                    lambda: world.auth.client.get(
                        world.path + "/content", headers=world.native_headers
                    )
                )
                assert busy.status_code == 503 and busy.headers["retry-after"] == "5"
            finally:
                release.set()
            assert await anyio.to_thread.run_sync(read_exited.wait, 10)

    try:
        anyio.run(execute)
    finally:
        release.set()
        assert read_exited.wait(10)
    row, events = stored_export(world)
    assert row.admission_digest is None and len(events) == 1


def test_request_rollback_failure_releases_export_slot_without_consumption(
    ready_export, monkeypatch
):
    """Integration verification of the admitted post-acquisition setup correction."""
    world = ready_export
    assert world.admit().status_code == 200
    original = AuditSession.rollback
    remaining = [True]

    def fail_once(db):
        if remaining[0] and get_audit_context(db).request_path == world.path + "/content":
            remaining[0] = False
            raise SQLAlchemyError("Owned request rollback boundary")
        return original(db)

    monkeypatch.setattr(AuditSession, "rollback", fail_once)
    failed = world.auth.client.get(world.path + "/content", headers=world.native_headers)
    assert not remaining[0] and failed.status_code == 503
    assert failed.json()["detail"]["code"] == "export_unavailable"
    assert "content-disposition" not in failed.headers and failed.content != world.content
    row, events = stored_export(world)
    assert row.admission_digest is not None and not events
    monkeypatch.setattr(AuditSession, "rollback", original)
    retried = world.auth.client.get(world.path + "/content", headers=world.native_headers)
    assert retried.status_code == 200 and retried.content == world.content
    row, events = stored_export(world)
    assert row.admission_digest is None and len(events) == 1


def test_named_fifo_refuses_promptly_and_releases_physical_download_slot(ready_export, monkeypatch):
    import os
    from concurrent.futures import ThreadPoolExecutor
    from concurrent.futures import TimeoutError as FutureTimeout

    world = ready_export
    admission = world.admit()
    assert admission.status_code == 200
    world.artifact.unlink()
    os.mkfifo(world.artifact, 0o640)
    world.artifact.chmod(0o640)
    entered, exited = Event(), Event()
    original = os.open

    def observed_open(path, flags, *args, **kwargs):
        if path == f"{world.export_id}.tar":
            entered.set()
            try:
                return original(path, flags, *args, **kwargs)
            finally:
                exited.set()
        return original(path, flags, *args, **kwargs)

    monkeypatch.setattr(downloads.os, "open", observed_open)
    timely = False
    with ThreadPoolExecutor(max_workers=1) as requests:
        pending = requests.submit(
            world.auth.client.get, world.path + "/content", headers=world.native_headers
        )
        try:
            assert entered.wait(10), "Actual operation-named descriptor open was not reached"
            try:
                response = pending.result(timeout=1)
                timely = True
            except FutureTimeout:
                pass
        finally:
            # A real nonblocking read/write endpoint releases the pre-fix FIFO reader.
            # Cleanup never assumes cancellation can stop a physical os.open worker.
            writer = original(world.artifact, os.O_RDWR | os.O_NONBLOCK)
            try:
                response = pending.result(timeout=10)
            finally:
                os.close(writer)
    assert timely, "Nonregular export blocked before fstat instead of promptly refusing"
    assert response.status_code == 503 and "content-disposition" not in response.headers
    assert exited.is_set()
    row, events = stored_export(world)
    assert row.admission_digest is not None and not events
    world.artifact.unlink()
    world.artifact.write_bytes(world.content)
    world.artifact.chmod(0o640)
    restored = world.auth.client.get(world.path + "/content", headers=world.native_headers)
    assert restored.status_code == 200 and restored.content == world.content
