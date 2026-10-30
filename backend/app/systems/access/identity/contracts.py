"""Identity domain errors and values shared by route and service code."""

from dataclasses import dataclass
from uuid import UUID


class IdentityError(RuntimeError):
    """A safe local identity failure."""


class InvalidCredentials(IdentityError):
    def __init__(self, message: str = "Invalid credentials", *, reason: str | None = None) -> None:
        super().__init__(message)
        # A fixed refusal kind for operational logs; never account or token data.
        self.reason = reason


class RefreshReplayDetected(InvalidCredentials):
    """A superseded refresh credential was reused and revoked its session."""


class IdentityRateLimited(IdentityError):
    def __init__(self, message: str, *, retry_after: int = 900) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ActionTokenInvalid(IdentityError):
    pass


@dataclass(frozen=True, slots=True)
class IssuedSession:
    access_token: str
    refresh_token: str | None
    csrf_token: str
    session_id: UUID
    setup_only: bool
