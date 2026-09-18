from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.common.dependencies.auth as auth_dependencies
import app.systems.access.users.account_operations as users_router
import app.systems.access.users.reconciliation as reconciliation
from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.users.models import Role, User, UserRole, UserStatus

MOCK_ACCESS_TOKEN = token_urlsafe(32)


def _role(name: str = UserRole.MEMBER.value) -> Role:
    now = datetime.now(UTC)
    return Role(
        id=uuid7(),
        role=name,
        permissions={},
        created_at=now,
        updated_at=now,
        is_deleted=False,
    )


def _user(
    role: Role,
    *,
    status: UserStatus = UserStatus.ACTIVE,
    sent: datetime | None = None,
    accepted: datetime | None = None,
    deleted: bool = False,
) -> User:
    now = datetime.now(UTC)
    return User(
        id=uuid7(),
        email=f"api-{uuid7().hex}@example.com",
        username=f"api_{uuid7().hex[:12]}",
        status=status.value,
        invitation_sent_at=sent,
        invitation_accepted_at=accepted,
        role_id=role.id,
        role=role,
        created_at=now,
        updated_at=now,
        deleted_at=now if deleted else None,
        is_deleted=deleted,
    )


@pytest.fixture
def api() -> Generator[FastAPI, None, None]:
    application = create_app()
    yield application
    application.dependency_overrides.clear()


def _admin_client(application: FastAPI, admin: User, database: Mock) -> TestClient:
    application.dependency_overrides[get_current_user] = lambda: admin
    application.dependency_overrides[get_db] = lambda: database
    return TestClient(application)


def _admin_database(admin: User, target: User) -> Mock:
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, target]
    return database


def _auth_client(
    application: FastAPI,
    user: User,
    database: Mock,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    monkeypatch.setattr(
        auth_dependencies,
        "verify_supabase_jwt",
        lambda _token: {
            "sub": str(user.id),
            "email": user.email,
            "iss": "https://test.local/auth/v1",
            "aud": "authenticated",
            "exp": (datetime.now(UTC) + timedelta(minutes=5)).timestamp(),
            "iat": datetime.now(UTC).timestamp(),
        },
    )
    database.scalar.return_value = user
    application.dependency_overrides[get_db] = lambda: database
    return TestClient(application)


def test_pending_patch_cannot_disable_or_activate(api: FastAPI) -> None:
    admin = _user(_role(UserRole.ADMIN.value))
    target = _user(_role(), status=UserStatus.PENDING)
    for requested_status in (UserStatus.DISABLED.value, UserStatus.ACTIVE.value):
        database = _admin_database(admin, target)
        with _admin_client(api, admin, database) as client:
            response = client.patch(
                f"/api/users/{target.id}",
                json={"status": requested_status},
            )
        assert response.status_code == 409
        assert target.status == UserStatus.PENDING.value


@pytest.mark.parametrize("status", [UserStatus.ACTIVE, UserStatus.DISABLED])
def test_unaccepted_profile_cannot_be_activated(api: FastAPI, status: UserStatus) -> None:
    admin = _user(_role(UserRole.ADMIN.value))
    target = _user(
        _role(),
        status=status,
        sent=datetime.now(UTC) - timedelta(minutes=5),
    )
    database = _admin_database(admin, target)
    with _admin_client(api, admin, database) as client:
        response = client.patch(f"/api/users/{target.id}", json={"status": "active"})
    assert response.status_code == 409
    assert target.status == status.value


def test_deleted_pending_restore_is_blocked_without_auth_enable(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _user(_role(UserRole.ADMIN.value))
    target = _user(
        _role(),
        status=UserStatus.PENDING,
        sent=datetime.now(UTC) - timedelta(minutes=5),
        deleted=True,
    )
    database = _admin_database(admin, target)
    enable = Mock()
    monkeypatch.setattr(users_router, "_enable_auth_user", enable)
    with _admin_client(api, admin, database) as client:
        response = client.post(f"/api/users/{target.id}/restore")
    assert response.status_code == 409
    assert target.is_deleted is True
    assert target.status == UserStatus.PENDING.value
    enable.assert_not_called()


def test_established_profiles_can_authenticate_and_member_cannot_admin_list(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = _role()
    for index, (sent, accepted) in enumerate(
        [(None, None), (datetime.now(UTC), datetime.now(UTC))]
    ):
        user = _user(role, sent=sent, accepted=accepted)
        database = Mock(spec=Session)
        with _auth_client(api, user, database, monkeypatch) as client:
            me = client.get(
                "/api/auth/me", headers={"Authorization": f"Bearer {MOCK_ACCESS_TOKEN}"}
            )
            assert me.status_code == 200, index
            assert me.json()["id"] == str(user.id)
            admin_list = client.get(
                "/api/users",
                headers={"Authorization": f"Bearer {MOCK_ACCESS_TOKEN}"},
            )
            assert admin_list.status_code == 403, index


def test_pending_and_corrupted_active_profiles_fail_real_auth_dependency(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for status, sent in [
        (UserStatus.PENDING, None),
        (UserStatus.ACTIVE, datetime.now(UTC)),
    ]:
        user = _user(_role(), status=status, sent=sent)
        database = Mock(spec=Session)
        with _auth_client(api, user, database, monkeypatch) as client:
            response = client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {MOCK_ACCESS_TOKEN}"},
            )
        assert response.status_code == 401


def test_corrupted_active_admin_is_not_enabled_by_reconciliation(
    api: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = _user(_role(UserRole.ADMIN.value))
    target = _user(
        admin.role,
        sent=datetime.now(UTC) - timedelta(minutes=5),
    )
    database = _admin_database(admin, target)
    database.scalar.side_effect = [admin.role, admin, target, admin.role, admin, target]
    client = Mock()
    events = Mock()
    monkeypatch.setattr(reconciliation, "SupabaseAdminClient", lambda: client)
    monkeypatch.setattr(users_router, "_record_security_event", events)
    with _admin_client(api, admin, database) as http:
        response = http.post(f"/api/users/{target.id}/reconcile-auth")
    assert response.status_code == 200
    client.disable_user.assert_called_once_with(target.id)
    client.enable_user.assert_not_called()
    assert target.status == UserStatus.ACTIVE.value
    assert target.invitation_accepted_at is None


def test_user_patch_rejects_missing_or_pending_status_payload(api: FastAPI) -> None:
    admin = _user(_role(UserRole.ADMIN.value))
    target = _user(_role(), status=UserStatus.DISABLED)
    database = Mock(spec=Session)
    application = _admin_client(api, admin, database)
    with application as client:
        missing = client.patch(f"/api/users/{target.id}", json={})
        invalid = client.patch(f"/api/users/{target.id}", json={"status": "pending"})
    assert missing.status_code == 422
    assert invalid.status_code == 422
