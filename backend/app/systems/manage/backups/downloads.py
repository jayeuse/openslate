"""Cookie-bound native exports with a confined descriptor and physical transfer lease."""

import hashlib
import hmac
import os
import stat
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from threading import BoundedSemaphore, Lock
from time import monotonic
from typing import BinaryIO, TypeVar, cast
from uuid import UUID

import anyio
from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.responses import Response
from starlette.types import Message, Receive, Scope, Send

from app.common.dependencies import CurrentIdentity, get_current_identity, require_fresh_exact_admin
from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase_auth import InvalidProviderToken, get_supabase_auth_client
from app.systems.access.identity.models import IdentitySession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, get_audit_context
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.backups import service
from app.systems.manage.backups.models import BackupExportOperation
from app.systems.manage.workspace.security_policy import (
    effective_session_expiry,
    load_workspace_policy,
)

EXPORT_GROUP = 10001
CHUNK_BYTES = 1024 * 1024
PREPARATION_SECONDS = 300
STREAM_SECONDS = 7200
SEND_SECONDS = 30
_slots = BoundedSemaphore(1)
T = TypeVar("T")


def error(code: str, status: int) -> HTTPException:
    messages = {
        "export_not_found": "Export was not found",
        "export_not_ready": "Export is not ready",
        "export_expired": "Export has expired",
        "export_admission_required": "Confirm your password again",
        "export_navigation_required": "Use the explicit Download action",
        "export_range_unsupported": "Partial downloads are not supported",
        "export_transfer_busy": "An export download is already in progress",
        "export_preparation_timeout": "Export preparation timed out",
        "export_artifact_invalid": "Export archive is unavailable",
        "export_unavailable": "Export service is unavailable",
        "export_password_invalid": "The supplied password is invalid",
        "export_password_rate_limited": "Password verification is rate limited",
    }
    headers = {"Cache-Control": "no-store"}
    if code == "export_transfer_busy":
        headers["Retry-After"] = "5"
    return HTTPException(
        status,
        detail={"code": code, "message": messages.get(code, "Export is unavailable")},
        headers=headers,
    )


class ExportLease:
    """The one slot and descriptor remain owned until physical workers have stopped."""

    def __init__(self) -> None:
        if not _slots.acquire(blocking=False):
            raise error("export_transfer_busy", 503)
        self._lock, self._open, self._references = Lock(), True, 1
        self.file: BinaryIO | None = None

    @contextmanager
    def worker(self) -> Iterator[None]:
        with self._lock:
            if not self._open:
                raise OSError("Export request ended")
            self._references += 1
        try:
            yield
        finally:
            with self._lock:
                self._release()

    def _release(self) -> None:
        self._references -= 1
        if self._references == 0:
            try:
                if self.file is not None:
                    self.file.close()
            finally:
                _slots.release()

    def release(self) -> None:
        with self._lock:
            if self._open:
                self._open = False
                self._release()

    def alive(self) -> bool:
        with self._lock:
            return self._open

    def run(self, callback: Callable[[], T]) -> T:
        with self.worker():
            return callback()


def prepare_artifact(
    root: Path, export_id: UUID, size: int, digest: str, lease: ExportLease
) -> BinaryIO:
    started = monotonic()
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        directory = os.fstat(root_fd)
        if stat.S_IMODE(directory.st_mode) != 0o750 or directory.st_gid != EXPORT_GROUP:
            raise OSError("Unsafe export root")
        fd = os.open(
            f"{export_id}.tar", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd
        )
    finally:
        os.close(root_fd)
    archive = os.fdopen(fd, "rb")
    lease.file = archive
    before = os.fstat(fd)
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or before.st_size != size
        or stat.S_IMODE(before.st_mode) != 0o640
        or before.st_uid != directory.st_uid
        or before.st_gid != directory.st_gid
    ):
        raise OSError("Unsafe export artifact")
    checksum = hashlib.sha256()
    while True:
        if not lease.alive():
            raise OSError("Export request ended")
        if monotonic() - started >= PREPARATION_SECONDS:
            raise TimeoutError("Export preparation deadline")
        chunk = archive.read(CHUNK_BYTES)
        if not chunk:
            break
        checksum.update(chunk)
    after = os.fstat(fd)

    def identity(item: os.stat_result) -> tuple[int, ...]:
        return (
            item.st_dev,
            item.st_ino,
            item.st_size,
            item.st_mtime_ns,
            item.st_ctime_ns,
            item.st_mode,
            item.st_uid,
            item.st_gid,
            item.st_nlink,
        )

    if identity(before) != identity(after) or not hmac.compare_digest(checksum.hexdigest(), digest):
        raise OSError("Export verification failed")
    if monotonic() - started >= PREPARATION_SECONDS:
        raise TimeoutError("Export preparation deadline")
    archive.seek(0)
    return archive


