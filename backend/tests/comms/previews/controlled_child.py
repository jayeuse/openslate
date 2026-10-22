"""Offline owned public-site fixture; runs the production resolver/pinning/parser/child path."""

import io
import socket
import ssl


def main():
    from app.systems.comms.previews import child, fetch

    def forbidden(*_args, **_kwargs):
        raise AssertionError("The controlled preview child cannot use a real network")

    def resolve(host, port, **kwargs):
        assert host.rstrip(".") == "preview.example.com"
        assert kwargs["family"] == socket.AF_UNSPEC
        return [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", port))
        ]

    class Socket:
        def __init__(self, *_args):
            self.destination = None
            self.sent = bytearray()

        def settimeout(self, _timeout):
            pass

        def connect(self, destination):
            assert destination == ("93.184.216.34", 443)
            self.destination = destination

        def getpeername(self):
            return self.destination

        def sendall(self, content):
            self.sent.extend(content)

        def makefile(self, *_args, **_kwargs):
            assert b"Host: preview.example.com\r\n" in self.sent
            assert b"Authorization:" not in self.sent and b"Cookie:" not in self.sent
            body = (
                b"<title>Owned preview fixture</title>"
                b"<meta name='description' content='Controlled parsed metadata'>"
                b"<meta property='og:site_name' content='OpenSlate test'>"
                b"<script>never-visible-script</script><img src='http://127.0.0.1/'>"
            )
            return io.BytesIO(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                + body
            )

        def close(self):
            pass

    def wrap(context, stream, *, server_hostname, **_kwargs):
        assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
        assert server_hostname == "preview.example.com"
        return stream

    fetch.resolve, fetch.open_socket = resolve, Socket
    socket.getaddrinfo = socket.create_connection = socket.socket = forbidden
    ssl.SSLContext.wrap_socket = wrap
    return child.main()


if __name__ == "__main__":
    raise SystemExit(main())
