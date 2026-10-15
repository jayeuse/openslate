"""Pack-neutral account actions preserve primary credentials and never replay writes."""

import base64
import json
import time
from dataclasses import replace
from datetime import date
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.packs import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.population import invitations as sample_invitations
from operations.sample.population.people import SampleActorCredential
from operations.sample.scenario import build_dataset

ORIGIN = "http://127.0.0.1:3000"
PASSWORD = "original-fixture-password"
TOKEN = "a" * 56
USER_ID = "9ec0d287-ae14-4603-91c2-f9a4d7b73c0a"
ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
ORG_ID = "784ab345-b08c-46da-8646-5915c1a356a2"


@pytest.mark.parametrize("pack_key", ["harbor", "school"])
def test_account_planning_requires_active_non_admin_pack_person_without_pack_identity_checks(
    pack_key,
) -> None:
    from operations.sample.controls.account import plan_account_controls

    dataset = build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack_key)
    )
    plan = plan_account_controls(dataset)
    assert len(plan) == 1 and plan[0].kind == "account_controls"
    target = next(
        person for person in dataset.organization.actors.people if person.key == plan[0].actor_key
    )
    assert target.role == "member" and target.status == "active"
    # Changing a pack's label cannot change the data-driven choices.
    renamed = replace(
        dataset,
        organization=replace(
            dataset.organization,
            identity=replace(dataset.organization.identity, key="renamed-pack"),
        ),
    )
    assert plan_account_controls(renamed) == plan


