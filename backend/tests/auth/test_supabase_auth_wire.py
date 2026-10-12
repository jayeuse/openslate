"""The Supabase Auth wire protocol of ``SupabaseAuthClient``, over a recording transport.

Each action must send the pinned GoTrue request (method, path, query, JSON body, key and
bearer), map provider statuses to an explicit denial or an outage, and parse provider
users and sessions fail-closed. ``test_supabase_auth_actions.py`` owns the multi-step
action flows; this file owns the request shapes and the status and payload tables.
"""

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderUser,
    ProviderUserNotFound,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from tests.auth.provider_jwt_support import provider_settings

USER_ID = UUID("0192f0c1-0000-7000-8000-000000000001")
LOCAL_ID = UUID("0192f0c1-0000-7000-8000-000000000002")
OPERATION_ID = UUID("0192f0c1-0000-7000-8000-000000000003")
FACTOR_ID = UUID("0192f0c1-0000-7000-8000-000000000004")
OTHER_ID = UUID("0192f0c1-0000-7000-8000-000000000005")
EMAIL = "person@example.test"
SESSION = {
    "access_token": "provider-access",
    "refresh_token": "provider-refresh",
    "expires_in": 3600,
    "user": {"id": str(USER_ID)},
}
USER = {"id": str(USER_ID)}
MARKERS = {
    "openslate_user_id": str(LOCAL_ID),
    "openslate_invitation_operation_id": str(OPERATION_ID),
}
PUBLISHABLE, SECRET = "sb_publishable_test", "sb_secret_test"
TIMEOUT = {"connect": 2.0, "read": 2.0, "write": 2.0, "pool": 2.0}

Action = Callable[[SupabaseAuthClient], object]


def _client(
    status: int, body: object = None, seen: list[httpx.Request] | None = None
) -> SupabaseAuthClient:
    def respond(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return httpx.Response(status, json=body)

    return SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))


def _wire(request: httpx.Request) -> tuple[Any, ...]:
    body = json.loads(request.content) if request.content else None
    return (
        request.method,
        request.url.path,
        dict(request.url.params),
        body,
        request.headers["apikey"],
        request.headers.get("authorization"),
    )


PINNED: list[tuple[str, Action, int, object, tuple[Any, ...]]] = [
    (
        "password grant",
        lambda c: c.password_grant(EMAIL, "secret words"),
        200,
        SESSION,
        (
            "POST",
            "/auth/v1/token",
            {"grant_type": "password"},
            {"email": EMAIL, "password": "secret words"},
            PUBLISHABLE,
            None,
        ),
    ),
    (
        "refresh grant",
        lambda c: c.refresh("provider-refresh"),
        200,
        SESSION,
        (
            "POST",
            "/auth/v1/token",
            {"grant_type": "refresh_token"},
            {"refresh_token": "provider-refresh"},
            PUBLISHABLE,
            None,
        ),
    ),
    (
        "invitation user",
        lambda c: c.admin_create_invitation_user(EMAIL, LOCAL_ID, OPERATION_ID),
        200,
        USER,
        (
            "POST",
            "/auth/v1/admin/users",
            {},
            {"email": EMAIL, "app_metadata": MARKERS},
            SECRET,
            None,
        ),
    ),
    (
        "invitation email",
        lambda c: c.admin_send_invitation(EMAIL),
        200,
        USER,
        ("POST", "/auth/v1/invite", {}, {"email": EMAIL}, SECRET, None),
    ),
    (
        "recovery action",
        lambda c: c.verify_email_action("h" * 64, "recovery"),
        200,
        SESSION,
        (
            "POST",
            "/auth/v1/verify",
            {},
            {"token_hash": "h" * 64, "type": "recovery"},
            PUBLISHABLE,
            None,
        ),
    ),
    (
        "recovery email",
        lambda c: c.request_recovery(EMAIL),
        200,
        {},
        ("POST", "/auth/v1/recover", {}, {"email": EMAIL}, PUBLISHABLE, None),
    ),
    (
        "password update",
        lambda c: c.update_password("user-access", "new secret words"),
        200,
        USER,
        (
            "PUT",
            "/auth/v1/user",
            {},
            {"password": "new secret words"},
            PUBLISHABLE,
            "Bearer user-access",
        ),
    ),
    (
        "user read",
        lambda c: c.get_user("user-access"),
        200,
        USER,
        ("GET", "/auth/v1/user", {}, None, PUBLISHABLE, "Bearer user-access"),
    ),
    (
        "admin user read",
        lambda c: c.get_admin_user(USER_ID),
        200,
        USER,
        ("GET", f"/auth/v1/admin/users/{USER_ID}", {}, None, SECRET, None),
    ),
    (
        "admin user delete",
        lambda c: c.admin_delete_user(USER_ID),
        204,
        None,
        ("DELETE", f"/auth/v1/admin/users/{USER_ID}", {}, None, SECRET, None),
    ),
    (
        "local sign-out by default",
        lambda c: c.sign_out("user-access"),
        204,
        None,
        (
            "POST",
            "/auth/v1/logout",
            {"scope": "local"},
            None,
            PUBLISHABLE,
            "Bearer user-access",
        ),
    ),
    (
        "global sign-out",
        lambda c: c.sign_out("user-access", scope="global"),
        204,
        None,
        (
            "POST",
            "/auth/v1/logout",
            {"scope": "global"},
            None,
            PUBLISHABLE,
            "Bearer user-access",
        ),
    ),
    (
        "invitation search",
        lambda c: c.find_invitation_user(EMAIL, LOCAL_ID, OPERATION_ID),
        200,
        {"users": []},
        (
            "GET",
            "/auth/v1/admin/users",
            {"filter": EMAIL, "page": "1", "per_page": "200"},
            None,
            SECRET,
            None,
        ),
    ),
]


