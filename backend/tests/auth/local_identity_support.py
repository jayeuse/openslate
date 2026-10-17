"""Small request, role and user builders for local Identity tests."""

from datetime import UTC, datetime

from starlette.requests import Request
from uuid6 import uuid7

from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member


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


def contract_request(
    *,
    method: str = "POST",
    origin: str | None = "https://app.example.test",
    cookies: str | None = None,
    authorization: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if cookies is not None:
        headers.append((b"cookie", cookies.encode()))
    if authorization is not None:
        headers.append((b"authorization", authorization.encode()))
    return Request(
        {
            "type": "http",
            "method": method,
            "path": "/api/auth/test",
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "scheme": "https",
            "server": ("app.example.test", 443),
        }
    )


def contract_role(kind: UserRole = UserRole.MEMBER) -> str:
    return kind.value


def contract_user(
    *, status: UserStatus = UserStatus.ACTIVE, role: str | None = None
) -> tuple[User, Membership]:
    selected_role = role or contract_role()
    now = datetime.now(UTC)
    return create_member(None, WorkspaceProfile(id=uuid7()),
        id=uuid7(),
        email="person@example.test",
        username="person",
        status=status.value,
        role=selected_role,
        created_at=now,
        updated_at=now,
        is_deleted=False,
    )
