from pathlib import Path
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

import app.core.config.settings as settings_module
from app.core.config import (
    ConfigurationError,
    Settings,
    get_admin_settings,
    get_migration_settings,
    get_provision_settings,
    read_environment,
)
from app.core.config.environment import environment_inputs
from tests.config_support import settings_values


def test_dotenv_reader_uses_one_file_for_expansion(tmp_path: Path) -> None:
    environment = tmp_path / ".env"
    environment.write_text("ROOT=/srv/openslate\nLOG_DIR=${ROOT}/logs\n", encoding="utf-8")

    assert read_environment(environment) == {
        "ROOT": "/srv/openslate",
        "LOG_DIR": "/srv/openslate/logs",
    }
    values = environment_inputs(environment, process={"LOG_DIR": "/mounted/logs"})
    assert values["LOG_DIR"] == "/srv/openslate/logs"
    assert environment_inputs(
        tmp_path / "not-read.env",
        process={"OPENSLATE_ENV_SOURCE": "process", "LOG_DIR": "/injected/logs"},
    ) == {"OPENSLATE_ENV_SOURCE": "process", "LOG_DIR": "/injected/logs"}


@pytest.mark.parametrize(
    "contents",
    [
        "DATABASE_URL=first\nDATABASE_URL=second\n",
        "DATABASE_URL=${MISSING_URL}\n",
        "DATABASE_URL=${MIGRATION_DATABASE_URL}\nMIGRATION_DATABASE_URL=${DATABASE_URL}\n",
        "DATABASE_URL\n",
        "DATABASE_URL=${MISSING_URL:-fallback}\n",
        'DATABASE_URL="unterminated-private-value\n',
    ],
)
def test_dotenv_reader_rejects_ambiguous_or_external_resolution(
    tmp_path: Path, contents: str
) -> None:
    environment = tmp_path / ".env"
    environment.write_text(contents, encoding="utf-8")

    with pytest.raises(ConfigurationError) as error:
        read_environment(environment)

    assert "first" not in str(error.value)
    assert "second" not in str(error.value)
    assert "fallback" not in str(error.value)
    assert "unterminated-private-value" not in str(error.value)


def test_dotenv_reader_rejects_unreadable_and_unsupported_source_selector(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="unavailable"):
        read_environment(tmp_path / "missing.env")
    with pytest.raises(ConfigurationError, match="OPENSLATE_ENV_SOURCE"):
        environment_inputs(tmp_path / "missing.env", process={"OPENSLATE_ENV_SOURCE": "shell"})


def test_operation_loaders_read_canonical_values_and_report_missing_names(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    environment = tmp_path / ".env"
    environment.write_text(
        "ADMIN_EMAIL=admin@example.test\nADMIN_USERNAME=admin\n"
        "ENVIRONMENT=test\nDATABASE_URL=postgresql+psycopg://openslate_runtime:pass@127.0.0.1/db\n"
        "MIGRATION_DATABASE_URL=postgresql+psycopg://openslate_owner:pass@127.0.0.1/db\n"
        "DATABASE_BOOTSTRAP_URL=postgresql+psycopg://postgres:pass@127.0.0.1/db\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings_module, "DOTENV_PATH", environment)
    monkeypatch.delenv("OPENSLATE_ENV_SOURCE", raising=False)

    assert get_admin_settings().admin_username == "admin"
    assert get_provision_settings().environment == "test"

    environment.write_text("ADMIN_EMAIL=admin@example.test\n", encoding="utf-8")
    with pytest.raises(ConfigurationError) as error:
        get_admin_settings()
    assert str(error.value) == "Invalid configuration: ADMIN_USERNAME"


def test_settings_rejects_blank_and_malformed_canonical_values() -> None:
    values = settings_values(
        publication_signing_key=" ",
        backend_port="not-a-port",
        log_dir="relative-logs",
        public_origin="not-a-url",
        database_url="postgresql://test:test-password@127.0.0.1/test",
        lifecycle_purge_enabled="yes",
    )

    with pytest.raises(ValidationError) as error:
        Settings(**values, _env_file=None)

    rendered = str(error.value)
    assert "publication_signing_key" in rendered
    assert "backend_port" in rendered
    assert "log_dir" in rendered
    assert "public_origin" in rendered
    assert "database_url" in rendered
    assert "lifecycle_purge_enabled" in rendered
    assert "not-a-port" not in rendered
    assert "invalid-origin-list" not in rendered


def test_settings_rejects_the_removed_cors_origins_runtime_setting() -> None:
    with pytest.raises(ValidationError, match="CORS_ORIGINS is no longer supported"):
        Settings(**settings_values(CORS_ORIGINS='["https://legacy.example.test"]'), _env_file=None)


def test_settings_rejects_an_undersized_publication_signing_key() -> None:
    with pytest.raises(ValidationError) as error:
        Settings(**settings_values(publication_signing_key="too-short"), _env_file=None)

    assert "publication_signing_key" in str(error.value)


@pytest.mark.parametrize("concurrency", [1, 2])
def test_settings_reserve_capacity_for_connection_admission_sse_and_http(
    concurrency: int,
) -> None:
    with pytest.raises(ValidationError) as error:
        Settings(**settings_values(server_max_concurrency=concurrency), _env_file=None)

    assert "server_max_concurrency" in str(error.value)


def test_settings_accepts_the_minimum_sse_safe_concurrency() -> None:
    settings = Settings(**settings_values(server_max_concurrency=3), _env_file=None)

    assert settings.server_max_concurrency == 3


def test_missing_local_admin_values_cannot_be_filled_from_the_shell(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    environment = tmp_path / ".env"
    environment.write_text("ADMIN_EMAIL=local@example.test\n", encoding="utf-8")
    monkeypatch.setattr(settings_module, "DOTENV_PATH", environment)
    monkeypatch.delenv("OPENSLATE_ENV_SOURCE", raising=False)
    monkeypatch.setenv("ADMIN_USERNAME", "stale-user")
    monkeypatch.setenv("ADMIN_PASSWORD", "stale-private-password")

    with pytest.raises(ConfigurationError) as error:
        get_admin_settings()

    assert str(error.value) == "Invalid configuration: ADMIN_USERNAME"


def test_migration_requires_its_owner_url_without_runtime_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    environment = tmp_path / ".env"
    environment.write_text(
        "DATABASE_URL=postgresql://runtime:private@127.0.0.1/db\n", encoding="utf-8"
    )
    monkeypatch.setattr(settings_module, "DOTENV_PATH", environment)
    monkeypatch.delenv("MIGRATION_DATABASE_URL", raising=False)
    monkeypatch.delenv("OPENSLATE_ENV_SOURCE", raising=False)

    with pytest.raises(ConfigurationError) as error:
        get_migration_settings()

    assert str(error.value) == "Invalid configuration: MIGRATION_DATABASE_URL"
    assert "private" not in str(error.value)




def test_module_entrypoint_passes_each_server_option_explicitly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import __main__ as entrypoint

    settings = Settings(**settings_values(), _env_file=None)
    run = Mock()
    monkeypatch.setattr(entrypoint, "get_settings", lambda: settings)
    monkeypatch.setattr(entrypoint.uvicorn, "run", run)

    entrypoint.main([])

    run.assert_called_once_with(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        limit_concurrency=32,
        timeout_keep_alive=5,
        reload=False,
        access_log=False,
        forwarded_allow_ips=[],
    )
