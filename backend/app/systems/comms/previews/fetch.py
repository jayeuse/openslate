"""One public pinned HTTP(S) request; production invokes this only inside the bounded child."""

import http.client
import ipaddress
import socket
import ssl
import zlib
from time import monotonic

from app.systems.comms.previews.metadata import extract
from app.systems.comms.previews.urls import Address, Target, public_address, target

resolve = socket.getaddrinfo
open_socket = socket.socket
tls_context = ssl.create_default_context
clock = monotonic
MAX_BYTES = 512 * 1024
MAX_DNS_ANSWERS = 16


class Refused(ValueError):
    """No private source detail belongs in this exception."""


def remaining(deadline: float) -> float:
    value = deadline - clock()
    if value <= 0:
        raise TimeoutError()
    return value


def _address(value: Target, deadline: float) -> Address:
    remaining(deadline)
    if value.literal is not None:
        return value.literal
    answers = resolve(
        value.host + ".",
        value.port,
        family=socket.AF_UNSPEC,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
        flags=0,
    )
    remaining(deadline)
    if not answers or len(answers) > MAX_DNS_ANSWERS:
        raise Refused()
    addresses = []
    for family, kind, protocol, _canonical, destination in answers:
        if not isinstance(destination[0], str):
            raise Refused()
        address = public_address(destination[0])
        if (
            address is None
            or kind != socket.SOCK_STREAM
            or protocol != socket.IPPROTO_TCP
            or destination[1] != value.port
            or family != (socket.AF_INET if address.version == 4 else socket.AF_INET6)
            or (family == socket.AF_INET6 and any(destination[2:]))
        ):
            raise Refused()
        addresses.append(address)
    return addresses[0]  # One attempt; never retry through an unchecked hostname or fallback.


class _Pinned(http.client.HTTPConnection):
    def __init__(self, value: Target, address: Address, deadline: float) -> None:
        super().__init__(value.host, value.port, timeout=remaining(deadline))
        self.value, self.address, self.deadline = value, address, deadline

    def connect(self) -> None:
        family = socket.AF_INET if self.address.version == 4 else socket.AF_INET6
        stream = open_socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
        try:
            stream.settimeout(remaining(self.deadline))
            destination = (str(self.address), self.port)
            stream.connect(destination if family == socket.AF_INET else (*destination, 0, 0))
            if ipaddress.ip_address(stream.getpeername()[0]) != self.address:
                raise Refused()
            if self.value.scheme == "https":
                context = tls_context()
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                context.set_alpn_protocols(["http/1.1"])
                stream.settimeout(remaining(self.deadline))
                stream = context.wrap_socket(stream, server_hostname=self.value.host)
                if ipaddress.ip_address(stream.getpeername()[0]) != self.address:
                    raise Refused()
            stream.settimeout(remaining(self.deadline))
            self.sock = stream
        except BaseException:
            stream.close()
            raise


def _content(response: http.client.HTTPResponse, connection: _Pinned, deadline: float) -> str:
    headers = response.headers
    lengths = headers.get_all("Content-Length", [])
    if len(lengths) > 1 or (lengths and (not lengths[0].isascii() or not lengths[0].isdigit())):
        raise Refused()
    length = int(lengths[0]) if lengths else None
    if length is not None and length > MAX_BYTES:
        raise Refused()
    transfers = headers.get_all("Transfer-Encoding", [])
    if len(transfers) > 1 or (transfers and transfers[0].lower().strip() != "chunked"):
        raise Refused()
    if transfers and lengths:
        raise Refused()
    encodings = headers.get_all("Content-Encoding", [])
    encoding = encodings[0].strip().lower() if encodings else "identity"
    if len(encodings) > 1 or encoding not in {"identity", "gzip", "deflate"}:
        raise Refused()
    if headers.get_content_type() not in {"text/html", "application/xhtml+xml"}:
        raise Refused()
    charset = headers.get_content_charset() or "utf-8"
    if charset not in {
        "utf-8",
        "utf8",
        "ascii",
        "us-ascii",
        "iso-8859-1",
        "latin1",
        "windows-1252",
        "cp1252",
    }:
        raise Refused()
    decoder = (
        None if encoding == "identity" else zlib.decompressobj(31 if encoding == "gzip" else 15)
    )
    output, received = bytearray(), 0
    while True:
        timeout = remaining(deadline)
        if connection.sock is not None:
            connection.sock.settimeout(timeout)
        chunk = response.read(min(16384, MAX_BYTES - received + 1))
        remaining(deadline)
        if not chunk:
            break
        received += len(chunk)
        if received > MAX_BYTES:
            raise Refused()
        output.extend(
            chunk if decoder is None else decoder.decompress(chunk, MAX_BYTES - len(output) + 1)
        )
        if len(output) > MAX_BYTES or (
            decoder is not None and (decoder.unconsumed_tail or decoder.unused_data)
        ):
            raise Refused()
    if (length is not None and received != length) or (decoder is not None and not decoder.eof):
        raise Refused()
    text = output.decode(charset, errors="replace")
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise Refused()
    return text


def fetch_metadata(url: str, *, deadline: float | None = None) -> dict[str, str] | None:
    limit = min(deadline, clock() + 5) if deadline is not None else clock() + 5
    value = target(url)
    if value is None:
        return None
    connection = None
    try:
        address = _address(value, limit)
        connection = _Pinned(value, address, limit)
        connection.request(
            "GET",
            value.path,
            headers={
                "Host": value.authority,
                "Accept": "text/html, application/xhtml+xml",
                "Accept-Encoding": "identity",
                "User-Agent": "OpenSlate-LinkPreview/1",
                "Connection": "close",
            },
        )
        remaining(limit)
        with connection.getresponse() as response:
            if response.status != 200:
                return None
            html = _content(response, connection, limit)
        result = extract(value.url, html)
        remaining(limit)
        return result
    except (OSError, ValueError, http.client.HTTPException, zlib.error, UnicodeError):
        return None
    finally:
        if connection is not None:
            connection.close()
