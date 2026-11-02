"""Readiness reduced to plain part statuses, probed at most once in 30 seconds per process."""

from datetime import datetime
from threading import Lock
from time import monotonic

from app.core.base_model import utc_now
from app.core.readiness import ReadinessSnapshot, get_readiness_snapshot
from app.systems.manage.health.schemas import PartKey, PartStatus, SystemPart

CACHE_SECONDS = 30.0

# Readiness component behind each part, in the order the page shows them.
_PARTS: tuple[tuple[PartKey, str], ...] = (
    ("data", "database"),
    ("signing_in", "auth"),
    ("files", "storage"),
    ("email", "smtp"),
)
_STATUS: dict[str, PartStatus] = {
    "ready": "working",
    "unavailable": "not_working",
    "not_configured": "not_set_up",
}

_cache_lock = Lock()
# (snapshot, UTC check time, monotonic time the snapshot was received)
_cached: tuple[ReadinessSnapshot, datetime, float] | None = None


def cached_readiness() -> tuple[ReadinessSnapshot, datetime]:
    """The last snapshot and its check time, or a new probe once the last one is 30 s old.

    There is no bypass. The lock is not held during the probe: concurrent misses share the
    one in-flight readiness probe, and the first stored result keeps its check time.
    """

    global _cached
    with _cache_lock:
        cached = _cached
        if cached is not None and monotonic() - cached[2] < CACHE_SECONDS:
            return cached[0], cached[1]
    requested_at = monotonic()
    snapshot = get_readiness_snapshot()
    with _cache_lock:
        if _cached is None or _cached[2] < requested_at:
            _cached = (snapshot, utc_now(), monotonic())
        return _cached[0], _cached[1]


def system_parts(snapshot: ReadinessSnapshot) -> list[SystemPart]:
    components = snapshot["components"]
    parts = []
    for key, name in _PARTS:
        component = components.get(name)
        readiness = component["status"] if component is not None else "unavailable"
        status = _STATUS[readiness]
        # Configuration presence does not prove that mail is delivered.
        if key == "email" and status == "working":
            status = "set_up"
        parts.append(SystemPart(key=key, status=status))
    return parts