def locked_identity(db: Session, request: Request) -> tuple[CurrentIdentity, datetime]:
    identity = get_current_identity(request, None, db)
    if not identity.cookie_authenticated:
        raise error("export_admission_required", 403)
    actor = require_fresh_exact_admin(db, identity.user.id)
    try:
        claims = get_supabase_auth_client().verify_access_token(
            request.cookies.get("openslate_access", "")
        )
    except InvalidProviderToken as cause:
        raise HTTPException(401, detail="Invalid authentication credentials") from cause
    session = db.scalar(
        select(IdentitySession)
        .where(IdentitySession.id == identity.session_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    now = cast(datetime, db.scalar(select(func.clock_timestamp())))
    if (
        session is None
        or session.user_id != actor.id
        or session.provider_user_id != claims.user_id
        or session.provider_session_id != claims.session_id
        or session.revoked_at is not None
        or actor.supabase_user_id != claims.user_id
        or claims.expires_at <= now
        or (actor.tokens_valid_after is not None and claims.issued_at < actor.tokens_valid_after)
    ):
        raise HTTPException(401, detail="Invalid authentication credentials")
    expiry = min(effective_session_expiry(session, load_workspace_policy(db)), claims.expires_at)
    if expiry <= now:
        raise HTTPException(401, detail="Invalid authentication credentials")
    return identity, expiry


def ready_operation(db: Session, export_id: UUID) -> BackupExportOperation:
    instance = service.installation_id(db)
    row = db.scalar(
        select(BackupExportOperation)
        .where(
            BackupExportOperation.id == export_id, BackupExportOperation.installation_id == instance
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise error("export_not_found", 404)
    if row.expires_at is not None and row.expires_at <= cast(
        datetime, db.scalar(select(func.clock_timestamp()))
    ):
        raise error("export_expired", 410)
    if row.state != "ready" or row.artifact_deleted_at is not None:
        raise error("export_not_ready", 409)
    return row


def _admitted(db: Session, request: Request, export_id: UUID) -> BackupExportOperation:
    identity, expiry = locked_identity(db, request)
    row = ready_operation(db, export_id)
    cookie = request.cookies.get("openslate_export_admission", "")
    digest = hashlib.sha256(cookie.encode()).hexdigest()
    now = cast(datetime, db.scalar(select(func.clock_timestamp())))
    if expiry <= now:
        raise HTTPException(401, detail="Invalid authentication credentials")
    if (
        not cookie
        or row.admission_digest is None
        or not hmac.compare_digest(row.admission_digest, digest)
        or row.admission_actor_id != identity.user.id
        or row.admission_session_id != identity.session_id
        or row.admission_expires_at is None
        or row.admission_expires_at <= now
    ):
        raise error("export_admission_required", 403)
    return row


def _snapshot(db: Session, request: Request, export_id: UUID) -> tuple[int, str]:
    try:
        row = _admitted(db, request, export_id)
        assert row.size_bytes is not None and row.sha256 is not None
        return row.size_bytes, row.sha256
    finally:
        db.rollback()


def _consume(
    db: Session, request: Request, export_id: UUID, facts: tuple[int, str], lease: ExportLease
) -> None:
    try:
        row = _admitted(db, request, export_id)
        if (row.size_bytes, row.sha256) != facts:
            raise error("export_artifact_invalid", 503)
        actor = row.admission_actor_id
        row.admission_digest = row.admission_actor_id = row.admission_session_id = (
            row.admission_expires_at
        ) = None
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="backup.export.download",
                outcome=SecurityEventOutcome.ATTEMPT,
                source="backup",
                operation_id=export_id,
                actor_id=actor,
                subject_id=export_id,
                metadata={
                    "backup_run_id": str(row.backup_run_id),
                    "size_bytes": facts[0],
                    "sha256": facts[1],
                },
            ),
        )
        if not lease.alive():
            raise TimeoutError("Export preparation deadline")
        db.commit()
    except BaseException:
        db.rollback()
        raise


class ExportStreamResponse(Response):
    def __init__(self, lease: ExportLease, archive: BinaryIO, export_id: UUID, size: int) -> None:
        super().__init__(
            media_type="application/octet-stream",
            headers={
                "Content-Length": str(size),
                "Content-Disposition": (
                    f'attachment; filename="openslate-backup-export-{export_id}.tar"'
                ),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Accept-Ranges": "none",
            },
        )
        self.lease, self.archive = lease, archive
        self.started, self.outer_owned = monotonic(), False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        started = self.started

        async def stream() -> None:
            try:
                with anyio.fail_after(SEND_SECONDS):
                    await send(
                        {
                            "type": "http.response.start",
                            "status": self.status_code,
                            "headers": self.raw_headers,
                        }
                    )
                while monotonic() - started < STREAM_SECONDS:
                    chunk = await anyio.to_thread.run_sync(
                        lambda: self.lease.run(lambda: self.archive.read(CHUNK_BYTES)),
                        abandon_on_cancel=True,
                    )
                    if monotonic() - started >= STREAM_SECONDS:
                        return
                    with anyio.fail_after(
                        min(SEND_SECONDS, STREAM_SECONDS - (monotonic() - started))
                    ):
                        await send(
                            {"type": "http.response.body", "body": chunk, "more_body": bool(chunk)}
                        )
                    if not chunk:
                        return
            except (OSError, TimeoutError):
                return
            finally:
                group.cancel_scope.cancel()

        async def disconnected() -> None:
            while (await receive())["type"] != "http.disconnect":
                pass
            group.cancel_scope.cancel()

        try:
            with anyio.fail_after(STREAM_SECONDS):
                async with anyio.create_task_group() as group:
                    group.start_soon(disconnected)
                    await stream()
        except TimeoutError:
            return
        finally:
            if not self.outer_owned:
                self.lease.release()


class ExportTransportResponse(Response):
    """Own the actual network send outside call_next's internal memory stream."""

    def __init__(self, response: Response, stream: ExportStreamResponse) -> None:
        super().__init__(status_code=response.status_code)
        self.raw_headers = response.raw_headers
        self.response, self.stream = response, stream

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def bounded_send(message: Message) -> None:
            remaining = STREAM_SECONDS - (monotonic() - self.stream.started)
            with anyio.fail_after(min(SEND_SECONDS, max(0, remaining))):
                await send(message)

        try:
            remaining = STREAM_SECONDS - (monotonic() - self.stream.started)
            with anyio.fail_after(max(0, remaining)):
                await self.response(scope, receive, bounded_send)
        except TimeoutError:
            return
        finally:
            self.stream.lease.release()


def release_export_response(request: Request) -> None:
    stream = getattr(request.state, "backup_export_stream", None)
    if isinstance(stream, ExportStreamResponse):
        stream.lease.release()


def wrap_export_response(request: Request, response: Response) -> Response:
    stream = getattr(request.state, "backup_export_stream", None)
    if not isinstance(stream, ExportStreamResponse):
        return response
    if response.status_code != 200:
        stream.lease.release()
        return response
    stream.outer_owned = True
    return ExportTransportResponse(response, stream)


async def content_response(db: Session, request: Request, export_id: UUID) -> Response:
    if "range" in request.headers:
        raise error("export_range_unsupported", 416)
    if request.headers.get("sec-fetch-mode", "navigate") != "navigate" or any(
        word
        in (request.headers.get("purpose", "") + request.headers.get("sec-purpose", "")).lower()
        for word in ("prefetch", "prerender")
    ):
        raise error("export_navigation_required", 403)
    lease = ExportLease()
    handed_off = False

    def database_worker(callback: Callable[[Session], T]) -> T:
        # This physical worker owns its SQL Session even after the ASGI await ends.
        with lease.worker(), AuditSession(get_engine()) as worker_db:
            worker_db.info[AUDIT_CONTEXT_KEY] = replace(context)
            return callback(worker_db)

    try:
        context = replace(get_audit_context(db))
        db.rollback()
        with anyio.fail_after(PREPARATION_SECONDS):
            facts = await anyio.to_thread.run_sync(
                lambda: database_worker(lambda worker_db: _snapshot(worker_db, request, export_id)),
                abandon_on_cancel=True,
            )
            archive = await anyio.to_thread.run_sync(
                lambda: lease.run(
                    lambda: prepare_artifact(
                        get_settings().backup_export_root, export_id, *facts, lease
                    )
                ),
                abandon_on_cancel=True,
            )
            await anyio.to_thread.run_sync(
                lambda: database_worker(
                    lambda worker_db: _consume(worker_db, request, export_id, facts, lease)
                ),
                abandon_on_cancel=True,
            )
        response = ExportStreamResponse(lease, archive, export_id, facts[0])
        request.state.backup_export_stream = response
        handed_off = True
        return response
    except TimeoutError as cause:
        raise error("export_preparation_timeout", 504) from cause
    except OSError as cause:
        raise error("export_artifact_invalid", 503) from cause
    except (SQLAlchemyError, service.BackupStateError) as cause:
        raise error("export_unavailable", 503) from cause
    finally:
        if not handed_off:
            lease.release()
