"""Provider boundary proves immutable requests and bounded/controlled failure behavior."""

from unittest.mock import patch

import httpx
import pytest

from app.core.config import Settings
from app.systems.files.providers import ProviderUnavailable
from app.systems.files.storage import SupabaseStorage
from tests.config_support import settings_values


def _settings(**overrides: object) -> Settings:
    return Settings(**settings_values(**overrides), _env_file=None)


def storage(handler, *, real=False):
    from contextlib import contextmanager
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    original = httpx.Client

    def client(**kwargs):
        return original(transport=httpx.MockTransport(handler), **kwargs)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            response = handler(
                httpx.Request("GET", "http://storage.test" + self.path, headers=dict(self.headers))
            )
            self.send_response(response.status_code)
            for name, value in response.headers.items():
                if name.lower() != "content-length":
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(response.content)))
            self.end_headers()
            self.wfile.write(response.content)

        def log_message(self, *args):
            pass

    provider = SupabaseStorage(
        _settings(supabase_url="http://storage.test", supabase_secret_key="test")
    )

    @contextmanager
    def context():
        if not real:
            with patch("app.systems.files.storage.httpx.Client", client):
                yield
            return
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever)
        thread.start()
        provider.base_url = f"http://127.0.0.1:{server.server_port}"
        try:
            with patch("app.systems.files.storage.httpx.Client", client):
                yield
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)

    return provider, context()


def child_reply(provider, max_bytes=25 * 1024 * 1024):
    import io
    import json
    from types import SimpleNamespace

    from app.systems.files import storage_download_client

    request = json.dumps(
        {
            "url": provider.base_url + provider._path("opaque"),
            "headers": provider.headers,
            "max_bytes": max_bytes,
        }
    ).encode()
    output = io.BytesIO()
    with (
        patch.object(
            storage_download_client.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(request))
        ),
        patch.object(storage_download_client.sys, "stdout", SimpleNamespace(buffer=output)),
    ):
        storage_download_client.main()
    return output.getvalue()


def test_upload_uses_generated_key_without_overwrite():
    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/storage/v1/object/openslate-files/opaque"
        assert request.headers["x-upsert"] == "false"
        assert request.content == b"content"
        return httpx.Response(200)

    provider, context = storage(handler)
    with context:
        provider.upload("opaque", b"content", "application/pdf")


def test_unknown_write_outcome_is_not_retried():
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("transport failed")

    provider, context = storage(handler)
    with context, pytest.raises(ProviderUnavailable):
        provider.upload("opaque", b"content", "application/pdf")
    assert len(calls) == 1


def test_absent_object_returns_none_and_delete_is_repeatable():
    provider, context = storage(
        lambda request: httpx.Response(404, json={"code": "NoSuchKey"}), real=True
    )
    with context:
        assert provider.download("opaque") is None
        provider.delete("opaque")
        provider.delete("opaque")


def test_download_excess_is_rejected():
    provider, context = storage(lambda request: httpx.Response(200, content=b"oversized"))
    with context:
        assert child_reply(provider, max_bytes=4) == b"E\0\0\0\0"


def test_supabase_legacy_http400_no_such_key_is_confirmed_absence():
    provider, context = storage(
        lambda request: httpx.Response(
            400,
            json={
                "code": "NoSuchKey",
                "statusCode": "404",
                "error": "not_found",
                "message": "Object not found",
            },
        )
    )
    with context:
        assert child_reply(provider) == b"N\0\0\0\0"
        provider.delete("opaque")


@pytest.mark.parametrize(
    "status,payload",
    [
        (400, {"code": "AccessDenied", "statusCode": "403"}),
        (404, {"code": "NoSuchBucket", "statusCode": "404"}),
        (400, {"error": "not_found", "statusCode": "404"}),
    ],
)
def test_provider_errors_do_not_masquerade_as_deleted_objects(status, payload):
    provider, context = storage(lambda request: httpx.Response(status, json=payload))
    with context:
        assert child_reply(provider) == b"E\0\0\0\0"
        with pytest.raises(ProviderUnavailable):
            provider.delete("opaque")