@pytest.mark.parametrize(
    ("action", "status", "body", "expected"),
    [row[1:] for row in PINNED],
    ids=[row[0] for row in PINNED],
)
def test_each_action_sends_the_pinned_request_with_the_configured_timeout(
    action: Action, status: int, body: object, expected: tuple[Any, ...]
) -> None:
    seen: list[httpx.Request] = []
    action(_client(status, body, seen))

    assert [_wire(request) for request in seen] == [expected]
    assert seen[0].extensions["timeout"] == TIMEOUT


DENIED, OUTAGE, ABSENT = InvalidProviderCredentials, SupabaseAuthUnavailable, ProviderUserNotFound


def grant(c: SupabaseAuthClient) -> object:
    return c.password_grant(EMAIL, "secret words")


def email_action(c: SupabaseAuthClient) -> object:
    return c.verify_email_action("h" * 64, "invite")


def password_update(c: SupabaseAuthClient) -> object:
    return c.update_password("user-access", "new secret words")


def user_read(c: SupabaseAuthClient) -> object:
    return c.get_user("user-access")


def invitation_user(c: SupabaseAuthClient) -> object:
    return c.admin_create_invitation_user(EMAIL, LOCAL_ID, OPERATION_ID)


def invitation_email(c: SupabaseAuthClient) -> object:
    return c.admin_send_invitation(EMAIL)


def admin_delete(c: SupabaseAuthClient) -> object:
    return c.admin_delete_user(USER_ID)


def sign_out(c: SupabaseAuthClient) -> object:
    return c.sign_out("user-access")


REFUSALS: list[tuple[str, Action, int, type[Exception]]] = [
    ("token grant 400", grant, 400, DENIED),
    ("token grant 401", grant, 401, DENIED),
    ("token grant 403", grant, 403, DENIED),
    ("token grant 422", grant, 422, DENIED),
    ("token grant 404", grant, 404, OUTAGE),
    ("email action 400", email_action, 400, DENIED),
    ("email action 401", email_action, 401, DENIED),
    ("email action 403", email_action, 403, DENIED),
    ("email action 422", email_action, 422, DENIED),
    ("email action 404", email_action, 404, OUTAGE),
    ("password update 400", password_update, 400, DENIED),
    ("password update 401", password_update, 401, DENIED),
    ("password update 403", password_update, 403, DENIED),
    ("password update 422", password_update, 422, DENIED),
    ("password update 404", password_update, 404, OUTAGE),
    ("user read 400", user_read, 400, DENIED),
    ("user read 401", user_read, 401, DENIED),
    ("user read 403", user_read, 403, DENIED),
    ("user read 404", user_read, 404, DENIED),
    ("user read 422", user_read, 422, OUTAGE),
    ("invitation user 400", invitation_user, 400, DENIED),
    ("invitation user 409", invitation_user, 409, DENIED),
    ("invitation user 422", invitation_user, 422, DENIED),
    ("invitation user 401", invitation_user, 401, OUTAGE),
    ("invitation email 400", invitation_email, 400, DENIED),
    ("invitation email 409", invitation_email, 409, DENIED),
    ("invitation email 422", invitation_email, 422, DENIED),
    ("invitation email 401", invitation_email, 401, OUTAGE),
    ("admin user delete 404", admin_delete, 404, ABSENT),
    ("admin user delete 500", admin_delete, 500, OUTAGE),
    ("sign-out 400", sign_out, 400, DENIED),
    ("sign-out 401", sign_out, 401, DENIED),
    ("sign-out 403", sign_out, 403, DENIED),
    ("sign-out 404", sign_out, 404, OUTAGE),
]


@pytest.mark.parametrize(
    ("action", "status", "expected"),
    [row[1:] for row in REFUSALS],
    ids=[row[0] for row in REFUSALS],
)
def test_provider_status_maps_to_one_exact_denial_absence_or_outage(
    action: Action, status: int, expected: type[Exception]
) -> None:
    with pytest.raises(expected) as caught:
        action(_client(status, {"error": "provider detail"}))
    assert type(caught.value) is expected


@pytest.mark.parametrize("status", [200, 204])
@pytest.mark.parametrize(
    "action",
    [admin_delete, sign_out],
    ids=["admin user delete", "sign-out"],
)
def test_both_success_statuses_complete_a_delete_or_sign_out(action: Action, status: int) -> None:
    assert action(_client(status)) is None


