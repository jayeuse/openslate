from unittest.mock import MagicMock, Mock
from uuid import UUID

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.integrations import supabase
from app.core.integrations.supabase import (
    InvalidationEvent,
    SupabaseAdminClient,
    SupabaseAdminError,
)

SECRET = "server-only-supabase-secret"
USER_ID = UUID("00000000-0000-0000-0000-000000000123")


def settings(*, redirect_url: str | None = "http://localhost:3000/auth/callback") -> Settings:
    return Settings(
        database_url="postgresql+psycopg://test:test@localhost/test",
        supabase_url="https://example.supabase.co/",
        supabase_secret_key=SecretStr(SECRET),
        supabase_auth_redirect_url=redirect_url,
    )


def http_client(monkeypatch: pytest.MonkeyPatch, response: Mock) -> tuple[Mock, Mock]:
    context = MagicMock()
    client = context.__enter__.return_value
    client.request.return_value = response
    monkeypatch.setattr(supabase.httpx, "Client", Mock(return_value=context))
    return context, client


def response_with_json(payload: object) -> Mock:
    response = Mock()
    response.json.return_value = payload
    return response


def test_client_requires_url_and_secret_configuration() -> None:
    with pytest.raises(SupabaseAdminError, match="not configured"):
        SupabaseAdminClient(
            settings=Settings(
                database_url="postgresql://localhost/test",
                _env_file=None,
            )
        )

    with pytest.raises(SupabaseAdminError, match="not configured"):
        SupabaseAdminClient(
            settings=Settings(
                database_url="postgresql://localhost/test",
                supabase_secret_key=SecretStr(SECRET),
                _env_file=None,
            )
        )


def test_invite_requires_a_redirect_url(monkeypatch: pytest.MonkeyPatch) -> None:
    http = Mock()
    monkeypatch.setattr(supabase.httpx, "Client", http)

    with pytest.raises(SupabaseAdminError, match="redirect is not configured"):
        SupabaseAdminClient(settings=settings(redirect_url=None)).invite_user(
            "person@example.com", "person"
        )
    http.assert_not_called()


def test_invite_sends_redirect_and_parses_nested_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = response_with_json({"user": {"id": str(USER_ID), "email": "returned@example.com"}})
    _, client = http_client(monkeypatch, response)

    result = SupabaseAdminClient(settings=settings()).invite_user("person@example.com", "person")

    assert result.id == USER_ID
    assert result.email == "returned@example.com"
    client.request.assert_called_once_with(
        "POST",
        "/auth/v1/invite",
        json={"email": "person@example.com", "data": {"username": "person"}},
        params={"redirect_to": "http://localhost:3000/auth/callback"},
    )


def test_invite_parses_flat_response_and_defaults_missing_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = response_with_json({"id": str(USER_ID)})
    http_client(monkeypatch, response)

    result = SupabaseAdminClient(settings=settings()).invite_user("person@example.com", "person")

    assert result == supabase.SupabaseAuthUser(USER_ID, "person@example.com")


def test_invite_rejects_an_invalid_auth_response(monkeypatch: pytest.MonkeyPatch) -> None:
    response = response_with_json({"user": {"id": "not-a-uuid"}})
    http_client(monkeypatch, response)

    with pytest.raises(SupabaseAdminError, match="invalid user"):
        SupabaseAdminClient(settings=settings()).invite_user("person@example.com", "person")


def test_resend_invitation_uses_the_auth_resend_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = response_with_json({})
    _, client = http_client(monkeypatch, response)

    SupabaseAdminClient(settings=settings()).resend_invitation("person@example.com")

    client.request.assert_called_once_with(
        "POST",
        "/auth/v1/resend",
        json={
            "type": "invite",
            "email": "person@example.com",
            "options": {"redirect_to": "http://localhost:3000/auth/callback"},
        },
        params=None,
    )


def test_resend_invitation_requires_a_redirect_url_before_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    http = Mock()
    monkeypatch.setattr(supabase.httpx, "Client", http)

    with pytest.raises(SupabaseAdminError, match="redirect is not configured"):
        SupabaseAdminClient(settings=settings(redirect_url=None)).resend_invitation(
            "person@example.com"
        )

    http.assert_not_called()