class AccountServer:
    def __init__(self, email: str, *, uncertain_password: bool = False) -> None:
        self.email = email
        self.password = PASSWORD
        self.sessions: set[str] = set()
        self.rows = []
        self.details = {}
        self.requests = []
        self.uncertain_password = uncertain_password
        self.streams_closed = 0

    def access_token(self, session: str) -> str:
        return session

    def session_id(self, request):
        cookies = dict(
            part.split("=", 1)
            for part in request.headers.get("cookie", "").split("; ")
            if "=" in part
        )
        return cookies.get("openslate_access")

    def response(self, status=200, body=None, headers=()):
        return httpx.Response(
            status,
            json=body if status != 204 else None,
            headers=[("X-Request-ID", str(uuid4())), *headers],
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else {}
        assert request.headers["origin"] == ORIGIN
        if path == "/api/auth/login":
            if body != {"email": self.email, "password": self.password}:
                return self.response(401, {"authenticated": False})
            session = str(uuid4())
            self.sessions.add(session)
            return self.response(
                body={"authenticated": True, "setup_required": False},
                headers=[
                    (
                        "Set-Cookie",
                        f"openslate_access={self.access_token(session)}; Path=/; HttpOnly",
                    ),
                    ("Set-Cookie", "openslate_csrf=fixture-csrf; Path=/"),
                ],
            )
        session = self.session_id(request)
        if path == "/api/auth/session":
            return self.response(
                body={
                    "authenticated": session in self.sessions,
                    **(
                        {"user_id": USER_ID, "setup_required": False}
                        if session in self.sessions
                        else {}
                    ),
                }
            )
        if path == "/api/auth/recovery/complete":
            assert "cookie" not in request.headers and "x-csrf-token" not in request.headers
            assert body == {"token_hash": TOKEN, "password": PASSWORD}
            self.password = PASSWORD
            self.sessions.clear()
            return self.response(204)
        assert session in self.sessions
        if method != "GET":
            assert request.headers["x-csrf-token"] == "fixture-csrf"
        if path == "/api/auth/refresh":
            return self.response(body={"authenticated": True, "setup_required": False})
        if path == "/api/auth/me":
            return self.response(body={"id": USER_ID, "role": "member", "status": "active",
                                       "current_organization": {"org_id": ORG_ID}})
        if path == "/api/auth/session/organization":
            assert body == {"org_id": ORG_ID}
            return self.response(body={"id": USER_ID, "role": "member",
                                       "current_organization": {"org_id": ORG_ID}})
        if path == "/api/auth/sessions":
            return self.response(
                body=[{"id": item, "current": item == session} for item in sorted(self.sessions)]
            )
        if method == "DELETE" and path.startswith("/api/auth/sessions/"):
            ended = path.rsplit("/", 1)[-1]
            self.sessions.remove(ended)
            return self.response(
                204, headers=[("Set-Cookie", "openslate_access=; Max-Age=0; Path=/")]
            )
        if path == "/api/auth/sessions/revoke-others":
            self.sessions.intersection_update({session})
            return self.response(204)
        if path == "/api/auth/password/change":
            assert body["current_password"] == PASSWORD
            assert body["password"] != PASSWORD and 12 <= len(body["password"]) <= 128
            self.password = body["password"]
            self.sessions.intersection_update({session})
            if self.uncertain_password:
                return self.response(503, {"detail": "Password service unavailable"})
            return self.response(body={"authenticated": True, "setup_required": False})
        if path == "/api/auth/recovery/request":
            assert body == {"email": self.email}
            self.rows.append({"ID": "new", "To": [{"Address": self.email}]})
            self.details["new"] = {
                "HTML": (
                    f'<a href="{ORIGIN}/auth/recovery#token_hash={TOKEN}'
                    '&amp;type=recovery">Recover</a>'
                )
            }
            return self.response(204)
        if path == "/api/events":
            assert request.headers["sec-fetch-site"] == "same-origin"
            server = self

            class Stream(httpx.SyncByteStream):
                def __iter__(self):
                    yield b"event: resync\ndata: {}\n\n"
                    raise AssertionError("Probe must close after initial resync")

                def close(self):
                    server.streams_closed += 1

            return httpx.Response(
                200,
                stream=Stream(),
                headers={"Content-Type": "text/event-stream", "X-Request-ID": str(uuid4())},
            )
        raise AssertionError(f"Unexpected account fixture route: {method} {path}")

    def mail(self, request):
        if request.url.path == "/api/v1/messages":
            return httpx.Response(200, json={"messages": self.rows, "total": len(self.rows)})
        return httpx.Response(200, json=self.details[request.url.path.rsplit("/", 1)[-1]])


def _setup(tmp_path, monkeypatch, *, uncertain_password=False, server_type=AccountServer):
    from operations.sample.controls.account import plan_account_controls

    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 30))
    action = plan_account_controls(dataset)[0]
    person = next(
        person for person in dataset.organization.actors.people if person.key == action.actor_key
    )
    server = server_type(person.email, uncertain_password=uncertain_password)
    real_client = httpx.Client
    monkeypatch.setattr(
        sample_invitations.httpx,
        "Client",
        lambda **kwargs: real_client(
            **{**kwargs, "transport": kwargs.get("transport") or httpx.MockTransport(server.mail)}
        ),
    )

    def new_client():
        return SampleClient(
            "http://api.example.test",
            ORIGIN,
            tmp_path / "requests.jsonl",
            transport=httpx.MockTransport(server.handle),
        )

    primary = new_client()
    assert primary.login(person.email, PASSWORD).status_code == 200
    context = PhaseExecutionContext(
        clients={action.actor_key: primary},
        user_ids={action.actor_key: USER_ID, "admin": ADMIN_ID},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="not-rotated",
        private_values={
            "credentials": {
                action.actor_key: SampleActorCredential(USER_ID, person.email, PASSWORD)
            },
            "new_client": new_client,
            "mailpit_url": "http://127.0.0.1:8025",
            "origin": ORIGIN,
        },
    )
    return dataset, action, context, primary, server


def test_account_actions_restore_original_password_keep_primary_usable_and_emit_only_safe_evidence(
    tmp_path,
    monkeypatch,
) -> None:
    from operations.sample.controls.account import execute_account_control

    dataset, action, context, primary, server = _setup(tmp_path, monkeypatch)
    try:
        result = execute_account_control(action, dataset, context)
        assert result["original_password_restored"] is True
        assert result["primary_session_authenticated"] is True
        assert server.password == PASSWORD
        assert primary.request("GET", "/api/auth/me").json()["id"] == USER_ID
        assert server.streams_closed == 1
        paths = {(request.method, request.url.path) for request in server.requests}
        assert {
            ("GET", "/api/auth/session"),
            ("POST", "/api/auth/refresh"),
            ("POST", "/api/auth/session/organization"),
            ("POST", "/api/auth/password/change"),
            ("POST", "/api/auth/recovery/request"),
            ("POST", "/api/auth/recovery/complete"),
            ("GET", "/api/auth/sessions"),
            ("POST", "/api/auth/sessions/revoke-others"),
            ("GET", "/api/events"),
        } <= paths
        assert any(
            method == "DELETE" and path.startswith("/api/auth/sessions/") for method, path in paths
        )
        serialized = json.dumps(result) + (tmp_path / "requests.jsonl").read_text() + repr(context)
        changed = next(
            json.loads(request.content)["password"]
            for request in server.requests
            if request.url.path == "/api/auth/password/change"
        )
        for secret in (PASSWORD, TOKEN, changed, server.email, "not-rotated"):
            assert secret not in serialized
        assert all(row["request_id"] for row in result["request_evidence"])
    finally:
        primary.close()


