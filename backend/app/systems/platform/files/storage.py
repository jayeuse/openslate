"""Construct the server-only Supabase private storage adapter."""

from app.core.config import get_settings
from app.systems.platform.files.providers import ProviderUnavailable, StorageBackend


def get_storage() -> StorageBackend:
    from app.systems.platform.files.supabase_storage import SupabaseStorage

    try:
        settings = get_settings()
        return SupabaseStorage(
            settings.supabase_url,
            settings.supabase_secret_key.get_secret_value(),
            settings.supabase_timeout_seconds,
        )
    except ProviderUnavailable as error:
        from fastapi import HTTPException

        raise HTTPException(
            503, detail={"code": "storage_unavailable", "message": "Storage is unavailable"}
        ) from error
