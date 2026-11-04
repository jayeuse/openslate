"""S5-C5: FastAPI records the outcome of each email it asks Auth to send, and the answers
of those requests do not change (stack-free, over the real client wire)."""

from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from sqlalchemy.orm import Session

from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity import provider_actions
from app.systems.access.users.invitation_provider import send_invitation_email
from app.systems.manage.health import signals
from tests.auth.provider_jwt_support import provider_settings

USER_ID = UUID("0192f0c1-0000-7000-8000-000000000001")
EMAIL = "person@example.test"


def _client(status: int | None) -> SupabaseAuthClient:
    """Auth answers ``status``; ``None`` is a connection that never reaches it."""

    def respond(request: httpx.Request) -> httpx.Response:
        if status is None:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(status, json={"id": str(USER_ID)} if status == 200 else {})

    return SupabaseAuthClient(provider_settings(), transport=httpx.MockTransport(respond))


@pytest.fixture
def recorded(monkeypatch) -> list[str]:
    signals_written: list[str] = []
    monkeypatch.setattr(signals, "record_signal", signals_written.append)
    return signals_written


@pytest.mark.parametrize(
    ("status", "error", "kind", "signal"),
    [
        (200, None, None, ["email_accepted"]),
        (500, SupabaseAuthUnavailable, "http_500", ["email_failed"]),
        (503, SupabaseAuthUnavailable, "http_503", ["email_failed"]),
        (429, SupabaseAuthUnavailable, "http_429", ["email_failed"]),
        # Refusals that say nothing about delivery record nothing.
        (403, SupabaseAuthUnavailable, "http_403", []),
        (422, InvalidProviderCredentials, None, []),
        (None, SupabaseAuthUnavailable, "connect", []),
    ],
)
def test_s5_c5_i8_an_invitation_send_records_its_outcome_and_keeps_its_answer(
    recorded, status, error, kind, signal
):
    client = _client(status)

    if error is None:
        assert send_invitation_email(client, EMAIL).id == USER_ID
    else:
        with pytest.raises(error) as raised:
            send_invitation_email(client, EMAIL)
        assert getattr(raised.value, "kind", None) == kind

    assert recorded == signal


@pytest.mark.parametrize(
    ("status", "signal"),
    [
        # Auth answers 200 for unknown emails too, so a success proves nothing (J1 A).
        (200, []),
        (500, ["email_failed"]),
        (503, ["email_failed"]),
        # Anyone may ask: a 4xx refuses this request (an address Auth rejects, its
        # one-a-minute limit) and says nothing about whether email works.
        (429, []),
        (400, []),
        (None, []),
    ],
)
def test_s5_c5_i8_a_recovery_request_records_only_an_auth_server_failure(
    monkeypatch, recorded, status, signal
):
    monkeypatch.setattr(
        provider_actions.rate_limits, "recovery_request_permitted", Mock(return_value=True)
    )
    monkeypatch.setattr(
        provider_actions.audit_service, "append_committed_security_event", lambda payload: None
    )

    def request() -> None:
        provider_actions.request_recovery(
            Mock(spec=Session), EMAIL, _client(status), source=None, enforce_rate_limit=True
        )

    if status == 200:
        request()
    else:
        # The route keeps turning this into its existing 503.
        with pytest.raises(SupabaseAuthUnavailable) as raised:
            request()
        assert raised.value.kind == ("connect" if status is None else f"http_{status}")

    assert recorded == signal
