from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "OpenSlate API"
    environment: str = "development"
    database_url: str
    secret_key: SecretStr
    admin_bootstrap_username: str | None = None
    admin_bootstrap_password: SecretStr | None = None
    sample_user_password: SecretStr | None = None
    access_token_expire_minutes: int = Field(default=30, gt=0)
    refresh_token_expire_days: int = Field(default=7, gt=0)
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:8080"]
    storage_path: Path = Path("storage")

    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
