"""Provider factory failure mapping at the application boundary."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from pydantic import SecretStr

from app.systems.platform.files import storage as storage_module
from app.systems.platform.files.providers import ProviderUnavailable


def test_storage_dependency_translates_provider_unavailability(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "app.systems.platform.files.supabase_storage.SupabaseStorage",
        Mock(side_effect=ProviderUnavailable("offline")),
    )
    monkeypatch.setattr(
        storage_module,
        "get_settings",
        lambda: SimpleNamespace(
            supabase_url="http://storage.internal",
            supabase_secret_key=SecretStr("server-secret"),
            supabase_timeout_seconds=2,
        ),
    )
    with pytest.raises(HTTPException) as caught:
        storage_module.get_storage()
    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "storage_unavailable"
