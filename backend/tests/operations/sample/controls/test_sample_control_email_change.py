"""Offline D21 round trip through actual SampleClient endpoints and Mailpit parsing."""

import json
from dataclasses import replace

import httpx
import pytest

from operations.sample.client import SampleAuthenticationError, SampleWriteOutcomeUnknown
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.actions import execute_control_action, plan_controls
from operations.sample.phases.actions import SamplePhaseActionError
from operations.sample.population.invitations import InvitationMailbox
from operations.sample.verification.route_coverage import SEEDER_ROUTES
from tests.operations.sample.controls.test_sample_control_account import (
    PASSWORD,
    USER_ID,
    AccountServer,
    _setup,
)


class EmailServer(AccountServer):
    def __init__(self, email, **kwargs):
        super().__init__(email, **kwargs)
        self.original = email
        self.pending = None
        self.confirmed = set()
        self.mail_tokens = {}
        self.mfa_required = False
        self.uncertain_request = False
        self.fail_changed_read = False
        self.numeric_first = False
        self.requests_started = 0

    def handle(self, request):
        path = request.url.path
        if path == "/api/auth/email/complete":
            self.requests.append(request)
            assert "cookie" not in request.headers and "x-csrf-token" not in request.headers
            payload = json.loads(request.content)
            assert set(payload) == {"token_hash"}
            token = payload["token_hash"]
            assert token in self.mail_tokens and token not in self.confirmed
            self.confirmed.add(token)
            if len(self.confirmed) % 2:
                return self.response(body={
                    "authenticated": 0 if self.numeric_first else False,
                    "confirmation_required": True,
                })
            self.email = self.pending
            self.pending = None
            login = httpx.Request("POST", request.url.copy_with(path="/api/auth/login"),
                                 headers=request.headers,
                                 json={"email": self.email, "password": PASSWORD})
            response = super().handle(login)
            return self.response(body={"authenticated": True, "confirmation_required": False,
                "setup_required": False}, headers=[
                    (name, value) for name, value in response.headers.multi_items()
                    if name.lower() == "set-cookie"
                ])
        if path == "/api/auth/me/email":
            self.requests.append(request)
            assert self.session_id(request) in self.sessions
            assert request.headers["x-csrf-token"] == "fixture-csrf"
            body = json.loads(request.content)
            assert set(body) == {"email", "current_password"}
            assert body["current_password"] == PASSWORD and body["email"] != self.email
            self.requests_started += 1
            self.pending = body["email"]
            for recipient, symbol in ((self.email, "a"), (self.pending, "b")):
                token = (
                    symbol if self.requests_started == 1 else {"a": "c", "b": "d"}[symbol]
                ) * 56
                key = f"mail-{self.requests_started}-{symbol}"
                self.mail_tokens[token] = recipient
                self.rows.append({"ID": key, "To": [{"Address": recipient}]})
                self.details[key] = {"HTML": f'<a href="http://127.0.0.1:3000/auth/email-change'
                    f'#token_hash={token}&amp;type=email_change">Confirm</a>'}
            if self.uncertain_request:
                return self.response(
                    503, {"detail": "Email change application completion is incomplete"}
                )
            return self.response(body={"confirmation_required": True})
        if path == "/api/auth/mfa":
            self.requests.append(request)
            return self.response(body={"user_id": USER_ID, "required": self.mfa_required,
                "policy_required": self.mfa_required, "factors": []})
        if path == "/api/auth/me":
            self.requests.append(request)
            if self.fail_changed_read and self.email != self.original:
                self.fail_changed_read = False
                return self.response(200, {"id": USER_ID, "role": "member", "status": "disabled",
                    "email": self.email})
            return self.response(body={"id": USER_ID, "role": "member", "status": "active",
                "email": self.email, "is_deleted": False})
        if path.startswith("/api/users/"):
            assert path == f"/api/users/{USER_ID}" and request.method == "GET"
            return self.response(body={"id": USER_ID, "email": self.email,
                "role": "member", "status": "active", "is_deleted": False})
        assert "/audit" not in path and "/security-events" not in path
        return super().handle(request)


def _email_setup(tmp_path, monkeypatch):
    dataset, _, context, primary, server = _setup(tmp_path, monkeypatch, server_type=EmailServer)
    candidates = [
        a for a in plan_controls(dataset) if a.values.get("operation") == "self_email_change"
    ]
    assert len(candidates) == 1, "D21 has no executable email-change plan"
    return dataset, candidates[0], context, primary, server


def test_email_plan_and_transport_restore_original_identity_without_private_receipts(
    tmp_path, monkeypatch
):
    dataset, action, context, primary, server = _email_setup(tmp_path, monkeypatch)
    try:
        assert action.actor_key == action.target_key == plan_account_controls(dataset)[0].actor_key
        result = execute_control_action(action, dataset, context)
        assert result["original_email_restored"] is True
        assert result["primary_session_authenticated"] is True
        assert server.email == server.original and server.pending is None
        assert primary.request("GET", "/api/auth/me").json()["id"] == USER_ID
        actual = {(r.method, r.url.path) for r in server.requests}
        required = {("POST", "/api/auth/me/email"), ("POST", "/api/auth/email/complete")}
        assert required <= actual and required <= SEEDER_ROUTES
        confirmations = [r for r in server.requests if r.url.path == "/api/auth/email/complete"]
        assert len(confirmations) == 4 and server.requests_started == 2
        receipts = json.dumps(result) + (tmp_path / "requests.jsonl").read_text()
        for secret in (PASSWORD, server.original, *(token for token in server.mail_tokens)):
            assert secret not in receipts
        assert not any("audit" in key for row in result["request_evidence"] for key in row)
    finally:
        primary.close()


