from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from uuid import UUID

import pytest
from sqlalchemy import text

from app.systems.sandbox.lifecycle.service import hash_challenge_token
from tests.lifecycle_integration.test_lifecycle_api_integration import (  # noqa: F401
    LifecycleApiClient,
)

CONFIRMATION_PASSWORD = token_urlsafe(32)

pytest_plugins = ("tests.lifecycle_integration.test_lifecycle_api_integration",)
pytestmark = pytest.mark.integration


@pytest.mark.parametrize("stored_status", ["pending", "expired"])
def test_registered_close_rejects_expired_challenge_before_password_provider(
    lifecycle_api_client: Callable[[], LifecycleApiClient],
    stored_status: str,
) -> None:
    client = lifecycle_api_client()
    department = client.request("POST", "/api/departments", {"department_name": "API expired"})
    module = client.request(
        "POST",
        "/api/modules",
        {"department_id": department.json()["id"], "module_name": "Assets"},
    )
    module_id = module.json()["id"]
    preview = client.request("POST", f"/api/modules/{module_id}/close/preview")
    token = preview.json()["token"]
    created_at = datetime.now(UTC) - timedelta(minutes=4)
    expires_at = datetime.now(UTC) - timedelta(minutes=1)
    with client.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE public.lifecycle_confirmation_challenges "
                "SET status = :status, created_at = :created_at, expires_at = :expires_at "
                "WHERE token_hash = :token_hash"
            ),
            {
                "status": stored_status,
                "created_at": created_at,
                "expires_at": expires_at,
                "token_hash": hash_challenge_token(token),
            },
        )

    calls: list[str] = []

    class PasswordClient:
        def __init__(self, _db) -> None:
            pass

        def verify_password(self, _email: str, _password: str) -> UUID:
            calls.append("called")
            return client.actor.id

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "app.systems.sandbox.lifecycle.challenge_verification.ProviderPasswordGrantClient",
            PasswordClient,
        )
        response = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": CONFIRMATION_PASSWORD},
        )

        with client.engine.connect() as connection:
            state = connection.execute(
                text(
                    "SELECT status, verification_lease_id "
                    "FROM public.lifecycle_confirmation_challenges "
                    "WHERE token_hash = :token_hash"
                ),
                {"token_hash": hash_challenge_token(token)},
            ).one()

        repeated = client.request(
            "POST",
            f"/api/modules/{module_id}/close",
            {"token": token, "confirmation_name": "Assets", "password": CONFIRMATION_PASSWORD},
        )

    with client.engine.connect() as connection:
        repeated_state = connection.execute(
            text(
                "SELECT status, verification_lease_id "
                "FROM public.lifecycle_confirmation_challenges "
                "WHERE token_hash = :token_hash"
            ),
            {"token_hash": hash_challenge_token(token)},
        ).one()

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "challenge_expired"
    assert tuple(state) == ("expired", None)
    assert repeated.status_code == 409, repeated.text
    assert repeated.json()["detail"]["code"] == "challenge_expired"
    assert tuple(repeated_state) == ("expired", None)
    assert calls == []
