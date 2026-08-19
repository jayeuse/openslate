import pytest
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.auth.schemas import LoginRequest, RefreshRequest, RegistrationRequest
from app.systems.users.schemas import RoleCreate, UserCreate, UserUpdate


def test_registration_normalizes_username() -> None:
    request = RegistrationRequest(username="Test_User", password="long-enough-password")

    assert request.username == "test_user"


def test_registration_rejects_short_password() -> None:
    with pytest.raises(ValidationError):
        RegistrationRequest(username="test-user", password="short")


def test_registration_accepts_100_character_username() -> None:
    request = RegistrationRequest(username="a" * 100, password="long-enough-password")

    assert len(request.username) == 100


def test_login_normalizes_username() -> None:
    request = LoginRequest(username="Test_User", password="long-enough-password")

    assert request.username == "test_user"


def test_refresh_request_requires_a_token() -> None:
    request = RefreshRequest(refresh_token="refresh-token")

    assert request.refresh_token == "refresh-token"


def test_user_payloads_validate_password_and_role() -> None:
    role_id = uuid7()
    create = UserCreate(
        username="New_User",
        password="long-enough-password",
        role_id=role_id,
    )
    update = UserUpdate(password="another-long-password", role_id=role_id)

    assert create.username == "new_user"
    assert update.role_id == role_id


def test_role_payload_rejects_empty_role() -> None:
    with pytest.raises(ValidationError):
        RoleCreate(role="")
