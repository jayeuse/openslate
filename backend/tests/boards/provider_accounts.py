"""Guarded, disposable Supabase identities for Boards integration tests."""

import os
from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.provider_instance import assert_provider_instance

_PROVIDER_USERS_INFO_KEY = "tests.boards.provider_user_ids"


def _admin_client() -> httpx.Client:
    settings = get_settings()
    runtime_database_url = os.environ["TEST_DATABASE_URL"]
    assert_provider_instance(
        dict(os.environ), database_url=runtime_database_url, expected_user="openslate_runtime"
    )
    return httpx.Client(
        base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
        timeout=15,
    )


def create_password_account(db: Session, *, email: str, password: str) -> UUID:
    """Create and register one runner-owned identity for a step-up test."""

    with _admin_client() as admin:
        response = admin.post(
            "admin/users",
            json={"email": email, "password": password, "email_confirm": True},
        )
    assert response.status_code in {200, 201}, "Could not create disposable provider identity"
    try:
        provider_user_id = UUID(response.json()["id"])
    except (KeyError, TypeError, ValueError):
        raise AssertionError("Provider returned an invalid disposable identity") from None
    db.info.setdefault(_PROVIDER_USERS_INFO_KEY, []).append(provider_user_id)
    return provider_user_id


def cleanup_password_accounts(db: Session) -> None:
    """Delete every provider identity registered by this test's database session."""

    provider_user_ids = tuple(db.info.get(_PROVIDER_USERS_INFO_KEY, ()))
    if not provider_user_ids:
        return
    failures = 0
    with _admin_client() as admin:
        for provider_user_id in provider_user_ids:
            try:
                response = admin.delete(f"admin/users/{provider_user_id}")
            except httpx.RequestError:
                failures += 1
                continue
            if response.status_code not in {200, 204, 404}:
                failures += 1
    db.info.pop(_PROVIDER_USERS_INFO_KEY, None)
    assert failures == 0, f"Could not delete {failures} disposable provider identity(ies)"
