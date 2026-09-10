"""Typed, strict configuration for each backend process boundary."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import ClassVar
from urllib.parse import urlsplit

from pydantic import Field, FilePath, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict
from sqlalchemy.engine import make_url

from app.core.config.environment import ConfigurationError, environment_inputs

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DOTENV_PATH = REPOSITORY_ROOT / ".env"

class EnvironmentSettings(BaseSettings):
    """Base settings with canonical names, hidden values, and no dotenv fallback."""

    model_config = SettingsConfigDict(
        env_file=None,
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
        populate_by_name=True,
    )

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # environment_inputs has already selected exactly one source.
        return (init_settings,)

    @field_validator("*", mode="before")
    @classmethod
    def reject_blank_values(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("*", mode="before")
    @classmethod
    def validate_database_urls(cls, value: object, info: object) -> object:
        if getattr(info, "field_name", "") not in {"database_url", "migration_database_url"}:
            return value
        try:
            if make_url(str(value)).drivername != "postgresql+psycopg":
                raise ValueError
        except Exception:
            raise ValueError("must be a PostgreSQL psycopg URL") from None
        return value


class Settings(EnvironmentSettings):
    """Configuration required to start the FastAPI application process."""

    app_name: ClassVar[str] = "OpenSlate API"
    environment: str = Field(validation_alias="ENVIRONMENT")
    log_dir: Path = Field(validation_alias="LOG_DIR")
    database_url: str = Field(validation_alias="DATABASE_URL")
    supabase_url: str = Field(validation_alias="SUPABASE_URL")
    supabase_publishable_key: SecretStr = Field(validation_alias="SUPABASE_PUBLISHABLE_KEY")
    supabase_secret_key: SecretStr = Field(validation_alias="SUPABASE_SECRET_KEY")
    supabase_auth_redirect_url: str = Field(validation_alias="SUPABASE_AUTH_REDIRECT_URL")
    supabase_jwt_issuer: str = Field(validation_alias="SUPABASE_JWT_ISSUER")
    supabase_jwks_url: str = Field(validation_alias="SUPABASE_JWKS_URL")
    supabase_jwt_audience: str = Field(validation_alias="SUPABASE_JWT_AUDIENCE")
    security_event_server_key: SecretStr = Field(validation_alias="SECURITY_EVENT_SERVER_KEY")
    lifecycle_purge_enabled: bool = Field(validation_alias="LIFECYCLE_PURGE_ENABLED")
    cors_origins: list[str] = Field(min_length=1, validation_alias="CORS_ORIGINS")
    request_body_max_bytes: int = Field(gt=0, validation_alias="REQUEST_BODY_MAX_BYTES")
    database_pool_size: int = Field(gt=0, validation_alias="DATABASE_POOL_SIZE")
    database_max_overflow: int = Field(ge=0, validation_alias="DATABASE_MAX_OVERFLOW")
    database_pool_timeout_seconds: float = Field(
        gt=0, allow_inf_nan=False, validation_alias="DATABASE_POOL_TIMEOUT_SECONDS"
    )
    database_connect_timeout_seconds: int = Field(
        gt=0, validation_alias="DATABASE_CONNECT_TIMEOUT_SECONDS"
    )
    database_statement_timeout_ms: int = Field(
        gt=0, validation_alias="DATABASE_STATEMENT_TIMEOUT_MS"
    )
    readiness_pool_timeout_seconds: float = Field(
        gt=0, allow_inf_nan=False, validation_alias="READINESS_POOL_TIMEOUT_SECONDS"
    )
    readiness_connect_timeout_seconds: int = Field(
        gt=0, validation_alias="READINESS_CONNECT_TIMEOUT_SECONDS"
    )
    readiness_statement_timeout_ms: int = Field(
        gt=0, validation_alias="READINESS_STATEMENT_TIMEOUT_MS"
    )
    readiness_caller_timeout_seconds: float = Field(
        gt=0, allow_inf_nan=False, validation_alias="READINESS_CALLER_TIMEOUT_SECONDS"
    )
    supabase_timeout_seconds: float = Field(
        gt=0, allow_inf_nan=False, validation_alias="SUPABASE_TIMEOUT_SECONDS"
    )
    backend_bind_host: str = Field(validation_alias="BACKEND_BIND_HOST")
    backend_port: int = Field(ge=1, le=65535, validation_alias="BACKEND_PORT")
    server_max_concurrency: int = Field(gt=0, validation_alias="SERVER_MAX_CONCURRENCY")
    server_keep_alive_seconds: int = Field(gt=0, validation_alias="SERVER_KEEP_ALIVE_SECONDS")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        try:
            return json.loads(value)
        except ValueError:
            raise ValueError("must be a JSON array") from None

    @field_validator("log_dir")
    @classmethod
    def require_absolute_log_dir(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("must be an absolute path")
        return value

    @field_validator(
        "supabase_url",
        "supabase_auth_redirect_url",
        "supabase_jwt_issuer",
        "supabase_jwks_url",
    )
    @classmethod
    def require_http_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("must be an HTTP(S) URL")
        return value

    @field_validator("lifecycle_purge_enabled", mode="before")
    @classmethod
    def parse_lifecycle_purge_enabled(cls, value: object) -> object:
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value in {"true", "false"}:
            return value == "true"
        raise ValueError("must be true or false")


class MigrationSettings(EnvironmentSettings):
    migration_database_url: str = Field(validation_alias="MIGRATION_DATABASE_URL")


class AdminSettings(EnvironmentSettings):
    admin_email: str = Field(validation_alias="ADMIN_EMAIL")
    admin_username: str = Field(validation_alias="ADMIN_USERNAME")
    admin_password: SecretStr = Field(validation_alias="ADMIN_PASSWORD")


class ScannerSettings(EnvironmentSettings):
    files_clamav_host: str = Field(validation_alias="FILES_CLAMAV_HOST")
    files_clamav_port: int = Field(ge=1, le=65535, validation_alias="FILES_CLAMAV_PORT")
    files_clamav_manifest_path: FilePath = Field(validation_alias="FILES_CLAMAV_MANIFEST_PATH")


class SeedSettings(EnvironmentSettings):
    backend_url: str = Field(validation_alias="BACKEND_URL")
    supabase_access_token: SecretStr = Field(validation_alias="SUPABASE_ACCESS_TOKEN")


class ProvisionSettings(EnvironmentSettings):
    environment: str = Field(validation_alias="ENVIRONMENT")
    database_url: str = Field(validation_alias="DATABASE_URL")
    migration_database_url: str = Field(validation_alias="MIGRATION_DATABASE_URL")


def _load[SettingType: EnvironmentSettings](settings_type: type[SettingType]) -> SettingType:
    try:
        return settings_type.model_validate(environment_inputs(DOTENV_PATH))
    except ValidationError as error:
        names = sorted({str(item["loc"][0]) for item in error.errors() if item["loc"]})
        joined = ", ".join(names) if names else "environment"
        raise ConfigurationError(f"Invalid configuration: {joined}") from None


@lru_cache
def get_settings() -> Settings:
    return _load(Settings)


def get_migration_settings() -> MigrationSettings:
    return _load(MigrationSettings)


def get_admin_settings() -> AdminSettings:
    return _load(AdminSettings)


def get_scanner_settings() -> ScannerSettings:
    return _load(ScannerSettings)


def get_seed_settings() -> SeedSettings:
    return _load(SeedSettings)


def get_provision_settings() -> ProvisionSettings:
    return _load(ProvisionSettings)
