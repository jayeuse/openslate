"""Small request and settings helpers for local Identity tests."""

from pydantic import SecretStr
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


class Settings:
    auth_jwt_secret: SecretStr = SecretStr("a" * 64)
    auth_jwt_issuer = "openslate"
    auth_jwt_audience = "openslate-api"
    auth_access_token_minutes = 15
    auth_refresh_token_days = 7
    public_origin = "http://frontend.test"


def settings() -> Settings:
    return Settings()
