"""A response deadline must not release a still-running synchronous file worker."""

import asyncio
import json
from threading import Event, Lock
from types import SimpleNamespace

import pytest

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.core.middleware.file_transfers import FileDispatchMiddleware, FileTransferPolicy
from app.main import create_app
from app.systems.platform.files import service
from app.systems.platform.files.providers import transfer_slot
from app.systems.platform.files.storage import get_storage
from tests.organization_scope_support import scoped_override


@pytest.mark.parametrize("blocking_stage", ["provider", "dependency"])
@pytest.mark.parametrize("completion", ["deadline", "cancel"])
def test_interrupted_file_requests_keep_capacity_until_actual_work_finishes(
    monkeypatch, blocking_stage, completion
):
    import app.main as main

    started = [Event(), Event()]
    unblock = [Event(), Event()]
    calls = 0
    mutex = Lock()

    def blocked():
        nonlocal calls
        with mutex:
            index = calls
            calls += 1
        if index < 2:
            started[index].set()
            assert unblock[index].wait(timeout=10)

    def download(*args, **kwargs):
        if blocking_stage == "provider":
            blocked()
        return b"safe", "application/pdf", "document.pdf"

    def actor():
        if blocking_stage == "dependency":
            blocked()
        return SimpleNamespace(id="actor")

    monkeypatch.setattr(service, "download", download)
    monkeypatch.setattr(
        main, "file_transfer_policy", lambda path, method: FileTransferPolicy(1024, 0.15)
    )
    deadlines = []
    original_timeout = asyncio.timeout

    def timeout_after_admission(delay):
        # Exercise the real timeout/cancellation mechanism, but only after the
        # worker barriers establish the physical-capacity contract under test.
        timeout = original_timeout(None)
        deadlines.append(timeout)
        return timeout

    monkeypatch.setattr(main.asyncio, "timeout", timeout_after_admission)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_current_user] = scoped_override(actor)
    app.dependency_overrides[get_storage] = lambda: object()

    async def scenario():
        tasks = []

        def request():
            status = []
            done = asyncio.Event()
            reads = []

            async def receive():
                if not reads:
                    reads.append(True)
                    return {"type": "http.request", "body": b"", "more_body": False}
                await asyncio.Event().wait()

            async def send(message):
                if message["type"] == "http.response.start":
                    status.append(message["status"])
                    done.set()

            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.4"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/files/019c0000-0000-7000-8000-000000000001/content",
                "raw_path": b"/api/files/019c0000-0000-7000-8000-000000000001/content",
                "query_string": b"",
                "root_path": "",
                "headers": [(b"host", b"localhost")],
                "client": ("127.0.0.1", 1234),
                "server": ("localhost", 80),
            }
            task = asyncio.create_task(app(scope, receive, send))
            tasks.append(task)
            return task, status, done, reads

        try:
            first = request()
            assert await asyncio.to_thread(started[0].wait, 3), (first[1], calls, first[0].done())
            second = request()
            assert await asyncio.to_thread(started[1].wait, 3), (second[1], calls, second[0].done())
            if completion == "deadline":
                assert len(deadlines) == 2
                for timeout in deadlines:
                    timeout.reschedule(asyncio.get_running_loop().time())
                await asyncio.wait_for(first[2].wait(), 3)
                await asyncio.wait_for(second[2].wait(), 3)
                assert first[1] == second[1] == [504]
            else:
                first[0].cancel()
                second[0].cancel()
            third = request()
            await asyncio.wait_for(third[2].wait(), 3)
            assert third[1] == [503]
            assert third[3] == []  # Capacity rejected it before middleware read any body.
            assert calls == 2
            unblock[0].set()
            await asyncio.wait_for(asyncio.gather(first[0], return_exceptions=True), 3)
            recovered = request()
            await asyncio.wait_for(recovered[2].wait(), 3)
            assert recovered[1] == [200]
            assert calls == 3
        finally:
            for event in unblock:
                event.set()
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 5)

    asyncio.run(scenario())


@pytest.mark.parametrize("disconnect_on", ["http.response.start", "http.response.body"])
def test_disconnected_response_releases_transfer_capacity(monkeypatch, disconnect_on):
    monkeypatch.setattr(
        service, "download", lambda *args, **kwargs: (b"safe", "application/pdf", "file.pdf")
    )
    app = create_app()
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="actor")
    app.dependency_overrides[get_storage] = lambda: object()

    async def request(disconnect):
        status = []
        reads = []

        async def receive():
            if not reads:
                reads.append(True)
                return {"type": "http.request", "body": b"", "more_body": False}
            await asyncio.Event().wait()

        async def send(message):
            if message["type"] == "http.response.start":
                status.append(message["status"])
            if disconnect and message["type"] == disconnect_on:
                raise OSError("Client disconnected")

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/files/019c0000-0000-7000-8000-000000000001/content",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"host", b"localhost")],
            "client": ("127.0.0.1", 1234),
            "server": ("localhost", 80),
        }
        result = await asyncio.gather(app(scope, receive, send), return_exceptions=True)
        if not disconnect:
            assert result == [None]
        return status

    async def scenario():
        for _ in range(2):
            assert await request(True) == [200]
        assert await request(False) == [200]

    asyncio.run(scenario())


def test_a_route_dispatched_after_its_admission_closed_answers_files_busy_and_never_runs() -> None:
    # The request middleware closes admission when the request times out or is cancelled.
    with transfer_slot() as lease:
        pass
    routed: list[bool] = []
    messages: list[dict[str, object]] = []

    async def route(_scope, _receive, _send) -> None:
        routed.append(True)

    async def receive() -> dict[str, object]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, object]) -> None:
        messages.append(message)

    scope = {"type": "http", "state": {"file_transfer_lease": lease}}
    asyncio.run(FileDispatchMiddleware(route)(scope, receive, send))

    assert routed == []
    assert messages[0]["status"] == 503
    assert json.loads(messages[1]["body"])["detail"]["code"] == "files_busy"
