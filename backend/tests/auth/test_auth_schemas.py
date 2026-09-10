import importlib
from typing import Any, cast

import pytest
from pydantic import BaseModel, ValidationError


def _invitation_schema() -> type[BaseModel]:
    schemas = importlib.import_module("app.systems.auth.schemas")
    schema = getattr(schemas, "InvitationCreate", None)
    assert isinstance(schema, type), "InvitationCreate is not implemented"
    return cast(type[BaseModel], schema)


def test_invitation_normalizes_email_and_username() -> None:
    invitation = _invitation_schema()(
        email=" ADMIN@Example.COM ",
        username=" Test_User ",
    )

    assert invitation.email == "admin@example.com"
    assert invitation.username == "test_user"


@pytest.mark.parametrize("missing_field", ["email", "username"])
def test_invitation_requires_email_and_username(missing_field: str) -> None:
    values: dict[str, Any] = {
        "email": "admin@example.com",
        "username": "admin",
    }
    values.pop(missing_field)

    with pytest.raises(ValidationError):
        _invitation_schema()(**values)


def test_invitation_rejects_invalid_email() -> None:
    with pytest.raises(ValidationError):
        _invitation_schema()(email="not-an-email", username="admin")
