from typing import Any

import pytest
from pydantic import ValidationError

from app.systems.access.identity.schemas import (
    ActionTokenCompleteRequest,
    LoginRequest,
    RecoveryRequest,
)
from app.systems.access.users.schemas import InvitationCreate, UserCreate
from app.systems.manage.workspace.schemas import WorkspaceUpdate


def test_invitation_normalizes_email_and_username() -> None:
    invitation = InvitationCreate(
        email=" ADMIN@Example.COM ",
        username=" Test_User ",
    )

    assert invitation.email == "admin@example.com"
    assert invitation.username == "test_user"


def test_supabase_auth_inputs_are_email_only_and_accept_provider_hash() -> None:
    assert LoginRequest(email=" PERSON@Example.Test ", password="long secret").email == (
        "person@example.test"
    )
    assert RecoveryRequest(email=" PERSON@Example.Test ").email == "person@example.test"
    assert ActionTokenCompleteRequest(token_hash="a" * 56, password="long enough secret")
    for model, values in (
        (LoginRequest, {"identifier": "person@example.test", "password": "long secret"}),
        (RecoveryRequest, {"identifier": "person@example.test"}),
        (ActionTokenCompleteRequest, {"token": "a" * 56, "password": "long enough secret"}),
    ):
        with pytest.raises(ValidationError):
            model.model_validate(values)


def test_invitation_rejects_removed_temporary_password_delivery() -> None:
    with pytest.raises(ValidationError):
        InvitationCreate.model_validate(
            {
                "email": "person@example.test",
                "username": "person",
                "delivery": "temporary_password",
                "temporary_password": "some passphrase",
            }
        )


@pytest.mark.parametrize("missing_field", ["email", "username"])
def test_invitation_requires_email_and_username(missing_field: str) -> None:
    values: dict[str, Any] = {
        "email": "admin@example.com",
        "username": "admin",
    }
    values.pop(missing_field)

    with pytest.raises(ValidationError):
        InvitationCreate(**values)


def test_invitation_rejects_invalid_email() -> None:
    with pytest.raises(ValidationError):
        InvitationCreate(email="not-an-email", username="admin")


@pytest.mark.parametrize(
    "email",
    [
        "admin@@example.com",
        "admin @example.com",
        "admin@example .com",
        "admin@exa\tmple.com",
        "admin@\nexample.com",
    ],
)
def test_email_boundaries_reject_multiple_at_and_embedded_whitespace(email: str) -> None:
    with pytest.raises(ValidationError):
        InvitationCreate(email=email, username="admin")
    with pytest.raises(ValidationError):
        UserCreate(email=email, username="admin")
    with pytest.raises(ValidationError):
        WorkspaceUpdate(revision=1, contact_email=email)
