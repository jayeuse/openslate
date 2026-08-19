import pytest
from pydantic import ValidationError

from app.systems.auth.schemas import RegistrationRequest


def test_registration_normalizes_username() -> None:
    request = RegistrationRequest(username="Test_User", password="long-enough-password")

    assert request.username == "test_user"


def test_registration_rejects_short_password() -> None:
    with pytest.raises(ValidationError):
        RegistrationRequest(username="test-user", password="short")


def test_registration_accepts_100_character_username() -> None:
    request = RegistrationRequest(username="a" * 100, password="long-enough-password")

    assert len(request.username) == 100
