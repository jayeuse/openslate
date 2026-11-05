"""The stored server error log (S6-C1).

Each 5xx response keeps its request ID, status, method, route template, bound organization
and time; never a body, header, query, person or record. A process writes at most 120 rows
a minute, and after a failed write it pauses for 30 seconds, so a database outage or an
error storm cannot make error handling slower or louder. The samples record outages.
"""

import re
from contextlib import nullcontext
from threading import Lock
from time import monotonic
from uuid import UUID

from app.core.database.organization_scope import worker_organization
from app.core.database.session import AuditSession, get_engine
from app.core.observability import log_event
from app.systems.manage.health.models import ServerError

CAP_PER_MINUTE = 120
WINDOW_SECONDS = 60.0
PAUSE_SECONDS = 30.0
_METHOD = re.compile(r"[A-Z]{3,7}")


def _write(
    request_id: UUID, status: int, method: str, route: str, org_id: UUID | None
) -> None:
    # The insert policy admits a row only for the transaction's own organization.
    scope = worker_organization(org_id) if org_id is not None else nullcontext()
    with scope, AuditSession(bind=get_engine()) as db:
        db.add(
            ServerError(
                request_id=request_id, status=status, method=method, route=route, org_id=org_id
            )
        )
        db.commit()


class ServerErrorLog:
    """Per-process bounds around the writes."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._window_started: float | None = None
        self._written = 0
        self._dropped = 0
        self._paused_until = 0.0

    def _admit(self, now: float) -> tuple[bool, int]:
        """Whether this row may be written, and the overflow of a window that just ended."""

        with self._lock:
            ended = 0
            if self._window_started is None or now - self._window_started >= WINDOW_SECONDS:
                ended, self._dropped = self._dropped, 0
                self._window_started, self._written = now, 0
            if now < self._paused_until or self._written >= CAP_PER_MINUTE:
                self._dropped += 1
                return False, ended
            self._written += 1
            return True, ended

    def record(
        self, request_id: UUID, status: int, method: str, route: str, org_id: UUID | None
    ) -> None:
        if not 500 <= status <= 599 or not _METHOD.fullmatch(method):
            return
        admitted, overflow = self._admit(monotonic())
        if overflow:
            log_event(
                "operational_attention",
                reason_code="server_error_log_dropped",
                upstream="database",
                count=overflow,
            )
        if not admitted:
            return
        try:
            _write(request_id, status, method, route[:200], org_id)
        except Exception:
            with self._lock:
                self._paused_until = monotonic() + PAUSE_SECONDS
            log_event(
                "operational_attention", reason_code="server_error_log_failed", upstream="database"
            )


_log = ServerErrorLog()


def record_server_error(
    request_id: UUID, status: int, method: str, route: str, org_id: UUID | None
) -> None:
    """Store one server error; never raises into the response that caused it."""

    try:
        _log.record(request_id, status, method, route, org_id)
    except Exception:
        log_event(
            "operational_attention", reason_code="server_error_log_failed", upstream="database"
        )
