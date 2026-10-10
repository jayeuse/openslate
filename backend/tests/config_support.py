"""Synthetic configuration for isolated backend tests."""

from __future__ import annotations

from typing import Any

from cryptography.fernet import Fernet

_SESSION_ENCRYPTION_KEY = Fernet.generate_key().decode("ascii")


def settings_values(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "environment": "test",
        "log_dir": "/tmp/openslate-test-logs",
        "database_url": "postgresql+psycopg://test:test-password@127.0.0.1/test",
        "supabase_url": "http://127.0.0.1:58000",
        "supabase_publishable_key": "sb_publishable_isolated_test_only",
        "supabase_secret_key": "sb_secret_isolated_test_only",
        "supabase_auth_issuer": "http://127.0.0.1:58000/auth/v1",
        "supabase_session_encryption_key": _SESSION_ENCRYPTION_KEY,
        "publication_signing_key": "a" * 64,
        "security_event_server_key": "test-security-event-key",
        "lifecycle_purge_enabled": True,
        "public_origin": "http://frontend.test",
        "request_body_max_bytes": 1_048_576,
        "database_pool_size": 5,
        "database_max_overflow": 5,
        "database_pool_timeout_seconds": 5.0,
        "database_connect_timeout_seconds": 3,
        "database_statement_timeout_ms": 15_000,
        "readiness_pool_timeout_seconds": 0.25,
        "readiness_connect_timeout_seconds": 1,
        "readiness_statement_timeout_ms": 500,
        "readiness_caller_timeout_seconds": 2.0,
        "backend_bind_host": "127.0.0.1",
        "backend_port": 8000,
        "server_max_concurrency": 32,
        "server_keep_alive_seconds": 5,
    }
    values.update(overrides)
    return values


def settings_environment() -> dict[str, str]:
    return {
        name.upper(): str(value).lower() if isinstance(value, bool) else str(value)
        for name, value in settings_values().items()
    }