def test_status_errors_are_safe_and_preserve_status_code(monkeypatch: pytest.MonkeyPatch) -> None:
    response = Mock()
    request = httpx.Request("DELETE", "https://example.supabase.co/auth/v1/admin/users")
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "private upstream detail", request=request, response=httpx.Response(409, request=request)
    )
    _, client = http_client(monkeypatch, response)

    with pytest.raises(SupabaseAdminError) as error:
        SupabaseAdminClient(settings=settings()).delete_user(USER_ID)

    assert error.value.status_code == 409
    assert SECRET not in str(error.value)
    assert "private upstream detail" not in str(error.value)
    client.request.assert_called_once_with(
        "DELETE", f"/auth/v1/admin/users/{USER_ID}", json=None, params=None
    )


def test_network_errors_are_converted_without_secret_exposure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = MagicMock()
    context.__enter__.return_value.request.side_effect = httpx.ConnectError(SECRET)
    monkeypatch.setattr(supabase.httpx, "Client", Mock(return_value=context))

    with pytest.raises(SupabaseAdminError) as error:
        SupabaseAdminClient(settings=settings()).delete_user(USER_ID)

    assert str(error.value) == "Supabase Auth request failed"
    assert SECRET not in str(error.value)


def test_invalid_json_is_treated_as_an_empty_success_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = Mock()
    response.json.side_effect = ValueError("not JSON")
    http_client(monkeypatch, response)

    assert SupabaseAdminClient(settings=settings())._request("POST", "/test") == {}


@pytest.mark.parametrize(
    ("method_name", "method", "path", "payload"),
    [
        ("delete_user", "DELETE", f"/auth/v1/admin/users/{USER_ID}", None),
        (
            "disable_user",
            "PUT",
            f"/auth/v1/admin/users/{USER_ID}",
            {"ban_duration": "876000h"},
        ),
        (
            "enable_user",
            "PUT",
            f"/auth/v1/admin/users/{USER_ID}",
            {"ban_duration": "none"},
        ),
    ],
)
def test_admin_user_lifecycle_paths(
    monkeypatch: pytest.MonkeyPatch,
    method_name: str,
    method: str,
    path: str,
    payload: dict[str, str] | None,
) -> None:
    response = response_with_json({})
    _, client = http_client(monkeypatch, response)

    getattr(SupabaseAdminClient(settings=settings()), method_name)(USER_ID)

    client.request.assert_called_once_with(method, path, json=payload, params=None)


def test_broadcast_uses_the_exact_private_realtime_endpoint_and_opaque_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = Mock()
    response.raise_for_status.return_value = None
    context = MagicMock()
    client = context.__enter__.return_value
    client.post.return_value = response
    client_factory = Mock(return_value=context)
    monkeypatch.setattr(supabase.httpx, "Client", client_factory)
    event = InvalidationEvent(entity="records/items", entity_id=USER_ID)

    SupabaseAdminClient(settings=settings()).broadcast(event)

    client_factory.assert_called_once_with(
        base_url="https://example.supabase.co",
        headers={
            "apikey": SECRET,
            "Authorization": f"Bearer {SECRET}",
            "Content-Type": "application/json",
        },
        timeout=10.0,
    )
    client.post.assert_called_once_with(
        "/realtime/v1/api/broadcast/openslate%3Ainvalidation/events/invalidate",
        params={"private": "true"},
        json={"type": "records/items", "entity_id": str(USER_ID)},
    )


def test_broadcast_status_errors_are_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    request = httpx.Request("POST", "https://example.supabase.co/realtime")
    response = Mock()
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        SECRET, request=request, response=httpx.Response(500, request=request)
    )
    context = MagicMock()
    context.__enter__.return_value.post.return_value = response
    monkeypatch.setattr(supabase.httpx, "Client", Mock(return_value=context))

    with pytest.raises(SupabaseAdminError) as error:
        SupabaseAdminClient(settings=settings()).broadcast(InvalidationEvent("users"))

    assert str(error.value) == "Supabase Realtime request failed"
    assert SECRET not in str(error.value)
