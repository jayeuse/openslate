import pytest
from pydantic import ValidationError

from app.systems.auth.schemas import RegistrationRequest


def test_registration_normalizes_username() -> None:
    request = RegistrationRequest(username="Test_User", password="long-enough-password")

    assert request.username == "test_user"


def test_registration_rejects_short_password() -> None:
    with pytest.raises(ValidationError):
        RegistrationRequest(username="test-user", password="short")
