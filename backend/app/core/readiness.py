"""Bounded read-only dependency readiness probes with shared in-flight work."""

from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from functools import lru_cache
from threading import Lock
from time import monotonic
from typing import Literal, TypedDict

import httpx
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import ConfigurationError, Settings, get_settings
from app.core.observability import log_event
from app.systems.platform.files.providers import ProviderUnavailable, get_scanner

_probe_lock = Lock()
_probe_executor: ThreadPoolExecutor | None = None
_snapshot_future: Future["ReadinessSnapshot"] | None = None
_snapshot_partial: tuple[Future["ReadinessSnapshot"], dict[str, "ComponentReadiness"]] | None = None

# Keep this in sync with app.systems.platform.files.worker.LEADER_LOCK. The
# readiness test compares the split words with that runtime-owned constant.
_SCANNER_WORKER_LEADER_LOCK = 57_168_423_129_478_012


class ComponentReadiness(TypedDict):
    status: Literal["ready", "unavailable", "not_configured"]
    required: bool


class ReadinessSnapshot(TypedDict):
    status: Literal["ready", "not_ready"]
    components: dict[str, ComponentReadiness]


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


def get_readiness_snapshot() -> ReadinessSnapshot:
    """Return a fixed, public-safe snapshot before the single caller deadline."""

    settings = get_settings()
    future, partial = _get_or_start_snapshot()
    try:
        return future.result(timeout=settings.readiness_caller_timeout_seconds)
    except TimeoutError:
        log_event(
            "upstream_failure",
            reason_code="readiness_probe_timeout",
            upstream="readiness",
        )
        with _probe_lock:
            completed = dict(partial)
        return _unavailable_snapshot(settings, completed)


def _get_or_start_snapshot() -> tuple[Future[ReadinessSnapshot], dict[str, ComponentReadiness]]:
    global _probe_executor, _snapshot_future, _snapshot_partial
    with _probe_lock:
        if _probe_executor is None:
            _probe_executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="readiness-probe",
            )
        if _snapshot_future is None or _snapshot_future.done():
            partial: dict[str, ComponentReadiness] = {}
            _snapshot_future = _probe_executor.submit(_probe_components, partial)
            _snapshot_partial = (_snapshot_future, partial)
        assert _snapshot_partial is not None
        return _snapshot_partial


def _component(available: bool, *, required: bool = True) -> ComponentReadiness:
    return {"status": "ready" if available else "unavailable", "required": required}


def _not_configured(*, required: bool) -> ComponentReadiness:
    return {"status": "not_configured", "required": required}


def _snapshot(components: dict[str, ComponentReadiness]) -> ReadinessSnapshot:
    return {
        "status": (
            "ready"
            if all(
                not component["required"] or component["status"] == "ready"
                for component in components.values()
            )
            else "not_ready"
        ),
        "components": components,
    }


def _unavailable_snapshot(
    settings: Settings, completed: dict[str, ComponentReadiness] | None = None
) -> ReadinessSnapshot:
    components = {
        "database": _component(False),
        "auth": _component(False),
        "storage": _component(False),
        "smtp": _smtp_component(settings),
        "scanner": _component(
            False,
            required=_scanner_required(settings.environment),
        ),
    }
    components.update(completed or {})
    return _snapshot(components)


def _record_component(
    components: dict[str, ComponentReadiness],
    partial: dict[str, ComponentReadiness] | None,
    name: str,
    value: ComponentReadiness,
) -> None:
    components[name] = value
    if partial is not None:
        with _probe_lock:
            partial[name] = value


