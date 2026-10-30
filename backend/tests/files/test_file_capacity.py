"""File transfer capacity (C3): a memory budget for bodies in memory, and processing slots.

Raw ASGI requests let a test hold a client mid-body or mid-download. Threading barriers
prove that work runs at the same time; their timeouts are hang guards only.
"""

import asyncio
import hashlib
from collections.abc import Callable
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event, Thread
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException, Request

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.platform.files import providers, service
from app.systems.platform.files import router as files_router
from app.systems.platform.files.storage import get_storage
from tests.files.transfer_support import uploaded_file

MIB = 1024 * 1024
FILE = "/api/files/019c0000-0000-7000-8000-000000000001/content"
GUARD = 10  # seconds; a hang guard, never a timing assertion


def _downloaded(*_args: object, **_kwargs: object) -> tuple[bytes, str, str]:
    return b"safe", "application/pdf", "file.pdf"


def _app(
    monkeypatch: pytest.MonkeyPatch,
    *,
    upload: Callable[..., object] = uploaded_file,
    download: Callable[..., object] = _downloaded,
) -> Any:
    monkeypatch.setattr(service, "upload", upload)
    monkeypatch.setattr(service, "download", download)
    app = create_app()
    actor = SimpleNamespace(id=uuid4())
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[files_router.get_upload_user] = lambda: actor
    app.dependency_overrides[get_storage] = lambda: object()
    return app


def _use_capacity(monkeypatch: pytest.MonkeyPatch, budget: int, slots: int = 4) -> Any:
    pool = providers.FileCapacity(budget, slots)
    monkeypatch.setattr(providers, "_pool", pool)
    return pool


class Exchange:
    """One raw ASGI request; ``body_gate`` pauses the body, ``read_gate`` pauses the reader."""

    def __init__(
        self,
        app: Any,
        method: str,
        *,
        body: bytes = b"",
        declared: int | None = None,
        chunked: bool = False,
        body_gate: asyncio.Event | None = None,
        read_gate: asyncio.Event | None = None,
    ) -> None:
        headers = [(b"host", b"localhost")]
        if declared is not None:
            headers.append((b"content-length", str(declared).encode()))
        if chunked:
            headers.append((b"transfer-encoding", b"chunked"))
        chunks = [body[:1024], body[1024:]] if body_gate is not None else [body]
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.body = b""
        self.body_reads = 0
        self.paused = asyncio.Event()  # the client stopped sending or reading

        async def receive() -> dict[str, object]:
            if self.body_reads < len(chunks):
                index = self.body_reads
                self.body_reads += 1
                if index == 1 and body_gate is not None:
                    self.paused.set()
                    await body_gate.wait()
                more = index + 1 < len(chunks)
                return {"type": "http.request", "body": chunks[index], "more_body": more}
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                self.status = message["status"]
                self.headers = {k.decode(): v.decode() for k, v in message["headers"]}
            if message["type"] == "http.response.body":
                self.body += message.get("body", b"")
                if read_gate is not None:
                    self.paused.set()
                    await read_gate.wait()

        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1", "method": method, "scheme": "http", "path": FILE,
            "raw_path": FILE.encode(), "query_string": b"", "root_path": "",
            "headers": headers, "client": ("127.0.0.1", 1234), "server": ("localhost", 80),
        }
        self.task = asyncio.create_task(app(scope, receive, send))

    async def finished(self) -> int | None:
        await asyncio.wait_for(asyncio.gather(self.task, return_exceptions=True), GUARD)
        return self.status


def _together(parties: int) -> Callable[..., tuple[bytes, str, str]]:
    """A download that returns only once ``parties`` downloads run at the same time."""
    barrier = Barrier(parties, timeout=GUARD)

    def download(*_args: object, **_kwargs: object) -> tuple[bytes, str, str]:
        barrier.wait()
        return _downloaded()

    return download