def test_a_provider_user_carries_its_ban_and_may_be_nested() -> None:
    banned = _client(200, {"user": {"id": str(USER_ID), "banned_until": "2999-01-01T00:00:00Z"}})
    user = banned.get_admin_user(USER_ID)

    assert user.id == USER_ID
    assert user.banned_until == datetime(2999, 1, 1, tzinfo=UTC)
    assert user.is_eligible() is False


@pytest.mark.parametrize(
    "payload",
    [
        {"id": str(USER_ID), "banned_until": 123},
        {"id": str(USER_ID), "email_confirmed_at": 123},
        {
            "id": str(USER_ID),
            "factors": [
                {"id": str(FACTOR_ID), "factor_type": "totp", "status": "verified"},
                {"id": str(FACTOR_ID), "factor_type": "totp", "status": "unverified"},
            ],
        },
    ],
    ids=["non-text ban", "non-text confirmation", "duplicate factor"],
)
def test_a_malformed_provider_user_is_an_outage(payload: dict) -> None:
    with pytest.raises(SupabaseAuthUnavailable):
        _client(200, payload).get_admin_user(USER_ID)


@pytest.mark.parametrize(
    ("banned_until", "now", "eligible"),
    [
        (datetime(2999, 1, 1, tzinfo=UTC), datetime(2999, 1, 1, tzinfo=UTC), True),
        (datetime(2999, 1, 1, tzinfo=UTC), datetime(3000, 1, 1, tzinfo=UTC), True),
        (datetime(2999, 1, 1, tzinfo=UTC), None, False),
        (datetime(2000, 1, 1, tzinfo=UTC), None, True),
    ],
    ids=["ban ends now", "ban ended at the given time", "ban in force", "ban ended"],
)
def test_a_ban_ends_at_its_instant(
    banned_until: datetime, now: datetime | None, eligible: bool
) -> None:
    assert ProviderUser(USER_ID, banned_until).is_eligible(now=now) is eligible


def test_a_provider_session_of_one_second_is_admitted() -> None:
    assert _client(200, {**SESSION, "expires_in": 1}).password_grant(EMAIL, "pw").expires_in == 1


@pytest.mark.parametrize(
    "changes",
    [{"expires_in": 0}, {"access_token": ""}],
    ids=["zero lifetime", "empty access token"],
)
def test_a_malformed_provider_session_is_an_outage(changes: dict) -> None:
    with pytest.raises(SupabaseAuthUnavailable):
        _client(200, {**SESSION, **changes}).password_grant(EMAIL, "pw")


def _marked(user_id: UUID) -> dict:
    return {"id": str(user_id), "email": EMAIL, "app_metadata": MARKERS}


def _unmarked(count: int) -> list[dict]:
    return [{"id": str(UUID(int=n + 1)), "email": f"other{n}@example.test"} for n in range(count)]


def _search(pages: dict[str, object], seen: list[str]) -> SupabaseAuthClient:
    def respond(request: httpx.Request) -> httpx.Response:
        page = request.url.params["page"]
        seen.append(page)
        return httpx.Response(200, json=pages.get(page, {"users": _unmarked(200)}))

    return SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))


def test_the_invitation_search_reads_the_next_page_after_a_full_one() -> None:
    seen: list[str] = []
    pages = {"1": {"users": _unmarked(200)}, "2": {"users": [_marked(USER_ID)]}}

    found = _search(pages, seen).find_invitation_user(EMAIL, LOCAL_ID, OPERATION_ID)

    assert found is not None and found.id == USER_ID
    assert seen == ["1", "2"]


def test_the_invitation_search_stops_after_50_full_pages() -> None:
    seen: list[str] = []

    with pytest.raises(SupabaseAuthUnavailable):
        _search({}, seen).find_invitation_user(EMAIL, LOCAL_ID, OPERATION_ID)
    assert (len(seen), seen[0], seen[-1]) == (50, "1", "50")


@pytest.mark.parametrize(
    "page",
    [{}, {"users": _unmarked(201)}, {"users": [_marked(USER_ID), _marked(OTHER_ID)]}],
    ids=["no user list", "page over 200", "two marked users"],
)
def test_an_invalid_or_ambiguous_invitation_search_is_an_outage(page: dict) -> None:
    with pytest.raises(SupabaseAuthUnavailable):
        # An empty page 2 ends the search, so only the page 1 refusal can raise.
        _search({"1": page, "2": {"users": []}}, []).find_invitation_user(
            EMAIL, LOCAL_ID, OPERATION_ID
        )


def test_the_same_marked_user_on_two_pages_is_one_match() -> None:
    pages = {
        "1": {"users": [*_unmarked(199), _marked(USER_ID)]},
        "2": {"users": [_marked(USER_ID)]},
    }

    found = _search(pages, []).find_invitation_user(EMAIL, LOCAL_ID, OPERATION_ID)
    assert found is not None and found.id == USER_ID
