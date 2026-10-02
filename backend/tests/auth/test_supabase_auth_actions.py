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


def test_admin_factor_recovery_uses_pinned_array_and_deleted_factor_protocol() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient

    provider_id, factor_id = uuid4(), uuid4()
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": str(factor_id), "secret": "must-not-escape"}])
        return httpx.Response(200, json={"id": str(factor_id), "secret": "must-not-escape"})

    client = SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))
    assert client.admin_list_factors(provider_id) == [factor_id]
    assert client.admin_delete_factor(provider_id, factor_id) is None
    assert [(request.method, request.url.path) for request in seen] == [
        ("GET", f"/auth/v1/admin/users/{provider_id}/factors"),
        ("DELETE", f"/auth/v1/admin/users/{provider_id}/factors/{factor_id}"),
    ]
    assert all(request.headers["apikey"] == "sb_secret_test" for request in seen)
    assert all("authorization" not in request.headers for request in seen)


@pytest.mark.parametrize("payload", [{}, [{"id": "invalid"}], [{}, {}]])
def test_admin_factor_list_refuses_non_authoritative_payloads(payload: object) -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable

    client = SupabaseAuthClient(
        _settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    )
    with pytest.raises(SupabaseAuthUnavailable):
        client.admin_list_factors(uuid4())


def test_admin_factor_list_refuses_duplicate_ids() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable

    factor = {"id": str(uuid4())}
    client = SupabaseAuthClient(
        _settings(),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=[factor, factor])),
    )
    with pytest.raises(SupabaseAuthUnavailable):
        client.admin_list_factors(uuid4())


@pytest.mark.parametrize("status", [401, 403, 404, 500])
def test_admin_factor_recovery_refuses_provider_failure(status: int) -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable

    client = SupabaseAuthClient(
        _settings(), transport=httpx.MockTransport(lambda _: httpx.Response(status))
    )
    with pytest.raises(SupabaseAuthUnavailable):
        client.admin_list_factors(uuid4())
    with pytest.raises(SupabaseAuthUnavailable):
        client.admin_delete_factor(uuid4(), uuid4())


@pytest.mark.parametrize("payload", [{}, {"id": "invalid"}, {"id": str(uuid4())}])
def test_admin_factor_delete_requires_the_requested_factor(payload: object) -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable

    client = SupabaseAuthClient(
        _settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    )
    with pytest.raises(SupabaseAuthUnavailable):
        client.admin_delete_factor(uuid4(), uuid4())


@pytest.mark.parametrize(
    "factors",
    [
        None,
        {},
        [{"id": "bad", "factor_type": "totp", "status": "verified"}],
        [{"id": str(uuid4()), "factor_type": "totp", "status": "unknown"}],
    ],
)
def test_provider_user_refuses_malformed_present_factor_state(factors: object) -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable

    provider_id = uuid4()
    client = SupabaseAuthClient(
        _settings(),
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"id": str(provider_id), "factors": factors})
        ),
    )
    with pytest.raises(SupabaseAuthUnavailable):
        client.get_admin_user(provider_id)


def test_provider_user_exposes_only_immutable_minimal_factors() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient

    provider_id, factor_id = uuid4(), uuid4()
    payload = {
        "id": str(provider_id),
        "factors": [
            {
                "id": str(factor_id),
                "factor_type": "totp",
                "status": "verified",
                "secret": "must-not-escape",
            }
        ],
    }
    client = SupabaseAuthClient(
        _settings(), transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    )
    user = client.get_admin_user(provider_id)
    assert isinstance(user.factors, tuple)
    assert user.factors[0].id == factor_id
    assert user.factors[0].factor_type == "totp" and user.factors[0].status == "verified"
    assert "must-not-escape" not in repr(user)
    payload.pop("factors")
    assert client.get_admin_user(provider_id).factors == ()


