"""Local password verification used only for lifecycle step-up checks."""

from typing import Protocol
from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.access.identity.service import (
    IdentityRateLimited,
    InvalidCredentials,
    authenticate_password,
)
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
)


class PasswordGrantClient(Protocol):
    def verify_password(self, email: str, password: str) -> UUID:
        """Verify credentials and return the local identity."""


class LocalPasswordGrantClient:
    """Verify a password locally without issuing a temporary browser session."""

    def __init__(self, db: Session) -> None:
        self._db = db

    def verify_password(self, email: str, password: str) -> UUID:
        try:
            return authenticate_password(self._db, email, password).id
        except InvalidCredentials as error:
            raise LifecycleInvalidCredentials("The supplied password is invalid") from error
        except IdentityRateLimited as error:
            raise LifecyclePasswordRateLimited("Password verification is rate limited") from error


__all__ = ["LocalPasswordGrantClient", "PasswordGrantClient"]