@pytest.mark.parametrize("fault", ["foreign_email", "forced_mfa", "admin_actor"])
def test_email_control_refuses_unsafe_actor_before_any_email_write(tmp_path, monkeypatch, fault):
    dataset, action, context, primary, server = _email_setup(tmp_path, monkeypatch)
    if fault == "foreign_email":
        server.email = "authored-other@example.test"
    elif fault == "forced_mfa":
        server.mfa_required = True
    else:
        action = replace(action, actor_key="admin", target_key="admin")
    try:
        with pytest.raises(SamplePhaseActionError):
            execute_control_action(action, dataset, context)
        assert server.requests_started == 0
    finally:
        primary.close()


def test_uncertain_email_request_is_not_replayed_or_reported_restored(tmp_path, monkeypatch):
    dataset, action, context, primary, server = _email_setup(tmp_path, monkeypatch)
    server.uncertain_request = True
    try:
        with pytest.raises(SampleWriteOutcomeUnknown):
            execute_control_action(action, dataset, context)
        assert server.requests_started == 1 and not server.confirmed
    finally:
        primary.close()


def test_failure_after_confirmed_change_still_restores_original_email(tmp_path, monkeypatch):
    dataset, action, context, primary, server = _email_setup(tmp_path, monkeypatch)
    server.fail_changed_read = True
    try:
        with pytest.raises(SamplePhaseActionError):
            execute_control_action(action, dataset, context)
        assert server.email == server.original and server.pending is None
        assert server.requests_started == 2
    finally:
        primary.close()


def test_malformed_first_confirmation_stops_before_second_hash_or_restoration(
    tmp_path, monkeypatch
):
    dataset, action, context, primary, server = _email_setup(tmp_path, monkeypatch)
    server.numeric_first = True
    try:
        with pytest.raises(SamplePhaseActionError):
            execute_control_action(action, dataset, context)
        assert len(server.confirmed) == 1 and server.requests_started == 1
        assert server.email == server.original
    finally:
        primary.close()


@pytest.mark.parametrize("fault", ["missing_request", "numeric_confirmation"])
def test_email_receipt_verification_requires_actual_roundtrip_and_restored_readback(
    tmp_path, monkeypatch, fault
):
    dataset, action, context, primary, server = _email_setup(tmp_path, monkeypatch)
    try:
        result = execute_control_action(action, dataset, context)
        from operations.sample.controls.email_change_verification import (
            verify_email_change_controls,
        )

        manifest = {"actor_ids": context.user_ids, "control_results": [result]}
        counts, issues = verify_email_change_controls(
            primary, dataset, manifest, context.user_ids["admin"]
        )
        assert not issues and counts["email_change_controls"] == 1
        if fault == "missing_request":
            result["request_evidence"] = result["request_evidence"][:-1]
        else:
            result["confirmation_results"][0]["authenticated"] = 0
        _, issues = verify_email_change_controls(
            primary, dataset, manifest, context.user_ids["admin"]
        )
        assert issues
    finally:
        primary.close()


def test_sample_email_completion_is_cookie_free_and_does_not_log_the_hash(tmp_path):
    from operations.sample.client import SampleClient

    seen = []

    def handler(request):
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200, json={}, headers={"Set-Cookie": "openslate_access=private; Path=/"}
            )
        assert request.url.path == "/api/auth/email/complete"
        assert "cookie" not in request.headers and "x-csrf-token" not in request.headers
        assert json.loads(request.content) == {"token_hash": "a" * 56}
        return httpx.Response(200, json={"authenticated": False, "confirmation_required": True})

    with SampleClient("http://api.example.test", "http://127.0.0.1:3000", tmp_path / "journal",
                      transport=httpx.MockTransport(handler)) as client:
        assert callable(getattr(client, "complete_email_change", None)), "completion is absent"
        client.complete_email_change("a" * 56)
        client.login("owned@example.test", PASSWORD)
        with pytest.raises(SampleAuthenticationError, match="cookie-free"):
            client.complete_email_change("a" * 56)
    assert len(seen) == 2
    assert "a" * 56 not in (tmp_path / "journal").read_text()


def test_mailbox_selects_distinct_new_email_tokens_for_each_recipient(tmp_path, monkeypatch):
    _, _, _, primary, server = _setup(tmp_path, monkeypatch, server_type=EmailServer)
    try:
        with InvitationMailbox("http://127.0.0.1:8025", "http://127.0.0.1:3000") as mailbox:
            baseline = mailbox.snapshot()
            for recipient, symbol in ((server.email, "a"), ("new@example.test", "b")):
                key = f"mail-{symbol}"
                server.rows.append({"ID": key, "To": [{"Address": recipient}]})
                server.details[key] = {"HTML": f'<a href="http://127.0.0.1:3000/auth/email-change'
                    f'#token_hash={symbol * 56}&amp;type=email_change">Confirm</a>'}
            assert callable(getattr(mailbox, "email_change_token", None)), "parser is absent"
            assert mailbox.email_change_token(baseline, server.email) == "a" * 56
            assert mailbox.email_change_token(baseline, "new@example.test") == "b" * 56
    finally:
        primary.close()
