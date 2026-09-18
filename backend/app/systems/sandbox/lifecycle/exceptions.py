from collections.abc import Sequence
from http import HTTPStatus

from app.systems.sandbox.lifecycle.schemas import LifecycleBlocker, LifecycleBlockerCode


class LifecycleError(Exception):
    status_code = HTTPStatus.CONFLICT
    code = "lifecycle_error"

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class LifecycleNotFound(LifecycleError):
    status_code = HTTPStatus.NOT_FOUND
    code = "not_found"


class LifecycleInvalidTarget(LifecycleError):
    status_code = HTTPStatus.UNPROCESSABLE_ENTITY
    code = "invalid_target"


class LifecycleUnsupportedOperation(LifecycleError):
    status_code = HTTPStatus.UNPROCESSABLE_ENTITY
    code = "unsupported_operation"


class LifecycleRecordCloseError(LifecycleError):
    code = LifecycleBlockerCode.RECORD_CLOSE_UNSUPPORTED


class LifecycleClosedAncestorError(LifecycleError):
    code = LifecycleBlockerCode.CLOSED_ANCESTOR


class LifecyclePlanDriftError(LifecycleError):
    code = "impact_changed"


class LifecycleConfirmationNameMismatch(LifecycleError):
    status_code = HTTPStatus.UNPROCESSABLE_ENTITY
    code = "confirmation_name_mismatch"


class LifecycleAlreadyClosed(LifecycleError):
    code = "already_closed"


class LifecycleAlreadyOpen(LifecycleError):
    code = "already_open"


class LifecyclePurgePreconditionError(LifecycleError):
    code = "purge_requires_closed"


class LifecyclePurgeDisabled(LifecycleError):
    status_code = HTTPStatus.FORBIDDEN
    code = "purge_disabled"


class LifecycleUnavailable(LifecycleError):
    status_code = HTTPStatus.SERVICE_UNAVAILABLE
    code = "temporarily_unavailable"


class LifecyclePreflightError(LifecycleError):
    code = "preflight_failed"

    def __init__(self, blockers: Sequence[LifecycleBlocker]) -> None:
        self.blockers = tuple(blockers)
        detail = "; ".join(blocker.detail for blocker in self.blockers)
        super().__init__(detail or "Lifecycle preflight failed")


class LifecycleChallengeNotFound(LifecycleError):
    status_code = HTTPStatus.NOT_FOUND
    code = "challenge_not_found"


class LifecycleChallengeBindingMismatch(LifecycleError):
    status_code = HTTPStatus.FORBIDDEN
    code = "challenge_binding_mismatch"


class LifecycleChallengeExpired(LifecycleError):
    code = "challenge_expired"


class LifecycleChallengeExhausted(LifecycleError):
    code = "challenge_exhausted"


class LifecycleVerificationInProgress(LifecycleError):
    code = "verification_in_progress"


class LifecycleActorBlocked(LifecycleError):
    status_code = HTTPStatus.TOO_MANY_REQUESTS
    code = "actor_blocked"


class LifecycleActorMismatch(LifecycleError):
    # Reserve 401 for the bearer session itself; the BFF retries 401 requests
    # with the same body after refreshing that session.
    status_code = HTTPStatus.FORBIDDEN
    code = "actor_mismatch"


class LifecyclePasswordError(LifecycleError):
    status_code = HTTPStatus.FORBIDDEN
    code = "password_verification_failed"


class LifecycleInvalidCredentials(LifecyclePasswordError):
    code = "invalid_credentials"


class LifecyclePasswordRateLimited(LifecyclePasswordError):
    status_code = HTTPStatus.TOO_MANY_REQUESTS
    code = "password_upstream_rate_limited"


class LifecyclePasswordServiceUnavailable(LifecyclePasswordError):
    status_code = HTTPStatus.SERVICE_UNAVAILABLE
    code = "password_upstream_unavailable"


__all__ = [
    "LifecycleClosedAncestorError",
    "LifecycleActorBlocked",
    "LifecycleActorMismatch",
    "LifecycleChallengeBindingMismatch",
    "LifecycleChallengeExhausted",
    "LifecycleChallengeExpired",
    "LifecycleChallengeNotFound",
    "LifecycleAlreadyClosed",
    "LifecycleAlreadyOpen",
    "LifecyclePurgePreconditionError",
    "LifecyclePurgeDisabled",
    "LifecycleConfirmationNameMismatch",
    "LifecycleError",
    "LifecycleInvalidCredentials",
    "LifecycleInvalidTarget",
    "LifecycleNotFound",
    "LifecyclePlanDriftError",
    "LifecyclePreflightError",
    "LifecyclePasswordError",
    "LifecyclePasswordRateLimited",
    "LifecyclePasswordServiceUnavailable",
    "LifecycleRecordCloseError",
    "LifecycleUnavailable",
    "LifecycleUnsupportedOperation",
    "LifecycleVerificationInProgress",
]
