"""Bounded PostgreSQL readiness checks with a single shared in-flight probe."""

from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from functools import lru_cache
from threading import Lock

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.core.observability import log_event

_probe_lock = Lock()
_probe_executor: ThreadPoolExecutor | None = None
_probe_future: Future[bool] | None = None


@lru_cache
def get_readiness_engine() -> Engine:
    settings = get_settings()
    return create_engine(
        settings.database_url,
        pool_size=1,
        max_overflow=0,
        pool_timeout=settings.readiness_pool_timeout_seconds,
        pool_pre_ping=True,
        connect_args={
            "connect_timeout": settings.readiness_connect_timeout_seconds,
            "options": (
                f"-c statement_timeout={settings.readiness_statement_timeout_ms} "
                "-c default_transaction_read_only=on"
            ),
        },
    )


def is_database_ready() -> bool:
    """Wait briefly for the lone probe, without creating replacement probes on timeout."""

    future = _get_or_start_probe()
    try:
        return future.result(timeout=get_settings().readiness_caller_timeout_seconds)
    except TimeoutError:
        log_event("database_unavailable", reason_code="readiness_probe_timeout")
        return False


def _get_or_start_probe() -> Future[bool]:
    global _probe_executor, _probe_future
    with _probe_lock:
        if _probe_executor is None:
            _probe_executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="readiness-probe",
            )
        if _probe_future is None or _probe_future.done():
            _probe_future = _probe_executor.submit(_probe_database)
        return _probe_future


def _probe_database() -> bool:
    try:
        with get_readiness_engine().connect() as connection:
            with connection.begin():
                connection.execute(text("SET TRANSACTION READ ONLY"))
                connection.execute(text("SELECT 1"))
        return True
    except SQLAlchemyError:
        log_event("database_unavailable", reason_code="readiness_probe_failed")
        return False


def dispose_readiness_resources() -> None:
    """Release the probe pool during application shutdown."""

    global _probe_executor, _probe_future
    if get_readiness_engine.cache_info().currsize:
        get_readiness_engine().dispose()
    get_readiness_engine.cache_clear()
    with _probe_lock:
        if _probe_executor is not None:
            _probe_executor.shutdown(wait=False, cancel_futures=True)
        _probe_executor = None
        _probe_future = None
