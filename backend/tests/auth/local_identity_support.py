"""Small request and settings helpers for local Identity tests."""

from starlette.requests import Request


def request(origin: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/login",
            "headers": [(b"origin", origin.encode())],
            "client": ("127.0.0.1", 50000),
            "scheme": "https",
            "server": ("localhost", 443),
        }
    )
