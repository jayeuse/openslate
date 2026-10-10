"""Short reuse of positive provider-account checks for ordinary authorization.

A cached provider account may only admit a request. Any denial computed from a
cached account is recomputed from a fresh provider read by the caller, so a new
MFA factor or a lifted ban never waits for the cache to expire. A change made
directly in the provider (ban, deletion, factor removal) can take up to
``PROVIDER_USER_TTL_SECONDS`` to deny an otherwise valid request; local checks
(session revocation, account status, provider session existence) stay per request.
"""

from __future__ import annotations

from threading import Lock
from time import monotonic
from uuid import UUID

from app.core.integrations.supabase_auth import ProviderUser

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