def test_uncertain_password_change_stops_without_retry_or_recovery_mutation(
    tmp_path, monkeypatch
) -> None:
    from operations.sample.controls.account import execute_account_control

    dataset, action, context, primary, server = _setup(
        tmp_path, monkeypatch, uncertain_password=True
    )
    try:
        with pytest.raises(SampleWriteOutcomeUnknown):
            execute_account_control(action, dataset, context)
        assert (
            sum(request.url.path == "/api/auth/password/change" for request in server.requests) == 1
        )
        assert not any(
            request.url.path.startswith("/api/auth/recovery/") for request in server.requests
        )
    finally:
        primary.close()


def test_account_action_refuses_an_admin_target_before_transport(tmp_path, monkeypatch) -> None:
    from operations.sample.controls.account import execute_account_control

    dataset, action, context, primary, server = _setup(tmp_path, monkeypatch)
    invalid = replace(action, actor_key="admin", target_key="admin")
    before = len(server.requests)
    try:
        with pytest.raises(SamplePhaseActionError):
            execute_account_control(invalid, dataset, context)
        assert len(server.requests) == before
    finally:
        primary.close()


def test_account_verification_cannot_accept_missing_execution_evidence() -> None:
    from operations.sample.controls.account import verify_account_controls

    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 30))
    counts, issues = verify_account_controls(None, dataset, {}, ADMIN_ID)
    assert issues and counts.get("account_control_actions", 0) == 0


def test_account_verification_rejects_malformed_actor_manifest_without_crashing(
    tmp_path, monkeypatch
) -> None:
    from operations.sample.controls.account import execute_account_control, verify_account_controls

    dataset, action, context, primary, server = _setup(tmp_path, monkeypatch)
    try:
        result = execute_account_control(action, dataset, context)
        counts, issues = verify_account_controls(
            None, dataset, {"control_results": [result], "actor_ids": []}, ADMIN_ID
        )
        assert issues and counts["account_control_actions"] == 0
    finally:
        primary.close()


class ExpiringAccountServer(AccountServer):
    """Issues access tokens that expire, and refuses to refresh an ended session.

    Completing recovery moves the client clock to 10 seconds before the original
    token expires, inside the sample client's 20-second refresh window.
    """

    clock_offset = [0.0]
    expiries: list[int] = []

    def access_token(self, session: str) -> str:
        def part(value: dict[str, object]) -> str:
            encoded = base64.urlsafe_b64encode(json.dumps(value).encode()).decode()
            return encoded.rstrip("=")

        expiry = int(time.time()) + 3600
        self.expiries.append(expiry)
        return f"{part({'alg': 'none'})}.{part({'exp': expiry, 'sid': session})}.signature"

    def session_id(self, request):
        token = super().session_id(request)
        if not token:
            return None
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sid"]

    def handle(self, request: httpx.Request) -> httpx.Response:
        if (
            request.url.path == "/api/auth/refresh"
            and self.session_id(request) not in self.sessions
        ):
            self.requests.append(request)
            return self.response(401, {"detail": "Invalid authentication credentials"})
        response = super().handle(request)
        if request.url.path == "/api/auth/recovery/complete":
            self.clock_offset[0] += self.expiries[0] - 10 - time.time()
        return response


def test_the_recovery_probe_reads_the_ended_session_without_refreshing_it(
    tmp_path, monkeypatch
) -> None:
    # Review finding 6: the probe after recovery refreshed first when the token had
    # 20 seconds or less left; the refused refresh stopped the run before the check.
    from operations.sample.controls.account import execute_account_control

    real_time = time.time
    offset = ExpiringAccountServer.clock_offset
    offset[0] = 0.0
    ExpiringAccountServer.expiries.clear()
    monkeypatch.setattr(time, "time", lambda: real_time() + offset[0])
    dataset, action, context, primary, server = _setup(
        tmp_path, monkeypatch, server_type=ExpiringAccountServer
    )
    try:
        result = execute_account_control(action, dataset, context)
        assert offset[0] > 3000
        assert result["primary_session_authenticated"] is True
        recovered = [request.url.path for request in server.requests].index(
            "/api/auth/recovery/complete"
        )
        assert server.requests[recovered + 1].url.path == "/api/auth/session"
    finally:
        primary.close()
