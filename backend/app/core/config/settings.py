from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "OpenSlate API"
    environment: str = "development"
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

    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
