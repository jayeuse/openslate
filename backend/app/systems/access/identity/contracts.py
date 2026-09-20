"""Identity domain errors and values shared by route and service code."""

from dataclasses import dataclass
from uuid import UUID


class IdentityError(RuntimeError):
    """A safe local identity failure."""


class InvalidCredentials(IdentityError):
    pass


class RefreshReplayDetected(InvalidCredentials):
    """A superseded refresh credential was reused and revoked its session."""


class IdentityRateLimited(IdentityError):
    pass


class ActionTokenInvalid(IdentityError):
    pass


@dataclass(frozen=True, slots=True)
class IssuedSession:
    access_token: str
    refresh_token: str | None
    csrf_token: str
    session_id: UUID
    setup_only: bool