def _probe_components(
    partial: dict[str, ComponentReadiness] | None = None,
) -> ReadinessSnapshot:
    settings = get_settings()
    deadline = monotonic() + settings.readiness_caller_timeout_seconds
    database_ready = _probe_database()

    provider_components: dict[str, ComponentReadiness] = {}
    _record_component(provider_components, partial, "database", _component(database_ready))
    provider_key = settings.supabase_publishable_key.get_secret_value()
    try:
        with httpx.Client(follow_redirects=False, trust_env=False) as client:
            _record_component(
                provider_components, partial, "auth",
                _probe_provider_health(
                    client, f"{settings.supabase_url.rstrip('/')}/auth/v1/health",
                    provider_key, deadline, settings.supabase_timeout_seconds,
                ),
            )
            _record_component(
                provider_components, partial, "storage",
                _probe_provider_health(
                    client, f"{settings.supabase_url.rstrip('/')}/storage/v1/status",
                    provider_key, deadline, settings.supabase_timeout_seconds,
                ),
            )
    except httpx.HTTPError:
        # Client construction/closure failures are reported as fixed states.
        if "auth" not in provider_components:
            _record_component(provider_components, partial, "auth", _component(False))
        if "storage" not in provider_components:
            _record_component(provider_components, partial, "storage", _component(False))
    _record_component(provider_components, partial, "smtp", _smtp_component(settings))
    _record_component(
        provider_components, partial, "scanner", _probe_scanner(settings, deadline, database_ready)
    )
    return _snapshot(provider_components)


def _scanner_required(environment: str) -> bool:
    return environment not in {"development", "test"}


def _smtp_component(settings: Settings) -> ComponentReadiness:
    configured = bool(settings.smtp_host and settings.smtp_port and settings.smtp_admin_email)
    if not configured:
        return _not_configured(required=True)
    return _component(True)


def _probe_scanner(
    settings: Settings,
    deadline: float,
    database_ready: bool,
) -> ComponentReadiness:
    required = _scanner_required(settings.environment)
    try:
        scanner = get_scanner(require_configuration=True)
    except ConfigurationError:
        return _not_configured(required=required)

    if not database_ready or monotonic() >= deadline:
        return _component(False, required=required)
    if not _probe_scanner_worker_leader() or monotonic() >= deadline:
        return _component(False, required=required)
    try:
        scanner.probe()
    except ProviderUnavailable:
        return _component(False, required=required)
    return _component(True, required=required)


def _probe_scanner_worker_leader() -> bool:
    lock_key = _SCANNER_WORKER_LEADER_LOCK
    try:
        with get_readiness_engine().connect() as connection:
            with connection.begin():
                connection.execute(text("SET TRANSACTION READ ONLY"))
                return bool(
                    connection.scalar(
                        text(
                            """
                            SELECT EXISTS (
                                SELECT 1
                                FROM pg_locks
                                WHERE locktype = 'advisory'
                                  AND database = (
                                      SELECT oid
                                      FROM pg_database
                                      WHERE datname = current_database()
                                  )
                                  AND classid = CAST(:lock_classid AS oid)
                                  AND objid = CAST(:lock_objid AS oid)
                                  AND objsubid = 1
                                  AND mode = 'ExclusiveLock'
                                  AND granted IS TRUE
                                  AND pid IS NOT NULL
                                  AND pid <> pg_backend_pid()
                            )
                            """
                        ),
                        {
                            "lock_classid": lock_key >> 32,
                            "lock_objid": lock_key & 0xFFFFFFFF,
                        },
                    )
                )
    except SQLAlchemyError:
        return False


def _probe_provider_health(
    client: httpx.Client,
    url: str,
    publishable_key: str,
    deadline: float,
    maximum_timeout: float,
) -> ComponentReadiness:
    remaining = deadline - monotonic()
    if remaining <= 0:
        return _component(False)
    try:
        with client.stream(
            "GET",
            url,
            headers={"apikey": publishable_key},
            timeout=min(maximum_timeout, remaining),
        ) as response:
            return _component(response.status_code == 200)
    except httpx.HTTPError:
        return _component(False)


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

    global _probe_executor, _snapshot_future, _snapshot_partial
    if get_readiness_engine.cache_info().currsize:
        get_readiness_engine().dispose()
    get_readiness_engine.cache_clear()
    with _probe_lock:
        if _probe_executor is not None:
            _probe_executor.shutdown(wait=False, cancel_futures=True)
        _probe_executor = None
        _snapshot_future = None
        _snapshot_partial = None
