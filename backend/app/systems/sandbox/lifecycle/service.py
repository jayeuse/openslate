"""Public lifecycle service exports."""

from app.systems.sandbox.lifecycle.challenge_store import (
    IssuedLifecycleChallenge,
    LifecycleVerificationLease,
    hash_challenge_token,
    issue_challenge,
)
from app.systems.sandbox.lifecycle.challenge_verification import (
    begin_verification,
    challenge_impact_digest,
    consume_challenge,
    expire_challenge,
    invalidate_challenge,
    record_failure,
    record_success,
    verify_challenge,
)
from app.systems.sandbox.lifecycle.execution import (
    close_lifecycle,
    execute_lifecycle,
    purge_lifecycle,
    reopen_lifecycle,
)

issue_confirmation_challenge = issue_challenge
verify_lifecycle_password = verify_challenge

__all__ = [
    "IssuedLifecycleChallenge",
    "LifecycleVerificationLease",
    "begin_verification",
    "challenge_impact_digest",
    "close_lifecycle",
    "consume_challenge",
    "execute_lifecycle",
    "expire_challenge",
    "hash_challenge_token",
    "invalidate_challenge",
    "issue_challenge",
    "issue_confirmation_challenge",
    "purge_lifecycle",
    "record_failure",
    "record_success",
    "reopen_lifecycle",
    "verify_challenge",
    "verify_lifecycle_password",
]