def test_a_slow_ten_mib_sender_holds_only_its_budget_while_four_transfers_proceed(monkeypatch):
    app = _app(monkeypatch, download=_together(4))

    async def scenario() -> None:
        resume = asyncio.Event()
        slow = Exchange(app, "PUT", body=b"x" * (10 * MIB), declared=10 * MIB, body_gate=resume)
        await asyncio.wait_for(slow.paused.wait(), GUARD)
        others = [Exchange(app, "GET") for _ in range(4)]
        assert [await other.finished() for other in others] == [200, 200, 200, 200]
        pool = providers.capacity()
        assert (pool.reserved, pool.busy_slots) == (10 * MIB, 0)
        resume.set()
        assert await slow.finished() == 200
        assert (pool.reserved, pool.busy_slots) == (0, 0)

    asyncio.run(scenario())


def test_b_a_slow_download_reader_holds_no_processing_slot(monkeypatch):
    together = _together(4)
    calls: list[bool] = []

    def download(*args: object, **kwargs: object) -> tuple[bytes, str, str]:
        calls.append(True)
        return _downloaded() if len(calls) == 1 else together()

    app = _app(monkeypatch, download=download)

    async def scenario() -> None:
        resume = asyncio.Event()
        reader = Exchange(app, "GET", read_gate=resume)
        await asyncio.wait_for(reader.paused.wait(), GUARD)
        others = [Exchange(app, "GET") for _ in range(4)]
        assert [await other.finished() for other in others] == [200, 200, 200, 200]
        assert providers.capacity().busy_slots == 0
        resume.set()
        assert await reader.finished() == 200
        assert reader.body == b"safe"

    asyncio.run(scenario())


def test_c_a_full_budget_answers_files_busy_before_reading_and_never_overspends(monkeypatch):
    app = _app(monkeypatch)
    pool = _use_capacity(monkeypatch, MIB)

    async def scenario() -> None:
        resume = asyncio.Event()
        holder = Exchange(app, "PUT", body=b"x" * MIB, declared=MIB, body_gate=resume)
        await asyncio.wait_for(holder.paused.wait(), GUARD)
        refused = Exchange(app, "PUT", body=b"y", declared=1)
        assert await refused.finished() == 503
        assert refused.headers["retry-after"] == "1"
        assert b'"code":"files_busy"' in refused.body
        assert refused.body_reads == 0
        assert pool.reserved == MIB
        resume.set()
        assert await holder.finished() == 200
        assert pool.reserved == 0
        assert await Exchange(app, "PUT", body=b"y", declared=1).finished() == 200

    asyncio.run(scenario())


def test_d_a_chunked_body_reserves_the_route_maximum(monkeypatch):
    app = _app(monkeypatch)
    pool = _use_capacity(monkeypatch, 15 * MIB)

    async def scenario() -> None:
        resume = asyncio.Event()
        chunked = Exchange(app, "PUT", body=b"x" * 2048, chunked=True, body_gate=resume)
        await asyncio.wait_for(chunked.paused.wait(), GUARD)
        assert pool.reserved == 10 * MIB
        assert await Exchange(app, "PUT", body=b"y" * 10, declared=6 * MIB).finished() == 503
        resume.set()
        assert await chunked.finished() == 200
        assert pool.reserved == 0

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("declared", "body"),
    [(10, b"x" * 20), (None, b"x" * 5)],
    ids=["false-small-content-length", "no-length-header"],
)
def test_d_a_body_past_its_declared_size_is_refused_with_413(monkeypatch, declared, body):
    uploads: list[bool] = []
    app = _app(monkeypatch, upload=lambda *_a, **_k: uploads.append(True))
    pool = _use_capacity(monkeypatch, MIB)

    async def scenario() -> None:
        assert await Exchange(app, "PUT", body=body, declared=declared).finished() == 413

    asyncio.run(scenario())
    assert uploads == []
    assert pool.reserved == 0


