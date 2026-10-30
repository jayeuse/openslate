"""Short reuse of positive provider-account checks for ordinary authorization.

A cached provider account may only admit a request. Any denial computed from a
cached account is recomputed from a fresh provider read by the caller, so a new
MFA factor or a lifted ban never waits for the cache to expire. A change made
directly in the provider (ban, deletion, factor removal) can take up to
``PROVIDER_USER_TTL_SECONDS`` to deny an otherwise valid request; local checks
(session revocation, account status, provider session existence) stay per request.

Every API worker process has its own cache, so ``forget_provider_user`` reaches only
the process that verified a factor. ``reusable_provider_user`` covers the others: the
verification commits the person's MFA observation, and a cached account without the
factor that the observation records is not reused.
"""

from __future__ import annotations

from threading import Lock
from time import monotonic
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.identity.models import IdentityMfaObservation

PROVIDER_USER_TTL_SECONDS = 10.0
_MAX_ENTRIES = 4096

_entries: dict[UUID, tuple[float, ProviderUser]] = {}
_lock = Lock()


def recent_provider_user(user_id: UUID) -> ProviderUser | None:
    with _lock:
        entry = _entries.get(user_id)
        if entry is None:
            return None
        if monotonic() - entry[0] >= PROVIDER_USER_TTL_SECONDS:
            del _entries[user_id]
            return None
        return entry[1]


def reusable_provider_user(db: Session, user_id: UUID, provider_id: UUID) -> ProviderUser | None:
    """The recent account of ``provider_id``, unless it lacks a factor verified since.

    ``user_id`` is the local account bound to ``provider_id``. The observation read
    runs only for a cached account with no verified TOTP factor.
    """
    cached = recent_provider_user(provider_id)
    if cached is None or any(
        factor.factor_type == "totp" and factor.status == "verified" for factor in cached.factors
    ):
        return cached
    observation = db.get(IdentityMfaObservation, user_id, populate_existing=True)
    if (
        observation is not None
        and observation.observed_provider_user_id == provider_id
        and observation.verified_totp
    ):
        forget_provider_user(provider_id)
        return None
    return cached


def remember_provider_user(provider_user: ProviderUser) -> None:
    with _lock:
        if len(_entries) >= _MAX_ENTRIES and provider_user.id not in _entries:
            _entries.pop(next(iter(_entries)))
        _entries[provider_user.id] = (monotonic(), provider_user)


def forget_provider_user(user_id: UUID) -> None:
    with _lock:
        _entries.pop(user_id, None)


def clear_provider_users() -> None:
    with _lock:
        _entries.clear()
