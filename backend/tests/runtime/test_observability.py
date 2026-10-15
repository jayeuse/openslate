import json
import logging
from secrets import token_urlsafe

import pytest

from app.core import observability

LOG_CANARY = token_urlsafe(32)


class CaptureHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def test_log_event_emits_only_the_allowlisted_safe_fields() -> None:
    logger = logging.getLogger(observability.LOGGER_NAME)
    handler = CaptureHandler()
    logger.addHandler(handler)

    try:
        observability.log_event(
            "upstream_failure",
            level=logging.WARNING,
            request_id="request-id",
            method="POST",
            route="/api/users/{user_id}",
            status=502,
            duration_ms=11,
            reason_code="identity_transport_error",
            operation_id="operation-id",
            actor_id="actor-id",
            upstream="identity",
        )
    finally:
        logger.removeHandler(handler)

    payload = json.loads(handler.records[0].getMessage())

    assert payload == {
        "timestamp": payload["timestamp"],
        "severity": "ERROR",
        "event": "upstream_failure",
        "service": "openslate-api",
        "request_id": "request-id",
        "method": "POST",
        "route": "/api/users/{user_id}",
        "status": 502,
        "duration_ms": 11,
        "reason_code": "identity_transport_error",
        "operation_id": "operation-id",
        "actor_id": "actor-id",
        "upstream": "identity",
    }


def test_configuration_disables_raw_uvicorn_access_logging() -> None:
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.disabled = False

    observability.configure_observability_logging()

    assert access_logger.disabled is True


def test_daily_files_append_and_terminal_is_readable(tmp_path, capsys, monkeypatch) -> None:
    from datetime import UTC, datetime

    from app.core.config import get_settings

    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    monkeypatch.setenv("LOG_DIR", str(tmp_path))
    get_settings.cache_clear()
    logger = logging.getLogger(observability.LOGGER_NAME)
    old_handlers = logger.handlers[:]
    logger.handlers = []
    try:
        observability.configure_observability_logging()
        observability.configure_observability_logging()
        for status in (200, 409, 503):
            observability.log_event(
                "http_request",
                method="POST",
                route="/api/records",
                status=status,
                duration_ms=12,
                request_id="diagnostic-id",
            )
        output = capsys.readouterr().out
        assert "INFO" in output and "WARN" in output and "ERROR" in output
        assert "POST /api/records 409 12ms" in output
        assert '{"timestamp"' not in output
        assert "diagnostic-id" not in output.splitlines()[0]
        path = tmp_path / f"{datetime.now(UTC).date()}.log"
        assert [json.loads(line)["status"] for line in path.read_text().splitlines()] == [
            200,
            409,
            503,
        ]
        logger.handlers = []
        observability.configure_observability_logging()
        observability.log_event("http_request", route="/api/health", status=200)
        assert capsys.readouterr().out == ""
        assert len(path.read_text().splitlines()) == 4
    finally:
        logger.handlers = old_handlers
        get_settings.cache_clear()


def test_sink_rollover_and_failure_recovery(tmp_path, monkeypatch) -> None:
    import io

    from app.core import log_sink

    stream = io.StringIO()
    sink = log_sink.DailyLogHandler(tmp_path, stream)

    def emit(day: str) -> None:
        payload = {
            "timestamp": f"2026-09-{day}T23:59:59+00:00",
            "severity": "INFO",
            "event": "http_request",
            "route": "/api/health",
            "status": 200,
        }
        sink.handle(logging.LogRecord("test", logging.INFO, "", 0, json.dumps(payload), (), None))

    emit("09")
    emit("10")
    assert len(list(tmp_path.glob("*.log"))) == 2
    original_open = log_sink.os.open

    def fail(*args, **kwargs):
        raise PermissionError(LOG_CANARY)

    monkeypatch.setattr(log_sink.os, "open", fail)
    emit("10")
    emit("10")
    assert stream.getvalue().count("log_sink_failure") == 1
    assert LOG_CANARY not in stream.getvalue()
    assert stream.getvalue().count("/api/health") == 2
    monkeypatch.setattr(log_sink.os, "open", original_open)
    emit("10")
    assert len((tmp_path / "2026-09-10.log").read_text().splitlines()) == 2
    assert "log_sink_recovered" in stream.getvalue()
    monkeypatch.setattr(log_sink.os, "open", fail)
    emit("10")
    assert stream.getvalue().count("log_sink_failure") == 2


