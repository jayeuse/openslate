from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "OpenSlate API"
    environment: str = "development"
    log_dir: Path = Path(__file__).resolve().parents[3] / "logs"
    database_url: str
    migration_database_url: str | None = None
    supabase_url: str | None = None
    supabase_publishable_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"
        ),
    )
    supabase_secret_key: SecretStr | None = None
    supabase_auth_redirect_url: str | None = None
    supabase_jwt_issuer: str | None = None
    supabase_jwks_url: str | None = None
    supabase_jwt_audience: str = Field(
        default="authenticated",
        validation_alias=AliasChoices("SUPABASE_JWT_AUDIENCE", "SUPABASE_AUDIENCE"),
    )
    security_event_server_key: SecretStr | None = None
    lifecycle_purge_enabled: bool = False
    cors_origins: list[str] = ["http://localhost:3000"]
    request_body_max_bytes: int = Field(default=1024 * 1024, gt=0)
    database_pool_size: int = Field(default=5, gt=0)
    database_max_overflow: int = Field(default=5, ge=0)
    database_pool_timeout_seconds: float = Field(default=5.0, gt=0, allow_inf_nan=False)
    database_connect_timeout_seconds: int = Field(default=3, gt=0)
    database_statement_timeout_ms: int = Field(default=15_000, gt=0)
    readiness_pool_timeout_seconds: float = Field(default=0.25, gt=0, allow_inf_nan=False)
    readiness_connect_timeout_seconds: int = Field(default=1, gt=0)
    readiness_statement_timeout_ms: int = Field(default=500, gt=0)
    readiness_caller_timeout_seconds: float = Field(default=2.0, gt=0, allow_inf_nan=False)
    supabase_timeout_seconds: float = Field(default=10.0, gt=0, allow_inf_nan=False)

    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
