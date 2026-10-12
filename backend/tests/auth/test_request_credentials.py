"""Credential transport rules of the local identity routes, over generated headers.

``bearer_credentials`` reads only an ``Authorization: Bearer <token>`` header, and
``reject_mixed_credentials`` refuses a request that carries an Authorization header together
with a browser session cookie (webapp-security-review rule 12). The literal rows stay as
examples; the route-level owners are ``test_local_identity.py`` and
``test_auth_recovery_contracts.py``.
"""

import pytest
from fastapi import HTTPException
from hypothesis import example, given
from hypothesis import strategies as st
from starlette.requests import Request

from app.systems.access.auth.request_security import bearer_credentials, reject_mixed_credentials
from tests.property_support import PROPERTY

# Header text a client can send: printable ASCII, spaces included.
HEADER_TEXT = st.text(alphabet=st.characters(min_codepoint=32, max_codepoint=126), max_size=40)
SCHEME = st.text(alphabet=st.characters(min_codepoint=33, max_codepoint=126), max_size=12)
# Any upper/lower-case spelling of "bearer".
BEARER = st.tuples(*(st.sampled_from((char, char.upper())) for char in "bearer")).map("".join)
COOKIE_VALUE = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.",
    min_size=1,
    max_size=24,
)


def _request(*, authorization: str | None = None, cookies: dict[str, str] | None = None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if authorization is not None:
        headers.append((b"authorization", authorization.encode("latin-1")))
    if cookies:
        cookie = "; ".join(f"{name}={value}" for name, value in cookies.items())
        headers.append((b"cookie", cookie.encode("latin-1")))
    return Request({"type": "http", "method": "GET", "path": "/api/auth/me", "headers": headers})


@PROPERTY
@given(scheme=BEARER, token=HEADER_TEXT.filter(bool))
@example(scheme="Bearer", token="access-token")
@example(scheme="bearer", token="a b")
def test_a_bearer_header_yields_exactly_its_token(scheme: str, token: str) -> None:
    credentials = bearer_credentials(_request(authorization=f"{scheme} {token}"))
    assert credentials is not None
    assert (credentials.scheme, credentials.credentials) == ("Bearer", token)


@PROPERTY
@given(scheme=SCHEME.filter(lambda value: value.lower() != "bearer"), token=HEADER_TEXT)
@example(scheme="Basic", token="credentials")
@example(scheme="not-a-bearer", token="")
def test_any_other_scheme_yields_no_bearer_token(scheme: str, token: str) -> None:
    assert bearer_credentials(_request(authorization=f"{scheme} {token}")) is None


@pytest.mark.parametrize("header", [None, "", "Bearer", "Bearer "])
def test_a_missing_or_empty_bearer_token_yields_none(header: str | None) -> None:
    assert bearer_credentials(_request(authorization=header)) is None


@PROPERTY
@given(
    authorization=HEADER_TEXT.filter(bool),
    cookie=st.sampled_from(("openslate_access", "openslate_refresh")),
    value=COOKIE_VALUE,
)
@example(authorization="Bearer token", cookie="openslate_refresh", value="refresh")
@example(authorization="Basic credentials", cookie="openslate_access", value="access")
def test_an_authorization_header_with_a_session_cookie_is_refused(
    authorization: str, cookie: str, value: str
) -> None:
    with pytest.raises(HTTPException) as refused:
        reject_mixed_credentials(_request(authorization=authorization, cookies={cookie: value}))
    assert refused.value.status_code == 401
    assert refused.value.detail == "Invalid authentication credentials"


@PROPERTY
@given(
    cookies=st.dictionaries(
        st.sampled_from(("openslate_access", "openslate_refresh", "openslate_csrf")),
        COOKIE_VALUE,
    ),
    authorization=st.sampled_from((None, "")),
)
def test_session_cookies_alone_are_not_mixed_credentials(
    cookies: dict[str, str], authorization: str | None
) -> None:
    assert reject_mixed_credentials(_request(authorization=authorization, cookies=cookies)) is None


@PROPERTY
@given(authorization=HEADER_TEXT.filter(bool), value=COOKIE_VALUE)
def test_an_authorization_header_with_only_the_csrf_cookie_is_not_mixed(
    authorization: str, value: str
) -> None:
    request = _request(authorization=authorization, cookies={"openslate_csrf": value})
    assert reject_mixed_credentials(request) is None
