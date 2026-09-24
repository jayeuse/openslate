"""Typed, strict configuration for each backend process boundary."""

from __future__ import annotations

import ipaddress
from functools import lru_cache
from pathlib import Path
from typing import ClassVar, Literal
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, InvalidToken
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
            "database_inspector_url",
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
    auth_jwt_secret: SecretStr = Field(validation_alias="AUTH_JWT_SECRET")
    auth_jwt_issuer: str = Field(validation_alias="AUTH_JWT_ISSUER")
    auth_jwt_audience: str = Field(validation_alias="AUTH_JWT_AUDIENCE")
    auth_access_token_minutes: int = Field(
        default=15, ge=1, le=60, validation_alias="AUTH_ACCESS_TOKEN_MINUTES"
    )
    auth_refresh_token_days: int = Field(
        default=7, ge=1, le=31, validation_alias="AUTH_REFRESH_TOKEN_DAYS"
    )
    smtp_enabled: bool = Field(default=False, validation_alias="SMTP_ENABLED")
    smtp_host: str | None = Field(default=None, validation_alias="SMTP_HOST")
    smtp_port: int | None = Field(default=None, ge=1, le=65535, validation_alias="SMTP_PORT")
    smtp_username: str | None = Field(default=None, validation_alias="SMTP_USERNAME")
    smtp_password: SecretStr | None = Field(default=None, validation_alias="SMTP_PASSWORD")
    smtp_from: str | None = Field(default=None, validation_alias="SMTP_FROM")
    smtp_transport: Literal["starttls", "implicit_tls", "plain"] | None = Field(
        default=None, validation_alias="SMTP_TRANSPORT"
    )
    smtp_delivery_encryption_key: SecretStr | None = Field(
        default=None, validation_alias="SMTP_DELIVERY_ENCRYPTION_KEY"
    )
    smtp_timeout_seconds: float = Field(
        default=10, gt=0, le=30, validation_alias="SMTP_TIMEOUT_SECONDS"
    )
    smtp_delivery_operation_timeout_seconds: float = Field(
        default=30, gt=0, le=45, validation_alias="SMTP_DELIVERY_OPERATION_TIMEOUT_SECONDS"
    )
    smtp_delivery_batch_size: int = Field(
        default=10, ge=1, le=100, validation_alias="SMTP_DELIVERY_BATCH_SIZE"
    )
    smtp_delivery_max_attempts: int = Field(
        default=5, ge=1, le=10, validation_alias="SMTP_DELIVERY_MAX_ATTEMPTS"
    )
    security_event_server_key: SecretStr = Field(validation_alias="SECURITY_EVENT_SERVER_KEY")
    lifecycle_purge_enabled: bool = Field(validation_alias="LIFECYCLE_PURGE_ENABLED")
    files_storage_root: Path = Field(validation_alias="FILES_STORAGE_ROOT")
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

    @field_validator("auth_jwt_secret")
    @classmethod
    def require_strong_jwt_secret(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value().encode("utf-8")) < 32:
            raise ValueError("must be at least 32 bytes")
        return value

    @field_validator("log_dir", "files_storage_root", "web_assets_root")
    @classmethod
    def require_absolute_path(cls, value: Path | None) -> Path | None:
        if value is None:
            return None
        if not value.is_absolute():
            raise ValueError("must be an absolute path")
        return value

    @field_validator(
        "auth_jwt_issuer",
    )
    @classmethod
    def require_http_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("must be an HTTP(S) URL")
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

    @field_validator("smtp_enabled", mode="before")
    @classmethod
    def parse_smtp_enabled(cls, value: object) -> object:
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
            if self.auth_jwt_issuer != self.public_origin:
                raise ValueError(
                    "AUTH_JWT_ISSUER must exactly match PUBLIC_ORIGIN in development"
                )
            return self
        if parsed.scheme == "https":
            return self
        if self.environment == "development":
            raise ValueError("PUBLIC_ORIGIN must use HTTPS or local development HTTP")
        raise ValueError("PUBLIC_ORIGIN must use HTTPS outside development and test")

    @model_validator(mode="after")
    def validate_smtp_configuration(self) -> Settings:
        if self.environment not in {"development", "test"} and self.web_assets_root is None:
            raise ValueError("WEB_ASSETS_ROOT is required outside development and test")
        values = (
            self.smtp_host,
            self.smtp_port,
            self.smtp_from,
            self.smtp_transport,
            self.smtp_delivery_encryption_key,
        )
        if not self.smtp_enabled:
            if any(value is not None for value in values) or (
                self.smtp_username is not None or self.smtp_password is not None
            ):
                raise ValueError("SMTP settings require SMTP_ENABLED=true")
            return self
        if any(value is None for value in values):
            raise ValueError(
                "Enabled SMTP requires host, port, sender, transport and encryption key"
            )
        assert self.smtp_host is not None
        assert self.smtp_from is not None
        assert self.smtp_transport is not None
        assert self.smtp_delivery_encryption_key is not None
        if self.smtp_delivery_operation_timeout_seconds < self.smtp_timeout_seconds:
            raise ValueError("SMTP delivery operation timeout must cover the socket timeout")
        if (self.smtp_username is None) != (self.smtp_password is None):
            raise ValueError("SMTP username and password must be configured together")
        if "\r" in self.smtp_from or "\n" in self.smtp_from:
            raise ValueError("SMTP sender is invalid")
        if self.smtp_transport == "plain" and (
            self.environment not in {"development", "test"}
            or not _is_loopback_host(self.smtp_host)
        ):
            raise ValueError("Plain SMTP is allowed only for loopback development")
        try:
            Fernet(self.smtp_delivery_encryption_key.get_secret_value().encode("ascii"))
        except (UnicodeEncodeError, ValueError, InvalidToken):
            raise ValueError("SMTP delivery encryption key is invalid") from None
        return self


def _is_loopback_host(host: str | None) -> bool:
    if host is None:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


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
    admin_password: SecretStr = Field(validation_alias="ADMIN_PASSWORD")


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
    database_inspector_url: str | None = Field(
        default=None, validation_alias="DATABASE_INSPECTOR_URL"
    )
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
