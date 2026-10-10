"""The FastAPI environment that full-stack runs give their disposable API process."""

import secrets
from pathlib import Path

RUNNER_API_PORT = "8008"
RUNNER_CONCURRENCY_LIMIT = 64


def runtime_database_environment(database_env: dict[str, str]) -> dict[str, str]:
    """Pass only the runtime login to FastAPI and its worker processes."""

    return {"DATABASE_URL": database_env["DATABASE_URL"]}


def api_environment(
    base_env: dict[str, str],
    database_env: dict[str, str],
    provider_env: dict[str, str],
    *,
    run_id: str,
    database_manifest: Path,
    private: Path,
    public_origin: str,
    purge_enabled: bool = True,
) -> dict[str, str]:
    """Test-mode settings with strict origin, host, body and concurrency limits."""

    return {
        **base_env,
        **runtime_database_environment(database_env),
        **provider_env,
        "ENVIRONMENT": "test",
        "E2E_ALLOW_MUTATIONS": "true",
        "OPENSLATE_FULLSTACK_RUN_ID": run_id,
        "OPENSLATE_TEST_DATABASE_MANIFEST": str(database_manifest),
        "PUBLICATION_SIGNING_KEY": secrets.token_urlsafe(48),
        "AUTH_REFRESH_TOKEN_DAYS": "7",
        "LIFECYCLE_PURGE_ENABLED": "true" if purge_enabled else "false",
        "SECURITY_EVENT_SERVER_KEY": secrets.token_urlsafe(32),
        "PUBLIC_ORIGIN": public_origin,
        "LOG_DIR": str(private / "api-logs"),
        "REQUEST_BODY_MAX_BYTES": "1048576",
        "DATABASE_POOL_SIZE": "5",
        "DATABASE_MAX_OVERFLOW": "5",
        "DATABASE_POOL_TIMEOUT_SECONDS": "5",
        "DATABASE_CONNECT_TIMEOUT_SECONDS": "3",
        "DATABASE_STATEMENT_TIMEOUT_MS": "15000",
        "READINESS_POOL_TIMEOUT_SECONDS": "0.25",
        "READINESS_CONNECT_TIMEOUT_SECONDS": "1",
        "READINESS_STATEMENT_TIMEOUT_MS": "500",
        "READINESS_CALLER_TIMEOUT_SECONDS": "2",
        "BACKEND_BIND_HOST": "127.0.0.1",
        "BACKEND_PORT": RUNNER_API_PORT,
        "SERVER_MAX_CONCURRENCY": str(RUNNER_CONCURRENCY_LIMIT),
        "SERVER_KEEP_ALIVE_SECONDS": "5",
    }