def test_user_totp_protocol_enrolls_challenges_verifies_and_unenrolls() -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthClient
    from app.core.integrations.supabase_mfa import SupabaseMfaClient

    provider_id, factor_id, challenge_id = uuid4(), uuid4(), uuid4()
    seen = []

    def respond(request):
        seen.append(request)
        assert request.headers["apikey"] == "sb_publishable_test"
        assert request.headers["authorization"] == "Bearer user-access"
        if request.url.path == "/auth/v1/factors":
            return httpx.Response(
                200,
                json={
                    "id": str(factor_id),
                    "type": "totp",
                    "totp": {
                        "qr_code": "<svg/>",
                        "secret": "ephemeral-test-only",
                        "uri": "otpauth://totp/test",
                    },
                },
            )
        if request.url.path.endswith("/challenge"):
            return httpx.Response(
                200, json={"id": str(challenge_id), "type": "totp", "expires_at": 1}
            )
        if request.url.path.endswith("/verify"):
            return httpx.Response(
                200,
                json={
                    "access_token": "upgraded-access",
                    "refresh_token": "rotated-refresh",
                    "expires_in": 600,
                    "user": {"id": str(provider_id)},
                },
            )
        return httpx.Response(200, json={"id": str(factor_id)})

    client = SupabaseMfaClient(
        SupabaseAuthClient(_settings(), transport=httpx.MockTransport(respond))
    )
    enrolled = client.enroll_totp("user-access", friendly_name="Authenticator")
    assert enrolled.id == factor_id
    assert "ephemeral-test-only" not in repr(enrolled)
    tokens = client.challenge_and_verify("user-access", factor_id, "123456")
    assert tokens.user_id == provider_id
    client.unenroll("user-access", factor_id)
    import json

    assert json.loads(seen[0].read()) == {"factor_type": "totp", "friendly_name": "Authenticator"}
    assert json.loads(seen[2].read()) == {"challenge_id": str(challenge_id), "code": "123456"}
    assert [request.method for request in seen] == ["POST", "POST", "POST", "DELETE"]


@pytest.mark.parametrize(
    "status,exception",
    [
        (400, "InvalidProviderCredentials"),
        (401, "InvalidProviderCredentials"),
        (403, "InvalidProviderCredentials"),
        (404, "InvalidProviderCredentials"),
        (422, "InvalidProviderCredentials"),
        (500, "SupabaseAuthUnavailable"),
    ],
)
def test_user_totp_failure_keeps_provider_denial_distinct_from_outage(status, exception):
    from app.core.integrations.supabase_auth import SupabaseAuthClient
    from app.core.integrations.supabase_mfa import SupabaseMfaClient

    client = SupabaseMfaClient(
        SupabaseAuthClient(
            _settings(), transport=httpx.MockTransport(lambda _: httpx.Response(status))
        )
    )
    for action in (
        lambda: client.enroll_totp("user-access"),
        lambda: client.challenge_and_verify("user-access", uuid4(), "123456"),
        lambda: client.unenroll("user-access", uuid4()),
    ):
        with pytest.raises(Exception) as caught:
            action()
        assert type(caught.value).__name__ == exception


def test_user_totp_refuses_malformed_enrollment_challenge_and_unmatched_delete():
    from app.core.integrations.supabase_auth import SupabaseAuthClient, SupabaseAuthUnavailable
    from app.core.integrations.supabase_mfa import SupabaseMfaClient

    for payload in (
        {},
        {"id": "invalid", "type": "totp", "totp": {}},
        {"id": str(uuid4()), "type": "phone"},
    ):
        client = SupabaseMfaClient(
            SupabaseAuthClient(
                _settings(),
                transport=httpx.MockTransport(
                    lambda _, data=payload: httpx.Response(200, json=data)
                ),
            )
        )
        with pytest.raises(SupabaseAuthUnavailable):
            client.enroll_totp("user-access")
        with pytest.raises(SupabaseAuthUnavailable):
            client.challenge_and_verify("user-access", uuid4(), "123456")
        with pytest.raises(SupabaseAuthUnavailable):
            client.unenroll("user-access", uuid4())