def test_sink_closed_terminal_and_short_write_do_not_escape(tmp_path, monkeypatch) -> None:
    import io

    from app.core import log_sink

    stream = io.StringIO()
    stream.close()
    sink = log_sink.DailyLogHandler(tmp_path, stream)
    monkeypatch.setattr(log_sink.os, "write", lambda *args: 0)
    payload = {
        "timestamp": "2026-09-09T00:00:00Z",
        "severity": "WARNING",
        "event": "upstream_failure",
        "route": "/api/records",
        "method": "POST",
        "reason_code": "transport_failure",
        "upstream": "identity",
        "request_id": "request",
        "operation_id": "operation",
    }
    sink.handle(logging.LogRecord("test", logging.WARNING, "", 0, json.dumps(payload), (), None))


def test_independent_writers_preserve_complete_records(tmp_path) -> None:
    import io
    from concurrent.futures import ThreadPoolExecutor

    from app.core.log_sink import DailyLogHandler

    handlers = [DailyLogHandler(tmp_path, io.StringIO()) for _ in range(4)]

    def emit(index: int) -> None:
        payload = {
            "timestamp": "2026-09-09T00:00:00Z",
            "severity": "INFO",
            "event": "http_request",
            "route": "/api/health",
            "status": 200,
            "request_id": str(index),
        }
        record = logging.LogRecord("test", logging.INFO, "", 0, json.dumps(payload), (), None)
        handlers[index % 4].handle(record)

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(emit, range(100)))
    records = [json.loads(line) for line in (tmp_path / "2026-09-09.log").read_text().splitlines()]
    assert len(records) == 100
    assert {record["request_id"] for record in records} == {str(index) for index in range(100)}
    assert (tmp_path / "2026-09-09.log").stat().st_mode & 0o777 == 0o600


@pytest.mark.integration
def test_api_responses_survive_log_sink_failure_and_recover(tmp_path, monkeypatch, capsys) -> None:
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    destination = tmp_path / "destination"
    destination.write_text("not a directory")
    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    monkeypatch.setenv("LOG_DIR", str(destination))
    get_settings.cache_clear()
    logger = logging.getLogger(observability.LOGGER_NAME)
    old_handlers = logger.handlers[:]
    logger.handlers = []
    try:
        with TestClient(create_app()) as client:
            health = client.get("/api/health")
            rejected = client.get("/api/nonexistent-logging-test")
            assert health.status_code == 200
            assert health.json() == {"status": "ok", "service": "openslate-api"}
            assert rejected.status_code == 404
            assert health.headers["X-Request-ID"]
            assert rejected.headers["X-Request-ID"] != health.headers["X-Request-ID"]
            output = capsys.readouterr().out
            assert output.count("log_sink_failure") == 1
            assert "secret" not in output
            destination.unlink()
            destination.mkdir()
            recovered = client.get("/api/health")
            assert recovered.status_code == 200
            assert recovered.headers["X-Request-ID"]
            assert "log_sink_recovered" in capsys.readouterr().out
            records = [
                json.loads(line)
                for path in destination.glob("*.log")
                for line in path.read_text().splitlines()
            ]
            assert any(
                record.get("request_id") == recovered.headers["X-Request-ID"]
                and record["status"] == 200
                for record in records
            )
    finally:
        logger.handlers = old_handlers
        get_settings.cache_clear()


@pytest.mark.integration
def test_request_logs_use_complete_registered_route_templates() -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app

    handler = CaptureHandler()
    logger = logging.getLogger(observability.LOGGER_NAME)
    logger.addHandler(handler)
    try:
        with TestClient(create_app()) as client:
            assert client.get("/api/records").status_code == 401
            assert (
                client.get("/api/records/00000000-0000-0000-0000-000000000001").status_code == 401
            )
            assert client.get("/api/health").status_code == 200
            assert client.get(f"/api/unknown-{LOG_CANARY}?secret={LOG_CANARY}").status_code == 404
        records = [json.loads(record.getMessage()) for record in handler.records]
        routes = [record["route"] for record in records if record["event"] == "http_request"]
        assert routes == ["/api/records", "/api/records/{record_id}", "/api/health", "unknown"]
        assert LOG_CANARY not in json.dumps(records)
    finally:
        logger.removeHandler(handler)
