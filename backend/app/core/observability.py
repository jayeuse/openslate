"""Safe, structured operational logging shared by backend infrastructure."""

import json
import logging
from datetime import UTC, datetime
from typing import Final
from uuid import UUID

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
    }
)


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
    elif event != "http_request":
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
    logging.getLogger(LOGGER_NAME).log(level, json.dumps(record, separators=(",", ":")))


def _set_string(record: dict[str, object], name: str, value: UUID | str | None) -> None:
    if value is not None:
        record[name] = str(value)


def _set_int(record: dict[str, object], name: str, value: int | None) -> None:
    if value is not None:
        record[name] = value