@pytest.mark.parametrize("send_headers", [False, True])
def test_download_deadline_closes_physical_connection_and_releases_capacity(
    monkeypatch, send_headers
):
    import socket
    import subprocess
    from threading import Event, Thread
    from time import monotonic

    from app.systems.files.providers import transfer_slot

    original = subprocess.Popen
    children = []

    def spawn(*args, **kwargs):
        child = original(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr("app.systems.files.storage.subprocess.Popen", spawn)
    monkeypatch.setattr("app.systems.files.storage.DOWNLOAD_SECONDS", 5, raising=False)
    accepted, closed = Event(), Event()
    socket_errors = []
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(8)

    def serve():
        try:
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(8)
                connection.recv(8192)
                accepted.set()
                if send_headers:
                    connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 60000\r\n\r\nx")
                if send_headers:
                    from select import select

                    watchdog = monotonic() + 8
                    while monotonic() < watchdog:
                        # Deliberately trickle less than a client chunk across the budget.
                        if select([connection], [], [], 0.05)[0]:
                            if connection.recv(1) == b"":
                                closed.set()
                            break
                        connection.sendall(b"x")
                elif connection.recv(1) == b"":
                    closed.set()
        except (ConnectionResetError, BrokenPipeError):
            # Killing a connected peer may reset TCP rather than deliver EOF.
            closed.set()
        except (TimeoutError, OSError) as error:
            socket_errors.append(type(error).__name__)

    thread = Thread(target=serve)
    thread.start()
    provider = SupabaseStorage(
        _settings(
            supabase_url=f"http://127.0.0.1:{listener.getsockname()[1]}",
            supabase_secret_key="owned-test-secret",
        )
    )
    started = monotonic()
    try:
        with transfer_slot() as lease, transfer_slot():
            with lease.retain_worker(), pytest.raises(ProviderUnavailable):
                provider.download("opaque")
        assert accepted.is_set()
        assert len(children) == 1 and children[0].returncode is not None
        assert monotonic() - started < 5
        assert closed.wait(1), f"socket closure unconfirmed: {socket_errors}"
        with transfer_slot(), transfer_slot():
            pass
    finally:
        listener.close()
        thread.join(9)
        assert not thread.is_alive()


@pytest.mark.parametrize(
    "reply,exit_code",
    [
        (b"", 0),
        (b"D\0\0\0\x02x", 0),
        (b"N\0\0\0\x01x", 0),
        (b"X\0\0\0\0", 0),
        (b"D\0\0\0\0", 1),
    ],
)
def test_invalid_child_response_is_unavailable(monkeypatch, reply, exit_code):
    from unittest.mock import Mock

    child = Mock(returncode=exit_code)
    child.communicate.return_value = (reply, None)
    monkeypatch.setattr("app.systems.files.storage.subprocess.Popen", Mock(return_value=child))
    provider = SupabaseStorage(
        _settings(supabase_url="http://storage.test", supabase_secret_key="test")
    )
    with pytest.raises(ProviderUnavailable):
        provider.download("opaque")


def test_unreaped_child_fences_new_downloads_and_keeps_secrets_off_argv(monkeypatch):
    import subprocess
    from unittest.mock import Mock

    from app.systems.files import providers

    monkeypatch.setattr(providers, "_storage_cleanup_uncertain", False)
    monkeypatch.setenv("UNRELATED_DATABASE_SECRET", "must-not-inherit")
    child = Mock()
    child.communicate.side_effect = subprocess.TimeoutExpired("fixed child", 1)
    spawn = Mock(return_value=child)
    monkeypatch.setattr("app.systems.files.storage.subprocess.Popen", spawn)
    provider = SupabaseStorage(
        _settings(supabase_url="http://private-storage.test", supabase_secret_key="private-secret")
    )
    with pytest.raises(providers.StorageCleanupUncertain):
        provider.download("private-key")
    child.kill.assert_called_once()
    assert providers._storage_cleanup_uncertain
    with pytest.raises(providers.StorageCleanupUncertain):
        provider.download("another-key")
    spawn.assert_called_once()
    assert "private" not in str(spawn.call_args.args)
    assert "UNRELATED_DATABASE_SECRET" not in spawn.call_args.kwargs["env"]
    assert spawn.call_args.kwargs["stderr"] == subprocess.DEVNULL
    request = child.communicate.call_args_list[0].args[0]
    assert b"private-secret" in request and b"private-key" in request


def test_successful_download_crosses_child_boundary():
    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/storage/v1/object/openslate-files/opaque"
        assert request.headers["apikey"] == "test"
        assert request.headers["authorization"] == "Bearer test"
        return httpx.Response(200, content=b"exact bytes")

    provider, context = storage(handler, real=True)
    with context:
        assert child_reply(provider) == b"D\0\0\0\x0bexact bytes"
        assert provider.download("opaque") == b"exact bytes"


@pytest.mark.parametrize("program", ["import os; os._exit(7)", "print('malformed')"])
def test_real_child_crash_or_malformed_frame_is_unavailable(monkeypatch, program):
    import subprocess
    import sys

    original = subprocess.Popen
    children = []

    def spawn(*args, **kwargs):
        child = original([sys.executable, "-c", program], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr("app.systems.files.storage.subprocess.Popen", spawn)
    provider = SupabaseStorage(
        _settings(supabase_url="http://storage.test", supabase_secret_key="test")
    )
    with pytest.raises(ProviderUnavailable):
        provider.download("opaque")
    assert len(children) == 1 and children[0].poll() is not None


def test_download_redirect_is_not_followed_or_retried():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(302, headers={"Location": "/unexpected"})

    provider, context = storage(handler, real=True)
    with context, pytest.raises(ProviderUnavailable):
        provider.download("opaque")
    assert len(calls) == 1


def test_oversized_absence_error_is_not_trusted():
    provider, context = storage(
        lambda request: httpx.Response(
            404, content=b'{"code":"NoSuchKey","padding":"' + b"x" * 8192 + b'"}'
        )
    )
    with context:
        assert child_reply(provider) == b"E\0\0\0\0"
