"""Deterministic DNS/socket boundaries: no test in this package may probe a public/private host."""

import io
import socket
import ssl
from dataclasses import dataclass, field

import pytest

from tests.comms.jobs.conftest import job_routes as job_routes
from tests.comms.routes.conftest import message_routes as message_routes


def answer(address, port=443):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    destination = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", destination)


def response(body=b"<title>Owned title</title>", *, status=200, headers=None, length=True):
    values = [("Content-Type", "text/html; charset=utf-8"), ("Connection", "close")]
    if length:
        values.append(("Content-Length", str(len(body))))
    values.extend(headers or [])
    return (
        f"HTTP/1.1 {status} Fixture\r\n".encode()
        + b"".join(f"{name}: {value}\r\n".encode() for name, value in values)
        + b"\r\n"
        + body
    )


@dataclass
class Wire:
    replies: list[bytes] = field(default_factory=lambda: [response()])
    answers: list = field(default_factory=lambda: [answer("93.184.216.34")])
    resolutions: list[str] = field(default_factory=list)
    resolver_policies: list = field(default_factory=list)
    connections: list = field(default_factory=list)
    tls: list = field(default_factory=list)
    now: float = 0.0
    dns_seconds: float = 0.0
    connect_seconds: float = 0.0
    tls_seconds: float = 0.0
    read_seconds: float = 0.0
    peer: str | None = None
    certificate_failure: bool = False
    dns_failure: bool = False
    connect_failure: bool = False

    def resolve(self, host, port, *args, **kwargs):
        self.resolutions.append(host)
        self.resolver_policies.append(
            (
                kwargs.get("family", args[0] if args else 0),
                kwargs.get("type", args[1] if len(args) > 1 else 0),
                kwargs.get("proto", args[2] if len(args) > 2 else 0),
                kwargs.get("flags", args[3] if len(args) > 3 else 0),
            )
        )
        self.now += self.dns_seconds
        if self.dns_failure:
            raise socket.gaierror("Owned DNS failure")
        return [
            (family, kind, proto, canonical, (value[0], port, *value[2:]))
            for family, kind, proto, canonical, value in self.answers
        ]

    def open_socket(self, family, kind, proto=0):
        owner = self

        class Stream(io.BytesIO):
            def read(self, size=-1):
                owner.now += owner.read_seconds
                return super().read(size)

        class Socket:
            def __init__(self):
                self.family = family
                self.destination = None
                self.sent = []
                self.timeouts = []
                self.closed = False

            def connect(self, destination):
                owner.now += owner.connect_seconds
                self.destination = destination
                if owner.connect_failure:
                    raise OSError("Owned connection failure")

            def settimeout(self, timeout):
                self.timeouts.append(timeout)

            def setsockopt(self, *_args):
                pass

            def getpeername(self):
                return (owner.peer or self.destination[0], self.destination[1])

            def sendall(self, content):
                self.sent.append(bytes(content))

            def makefile(self, *_args, **_kwargs):
                return Stream(
                    owner.replies[min(len(owner.connections) - 1, len(owner.replies) - 1)]
                )

            def close(self):
                self.closed = True

        result = Socket()
        self.connections.append(result)
        return result


@pytest.fixture
def wire(monkeypatch):
    from app.systems.comms.previews import fetch

    value = Wire()
    monkeypatch.setattr(fetch, "resolve", value.resolve)
    monkeypatch.setattr(fetch, "open_socket", value.open_socket)
    monkeypatch.setattr(fetch, "clock", lambda: value.now)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("An unchecked hostname connection/resolution was attempted")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)

    def wrap(context, sock, *, server_hostname, **_kwargs):
        # Real SSLContext configuration, not copied fixture booleans.
        assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
        value.tls.append(server_hostname)
        value.now += value.tls_seconds
        if value.certificate_failure:
            raise ssl.SSLCertVerificationError("Owned certificate refusal")
        return sock

    monkeypatch.setattr(ssl.SSLContext, "wrap_socket", wrap)
    return value