def test_a_download_reserves_its_file_size_until_the_response_is_sent(monkeypatch):
    from app.systems.platform.files.delivery import read_content

    content = b"abc"
    file = SimpleNamespace(
        state="ready", object_key="key", digest=hashlib.sha256(content).hexdigest(),
        actual_size=len(content), filename="a.txt", media_type="text/plain",
    )
    reads: list[str] = []

    class Storage:
        def download(self, key: str) -> bytes:
            reads.append(key)
            return content

    pool = _use_capacity(monkeypatch, 3)
    with providers.transfer_admission() as lease:
        request = Request({"type": "http", "state": {"file_transfer_lease": lease}})
        with providers.hold_file_worker(request):
            assert read_content(MagicMock(), file, Storage())[0] == content
        assert pool.reserved == 3  # the bytes stay in memory until the response is sent
        with providers.hold_file_worker(request):
            with pytest.raises(HTTPException) as refused:
                read_content(MagicMock(), file, Storage())
        assert refused.value.detail["code"] == "files_busy"
    assert reads == ["key"]
    assert (pool.reserved, pool.busy_slots) == (0, 0)


def test_f_capacity_returns_after_route_errors(monkeypatch):
    def broken(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("provider failed")

    def refused(*_args: object, **_kwargs: object) -> object:
        raise HTTPException(409, "Upload refused")

    app = _app(monkeypatch, upload=refused, download=broken)
    pool = providers.capacity()

    async def scenario() -> None:
        assert await Exchange(app, "PUT", body=b"x" * 2048, declared=2048).finished() == 409
        assert await Exchange(app, "GET").finished() == 500

    asyncio.run(scenario())
    assert (pool.reserved, pool.busy_slots) == (0, 0)


def _wait_for_capacity(monkeypatch: pytest.MonkeyPatch, slots: int = 1) -> tuple[Any, Event]:
    """``slots`` processing slots; ``waiting`` is set once a caller finds them all busy."""
    waiting = Event()

    class Observed(providers.FileCapacity):
        def _fits(self, size: int, slot: bool) -> bool:
            fits = super()._fits(size, slot)
            if not fits:
                waiting.set()
            return fits

    pool = Observed(256 * MIB, slots)
    monkeypatch.setattr(providers, "_pool", pool)
    return pool, waiting


@pytest.mark.parametrize("frees", [True, False], ids=["slot-frees", "wait-expires"])
def test_an_upload_waits_for_a_slot_before_its_dependencies_open_a_database_session(
    monkeypatch, frees
):
    # Five uploads, four slots: the fifth body is in memory and counted, and it queues on
    # the event loop. No dependency runs, so it holds no pooled connection while it waits.
    entered, release = Barrier(5, timeout=GUARD), Event()
    calls: list[bool] = []
    sessions: list[bool] = []

    def upload(*_args: object, **_kwargs: object) -> dict[str, object]:
        calls.append(True)
        if len(calls) <= 4:  # Four uploads hold every processing slot.
            entered.wait()
            assert release.wait(GUARD)
        return uploaded_file()

    app = _app(monkeypatch, upload=upload)
    app.dependency_overrides[get_db] = lambda: sessions.append(True) or object()
    pool, waiting = _wait_for_capacity(monkeypatch, slots=4)
    if not frees:
        monkeypatch.setattr(providers, "SLOT_WAIT_SECONDS", 0.05)

    async def scenario() -> None:
        holders = [Exchange(app, "PUT", body=b"x" * 10, declared=10) for _ in range(4)]
        await asyncio.to_thread(entered.wait)
        fifth = Exchange(app, "PUT", body=b"y" * 10, declared=10)
        if frees:
            assert await asyncio.to_thread(waiting.wait, GUARD)
            assert fifth.body_reads == 1 and fifth.status is None
            assert len(sessions) == 4  # The waiting upload has not opened a session.
            release.set()
            assert await fifth.finished() == 200
            assert len(sessions) == 5
        else:
            assert await fifth.finished() == 503
            assert fifth.headers["retry-after"] == "1"
            assert b'"code":"files_busy"' in fifth.body
            assert fifth.body_reads == 1  # Refused after its body arrived, not before.
            assert (len(calls), len(sessions)) == (4, 4)
            release.set()
        assert [await holder.finished() for holder in holders] == [200, 200, 200, 200]

    asyncio.run(scenario())
    assert (pool.reserved, pool.busy_slots) == (0, 0)


def _run_at_a_busy_moment(monkeypatch: pytest.MonkeyPatch, call: Callable[[], object]) -> object:
    pool, waiting = _wait_for_capacity(monkeypatch)
    results: list[object] = []
    with ExitStack() as busy:
        busy.enter_context(providers.file_processing(wait_seconds=0))
        worker = Thread(target=lambda: results.append(call()))
        worker.start()
        assert waiting.wait(GUARD)
    worker.join(GUARD)
    assert not worker.is_alive()
    assert (pool.reserved, pool.busy_slots) == (0, 0)
    return results[0] if results else None


def test_e_a_logo_save_that_meets_busy_slots_waits_and_saves(monkeypatch):
    from app.systems.manage.workspace import router as workspace
    from app.systems.manage.workspace.schemas import WorkspaceUpdate

    monkeypatch.setattr(workspace, "_save_workspace", lambda *_args: "saved")
    payload = WorkspaceUpdate(revision=1, logo_file_id=uuid4())
    actor = SimpleNamespace(id=uuid4())

    result = _run_at_a_busy_moment(
        monkeypatch, lambda: workspace.update_workspace(payload, actor, MagicMock())
    )
    assert result == "saved"


def test_e_a_comms_export_that_meets_busy_slots_waits_and_succeeds(monkeypatch):
    from app.systems.comms.jobs import export_service, export_worker
    from app.systems.platform.scheduling.models import WorkState
    from app.systems.platform.scheduling.service import WorkClaim

    org, identity = uuid4(), uuid4()
    job = SimpleNamespace(
        id=identity, request={}, artifact_key=None, artifact_size=None,
        artifact_sha256=None, artifact_upload_confirmed=False,
    )
    work = SimpleNamespace(
        lease_expires_at=datetime.now(UTC) + timedelta(minutes=2), state=WorkState.RUNNING,
        finished_at=None, failure_code=None, lease_token=uuid4(),
    )
    failures: list[Exception] = []
    monkeypatch.setattr(export_worker, "_session", lambda *_args: MagicMock())
    monkeypatch.setattr(export_worker, "_claim", lambda *_args: WorkClaim(uuid4(), uuid4()))
    monkeypatch.setattr(export_worker, "_locked", lambda *_args: (job, work, SimpleNamespace()))
    monkeypatch.setattr(export_worker, "_message_rows", lambda *_args: iter(()))
    monkeypatch.setattr(export_worker, "encode", lambda *_args, **_kwargs: b"csv bytes")
    monkeypatch.setattr(
        export_worker, "CommsExportRequest",
        SimpleNamespace(model_validate=lambda _request: SimpleNamespace(format="csv")),
    )
    monkeypatch.setattr(export_service, "current_sources", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(export_worker, "_failed", lambda *args: failures.append(args[-1]))
    objects: dict[str, bytes] = {}
    storage = SimpleNamespace(
        upload=lambda key, content, _media: objects.__setitem__(key, content),
        download=objects.get,
    )

    _run_at_a_busy_moment(
        monkeypatch,
        lambda: export_worker.run_export_job(MagicMock(), org, identity, storage=storage),
    )
    assert failures == []
    assert work.state == WorkState.SUCCEEDED
    assert objects == {f"org/{org}/{identity.hex}": b"csv bytes"}
