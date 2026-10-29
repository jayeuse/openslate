"""Safe, structured operational logging shared by backend infrastructure."""

import json
import logging
import re
from datetime import UTC, datetime
from typing import Final
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.exc import TimeoutError as SQLAlchemyTimeoutError

from app.core.config import get_settings
from app.core.log_sink import DailyLogHandler
from app.core.middleware.request_context import get_current_request_context

LOGGER_NAME: Final = "openslate.observability"
ALLOWED_EVENTS: Final = frozenset(
    {
        "http_request",
        "http_failure",
        "database_unavailable",
        "upstream_failure",
        "realtime_invalidation_failure",
        "security_event_ingestion_failed",
        "operational_check_failed",
        "operational_attention",
        "smtp_delivery_failure",
        "worker_metrics",
    }
)
_DATABASE_REASONS: Final = {
    "40P01": "database_deadlock",
    "40001": "database_serialization_failure",
    "55P03": "database_lock_unavailable",
    "57014": "database_statement_timeout",
}
_SQLSTATE = re.compile(r"[0-9A-Z]{5}")
_CLASS_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
_CAUSE_LIST = re.compile(r"[a-z_]+:[A-Za-z0-9_]+(,[a-z_]+:[A-Za-z0-9_]+)*")


def configure_observability_logging() -> None:
    """Configure daily JSONL files and readable terminal request summaries."""

    # Request targets can contain untrusted query values; the application emits
    # a route template instead.
    logging.getLogger("uvicorn.access").disabled = True
    logger = logging.getLogger(LOGGER_NAME)
    if any(getattr(handler, "_openslate_observability", False) for handler in logger.handlers):
        return
    handler = DailyLogHandler(get_settings().log_dir)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def log_event(
    event: str,
    *,
    level: int = logging.INFO,
    request_id: UUID | str | None = None,
    method: str | None = None,
    route: str | None = None,
    status: int | None = None,
    duration_ms: int | None = None,
    reason_code: str | None = None,
    operation_id: UUID | str | None = None,
    actor_id: UUID | str | None = None,
    upstream: str | None = None,
    org_id: UUID | str | None = None,
    cause: str | None = None,
    count: int | None = None,
    age_ms: int | None = None,
) -> None:
    """Emit only allowlisted operational fields; never pass exception or request data."""

    if event not in ALLOWED_EVENTS:
        raise ValueError(f"Unsupported observability event: {event}")
    if status is not None:
        level = max(
            level,
            logging.ERROR
            if status >= 500
            else (logging.WARNING if status >= 400 else logging.INFO),
        )
    elif event not in {"http_request", "worker_metrics"}:
        level = max(level, logging.WARNING)
    context = get_current_request_context()
    resolved_request_id = request_id or (context.request_id if context is not None else None)
    record: dict[str, object] = {
        "timestamp": datetime.now(UTC).isoformat(),
        "severity": logging.getLevelName(level),
        "event": event,
        "service": "openslate-api",
    }
    _set_string(record, "request_id", resolved_request_id)
    _set_string(record, "method", method)
    _set_string(record, "route", route)
    _set_int(record, "status", status)
    _set_int(record, "duration_ms", duration_ms)
    _set_string(record, "reason_code", reason_code)
    _set_string(record, "operation_id", operation_id)
    _set_string(record, "actor_id", actor_id)
    _set_string(record, "upstream", upstream)
    _set_string(record, "org_id", org_id)
    _set_string(record, "cause", cause)
    _set_int(record, "count", count)
    _set_int(record, "age_ms", age_ms)
    logging.getLogger(LOGGER_NAME).log(level, json.dumps(record, separators=(",", ":")))


def _set_string(record: dict[str, object], name: str, value: UUID | str | None) -> None:
    if value is not None:
        record[name] = str(value)


def _set_int(record: dict[str, object], name: str, value: int | None) -> None:
    if value is not None:
        record[name] = value


def failure_cause(error: BaseException) -> str:
    """Name a caught failure with bounded codes only: never its message or arguments."""

    code = getattr(error, "cause_code", None)
    if isinstance(code, str) and _CAUSE_LIST.fullmatch(code):
        return code
    if isinstance(error, SQLAlchemyTimeoutError):
        return "database_pool_timeout"
    if isinstance(error, HTTPException):
        return f"http_{error.status_code}"
    sqlstate = getattr(error, "sqlstate", None) or getattr(
        getattr(error, "orig", None), "sqlstate", None
    )
    if sqlstate is not None:
        code = str(sqlstate)
        if code in _DATABASE_REASONS:
            return _DATABASE_REASONS[code]
        return f"database_{code}" if _SQLSTATE.fullmatch(code) else "database_operation_failed"
    if getattr(error, "orig", None) is not None:
        return "database_operation_failed"
    name = type(error).__name__
    return name if _CLASS_NAME.fullmatch(name) else "unexpected_error"
