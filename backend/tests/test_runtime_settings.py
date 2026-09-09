import pytest
from pydantic import ValidationError

from app.core.config import Settings


@pytest.mark.parametrize(
    ("environment_name", "invalid_value", "expected_field"),
    [
        ("REQUEST_BODY_MAX_BYTES", "0", "request_body_max_bytes"),
        ("DATABASE_POOL_SIZE", "0", "database_pool_size"),
        ("DATABASE_MAX_OVERFLOW", "-1", "database_max_overflow"),
        ("DATABASE_POOL_TIMEOUT_SECONDS", "0", "database_pool_timeout_seconds"),
        ("DATABASE_CONNECT_TIMEOUT_SECONDS", "0", "database_connect_timeout_seconds"),
        ("DATABASE_STATEMENT_TIMEOUT_MS", "0", "database_statement_timeout_ms"),
        ("READINESS_POOL_TIMEOUT_SECONDS", "0", "readiness_pool_timeout_seconds"),
        ("READINESS_CONNECT_TIMEOUT_SECONDS", "0", "readiness_connect_timeout_seconds"),
        ("READINESS_STATEMENT_TIMEOUT_MS", "0", "readiness_statement_timeout_ms"),
        ("READINESS_CALLER_TIMEOUT_SECONDS", "nan", "readiness_caller_timeout_seconds"),
        ("SUPABASE_TIMEOUT_SECONDS", "inf", "supabase_timeout_seconds"),
    ],
)
def test_runtime_limit_environment_values_must_preserve_their_bounds(
    monkeypatch: pytest.MonkeyPatch,
    environment_name: str,
    invalid_value: str,
    expected_field: str,
) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://test:test@localhost/test")
    monkeypatch.setenv(environment_name, invalid_value)

    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None)

    assert expected_field in str(error.value)
