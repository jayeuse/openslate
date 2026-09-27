"""Pinned Supabase Auth action protocol at the backend HTTP boundary."""

from uuid import uuid4

import httpx
import pytest

from tests.auth.test_supabase_auth_core import _settings


def test_admin_invite_has_server_owned_marker_and_email_action_is_explicit() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient

    local_user_id, operation_id, provider_user_id = uuid4(), uuid4(), uuid4()
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/auth/v1/admin/users":
            return httpx.Response(
                200,
                json={
                    "id": str(provider_user_id),
                    "email": "person@example.test",
                    "app_metadata": {
                        "openslate_user_id": str(local_user_id),
                        "openslate_invitation_operation_id": str(operation_id),
                    },
                },
            )
        if request.url.path == "/auth/v1/invite":
            return httpx.Response(200, json={"id": str(provider_user_id)})
        if request.url.path == "/auth/v1/verify":
            return httpx.Response(
                200,
                json={
                    "access_token": "access",
                    "refresh_token": "refresh",
                    "expires_in": 600,
                    "user": {"id": str(provider_user_id)},
                },
            )
        return httpx.Response(404)

    client = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))
    created = client.admin_create_invitation_user(
        "person@example.test", local_user_id, operation_id
    )
    assert created.id == provider_user_id
    assert created.app_metadata["openslate_user_id"] == str(local_user_id)
    assert client.admin_send_invitation("person@example.test").id == provider_user_id
    verified = client.verify_email_action("a" * 64, "invite")
    assert verified.user_id == provider_user_id
    assert seen[0].headers["apikey"] == "sb_secret_test"
    assert "authorization" not in seen[0].headers
    assert seen[1].headers["apikey"] == "sb_secret_test"
    assert seen[2].headers["apikey"] == "sb_publishable_test"
    assert seen[0].read().find(str(local_user_id).encode()) >= 0
    assert seen[2].read().find(b'"type":"invite"') >= 0


def test_recovery_and_password_update_use_provider_user_session() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient

    provider_user_id = uuid4()
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/auth/v1/recover":
            return httpx.Response(200, json={})
        if request.url.path == "/auth/v1/user":
            return httpx.Response(200, json={"id": str(provider_user_id)})
        return httpx.Response(404)

    client = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))
    client.request_recovery("person@example.test")
    changed = client.update_password("verified-access", "new password")
    assert changed.id == provider_user_id
    assert seen[0].headers["apikey"] == "sb_publishable_test"
    assert seen[1].headers["authorization"] == "Bearer verified-access"
    assert b"new password" in seen[1].read()


def test_admin_reconciliation_filters_exact_email_and_operation_marker() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient

    local_user_id, operation_id, provider_user_id = uuid4(), uuid4(), uuid4()
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "users": [
                    {
                        "id": str(uuid4()),
                        "email": "other@example.test",
                        "app_metadata": {
                            "openslate_user_id": str(local_user_id),
                            "openslate_invitation_operation_id": str(operation_id),
                        },
                    },
                    {
                        "id": str(provider_user_id),
                        "email": "person@example.test",
                        "app_metadata": {
                            "openslate_user_id": str(local_user_id),
                            "openslate_invitation_operation_id": str(operation_id),
                        },
                    },
                ]
            },
        )

    client = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))
    matched = client.find_invitation_user("person@example.test", local_user_id, operation_id)
    assert matched is not None and matched.id == provider_user_id
    assert seen[0].url.params["filter"] == "person@example.test"
    assert seen[0].headers["apikey"] == "sb_secret_test"


def test_admin_user_404_is_distinct_from_other_provider_failures() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable

    provider_id = uuid4()
    missing = SupabaseAuthClient(
        _settings(), transport=httpx.MockTransport(lambda _: httpx.Response(404))
    )
    with pytest.raises(Exception) as absent:
        missing.get_admin_user(provider_id)
    assert type(absent.value).__name__ == "ProviderUserNotFound"

    for status in (401, 403, 422, 500):
        denied = SupabaseAuthClient(
            _settings(), transport=httpx.MockTransport(lambda _, s=status: httpx.Response(s))
        )
        with pytest.raises(SupabaseAuthUnavailable):
            denied.get_admin_user(provider_id)


def test_admin_delete_uses_exact_identity_and_requires_authoritative_result() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable

    provider_id = uuid4()
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    client = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))
    client.admin_delete_user(provider_id)
    assert seen[0].method == "DELETE"
    assert seen[0].url.path == f"/auth/v1/admin/users/{provider_id}"
    assert seen[0].headers["apikey"] == "sb_secret_test"

    for status in (401, 403, 422, 500):
        failed = SupabaseAuthClient(
            _settings(), transport=httpx.MockTransport(lambda _, s=status: httpx.Response(s))
        )
        with pytest.raises(SupabaseAuthUnavailable):
            failed.admin_delete_user(provider_id)
