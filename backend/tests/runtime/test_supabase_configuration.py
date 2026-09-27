"""Fail at startup before sending credentials to an invalid provider target."""

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from tests.config_support import settings_values


@pytest.mark.parametrize(
    "field,value",
    [
        ("supabase_url", "https://user:private-password@supabase.test"),
        ("supabase_url", "https://supabase.test?key=private-key"),
        ("supabase_url", "https://supabase.test/storage/v1"),
        ("supabase_auth_issuer", "https://supabase.test/auth/v1#fragment"),
        ("supabase_auth_issuer", "file:///auth/v1"),
        ("supabase_session_encryption_key", "private-invalid-key"),
        ("supabase_secret_key", ""),
    ],
)
def test_invalid_provider_configuration_fails_without_leaking_values(
    field: str,
    value: str,
) -> None:
    with pytest.raises(ValidationError) as error:
        Settings(**settings_values(**{field: value}))
    if value:
        assert value not in str(error.value)


def test_provider_credentials_are_required_without_local_identity_fallback() -> None:
    values = settings_values()
    for field in tuple(values):
        if field.startswith("supabase_"):
            values.pop(field)
    with pytest.raises(ValidationError):
        Settings(**values)


def test_provider_secrets_are_hidden_in_settings_representation() -> None:
    values = settings_values()
    rendered = repr(Settings(**values))
    for name in (
        "supabase_secret_key",
        "supabase_publishable_key",
        "supabase_session_encryption_key",
    ):
        assert values[name] not in rendered


def test_backend_loads_provider_mail_configuration_without_local_storage_or_outbox() -> None:
    values = settings_values()
    values.pop("files_storage_root", None)
    values.pop("smtp_enabled", None)
    values.update(smtp_host="mailpit", smtp_port=1025, smtp_admin_email="sender@example.test")
    settings = Settings(**values)
    assert settings.supabase_url == values["supabase_url"]
    assert (settings.smtp_host, settings.smtp_port, settings.smtp_admin_email) == (
        "mailpit",
        1025,
        "sender@example.test",
    )


def test_missing_provider_mail_configuration_is_observable_without_startup_failure() -> None:
    settings = Settings(**settings_values())
    assert (settings.smtp_host, settings.smtp_port, settings.smtp_admin_email) == (None, None, None)


def test_invalid_provider_mail_port_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(**settings_values(smtp_port=65536))
