"""Typed, strict configuration for each backend process boundary."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import ClassVar, Literal
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from pydantic import Field, FilePath, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict
from sqlalchemy.engine import make_url

from app.core.config.development import is_local_development_host, is_relaxed_development
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
        if value is None:
            return value
        if getattr(info, "field_name", "") not in {
            "database_bootstrap_url",
            "database_url",
            "migration_database_url",
        }:
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
    supabase_auth_issuer: str = Field(validation_alias="SUPABASE_AUTH_ISSUER")
    supabase_auth_audience: Literal["authenticated"] = "authenticated"
    smtp_host: str | None = Field(default=None, validation_alias="SMTP_HOST")
    smtp_port: int | None = Field(default=None, ge=1, le=65535, validation_alias="SMTP_PORT")
    smtp_admin_email: str | None = Field(default=None, validation_alias="SMTP_ADMIN_EMAIL")
    supabase_session_encryption_key: SecretStr = Field(
        validation_alias="SUPABASE_SESSION_ENCRYPTION_KEY"
    )
    supabase_timeout_seconds: float = Field(
        default=10,
        gt=0,
        le=30,
        allow_inf_nan=False,
        validation_alias="SUPABASE_TIMEOUT_SECONDS",
    )
    publication_signing_key: SecretStr = Field(validation_alias="PUBLICATION_SIGNING_KEY")
    auth_refresh_token_days: int = Field(
        default=7, ge=1, le=31, validation_alias="AUTH_REFRESH_TOKEN_DAYS"
    )
    security_event_server_key: SecretStr = Field(validation_alias="SECURITY_EVENT_SERVER_KEY")
    lifecycle_purge_enabled: bool = Field(validation_alias="LIFECYCLE_PURGE_ENABLED")
    public_origin: str = Field(validation_alias="PUBLIC_ORIGIN")
    web_assets_root: Path | None = Field(default=None, validation_alias="WEB_ASSETS_ROOT")
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
    backend_bind_host: str = Field(validation_alias="BACKEND_BIND_HOST")
    backend_port: int = Field(ge=1, le=65535, validation_alias="BACKEND_PORT")
    server_max_concurrency: int = Field(ge=3, validation_alias="SERVER_MAX_CONCURRENCY")
    server_keep_alive_seconds: int = Field(gt=0, validation_alias="SERVER_KEEP_ALIVE_SECONDS")

    @model_validator(mode="before")
    @classmethod
    def reject_removed_runtime_settings(cls, value: object) -> object:
        if isinstance(value, dict) and {"CORS_ORIGINS", "cors_origins"} & value.keys():
            raise ValueError("CORS_ORIGINS is no longer supported")
        return value

    @field_validator("publication_signing_key")
    @classmethod
    def require_strong_publication_key(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value().encode("utf-8")) < 32:
            raise ValueError("must be at least 32 bytes")
        return value

    @field_validator("supabase_url", "supabase_auth_issuer")
    @classmethod
    def validate_supabase_endpoint(cls, value: str, info: object) -> str:
        try:
            parsed = urlsplit(value)
            valid_port = parsed.port is None or 1 <= parsed.port <= 65535
        except ValueError:
            raise ValueError("must be a valid Supabase HTTP(S) endpoint") from None
        is_gateway = getattr(info, "field_name", "") == "supabase_url"
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or any(character.isspace() for character in value)
            or not valid_port
            or (is_gateway and parsed.path not in {"", "/"})
        ):
            raise ValueError("must be a valid Supabase HTTP(S) endpoint")
        return value.rstrip("/")

    @field_validator("supabase_session_encryption_key")
    @classmethod
    def validate_session_encryption_key(cls, value: SecretStr) -> SecretStr:
        try:
            Fernet(value.get_secret_value().encode("ascii"))
        except (UnicodeEncodeError, ValueError):
            raise ValueError("must be a valid Fernet key") from None
        return value

    @field_validator("log_dir", "web_assets_root")
    @classmethod
    def require_absolute_path(cls, value: Path | None) -> Path | None:
        if value is None:
            return None
        if not value.is_absolute():
            raise ValueError("must be an absolute path")
        return value

    @field_validator("public_origin")
    @classmethod
    def normalize_public_origin(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("must be an HTTP(S) origin")
        try:
            port = parsed.port
        except ValueError:
            raise ValueError("must be an HTTP(S) origin") from None
        scheme = parsed.scheme.lower()
        host = parsed.hostname.lower()
        rendered_host = f"[{host}]" if ":" in host else host
        if port is None or (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
            return f"{scheme}://{rendered_host}"
        return f"{scheme}://{rendered_host}:{port}"

    @field_validator("lifecycle_purge_enabled", mode="before")
    @classmethod
    def parse_lifecycle_purge_enabled(cls, value: object) -> object:
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value in {"true", "false"}:
            return value == "true"
        raise ValueError("must be true or false")

    @model_validator(mode="after")
    def validate_public_origin_transport(self) -> Settings:
        parsed = urlsplit(self.public_origin)
        if self.environment == "test":
            return self
        if is_relaxed_development(self) and is_local_development_host(parsed.hostname or ""):
            return self
        if parsed.scheme == "https":
            return self
        if self.environment == "development":
            raise ValueError("PUBLIC_ORIGIN must use HTTPS or local development HTTP")
        raise ValueError("PUBLIC_ORIGIN must use HTTPS outside development and test")

    @model_validator(mode="after")
    def validate_static_assets(self) -> Settings:
        if self.environment not in {"development", "test"} and self.web_assets_root is None:
            raise ValueError("WEB_ASSETS_ROOT is required outside development and test")
        return self


class MigrationSettings(EnvironmentSettings):
    migration_database_url: str = Field(validation_alias="MIGRATION_DATABASE_URL")


class InstanceSettings(EnvironmentSettings):
    environment: str = Field(validation_alias="ENVIRONMENT")
    open_slate_instance_id: str = Field(validation_alias="OPENSLATE_INSTANCE_ID")
    postgres_host: str = Field(validation_alias="POSTGRES_HOST")
    postgres_port: int = Field(ge=1, le=65535, validation_alias="POSTGRES_PORT")
    postgres_database: str = Field(validation_alias="POSTGRES_DATABASE")


class AdminSettings(EnvironmentSettings):
    admin_email: str = Field(validation_alias="ADMIN_EMAIL")
    admin_username: str = Field(validation_alias="ADMIN_USERNAME")


class ScannerSettings(EnvironmentSettings):
    files_clamav_host: str = Field(validation_alias="FILES_CLAMAV_HOST")
    files_clamav_port: int = Field(ge=1, le=65535, validation_alias="FILES_CLAMAV_PORT")
    files_clamav_manifest_path: FilePath = Field(validation_alias="FILES_CLAMAV_MANIFEST_PATH")


class SeedSettings(EnvironmentSettings):
    backend_url: str = Field(validation_alias="BACKEND_URL")
    seed_access_token: SecretStr = Field(validation_alias="SEED_ACCESS_TOKEN")


class ProvisionSettings(EnvironmentSettings):
    environment: str = Field(validation_alias="ENVIRONMENT")
    database_bootstrap_url: str = Field(validation_alias="DATABASE_BOOTSTRAP_URL")
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


def get_instance_settings() -> InstanceSettings:
    return _load(InstanceSettings)


def get_admin_settings() -> AdminSettings:
    return _load(AdminSettings)


def get_scanner_settings() -> ScannerSettings:
    return _load(ScannerSettings)


def get_seed_settings() -> SeedSettings:
    return _load(SeedSettings)


def get_provision_settings() -> ProvisionSettings:
    return _load(ProvisionSettings)
