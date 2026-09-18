from typing import Any

import pytest
from pydantic import ValidationError

from app.systems.access.users.schemas import InvitationCreate, UserCreate
from app.systems.manage.workspace.schemas import WorkspaceUpdate


def test_invitation_normalizes_email_and_username() -> None:
    invitation = InvitationCreate(
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
