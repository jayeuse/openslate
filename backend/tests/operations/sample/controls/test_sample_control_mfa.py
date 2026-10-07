"""MFA sample orchestration faults; real provider acceptance remains a separate boundary."""

import json
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from datetime import date
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.packs import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.population.people import SampleActorCredential
from operations.sample.scenario import build_dataset

ORIGIN = "http://127.0.0.1:3000"
PASSWORD = "owned-fixture-password"
SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
OWNER_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
OTP = "287082"  # RFC 6238 SHA1 at timestamp 59, reduced to six digits.


class MfaServer:
    def __init__(self, dataset, fault=None):
        from operations.sample.controls.mfa import plan_mfa_controls

        self.fault = fault
        self.requests = []
        # fmt: off
        self.users = {"admin": {"id": OWNER_ID, "email": "owner@example.test", "role": "admin",
                                "status": "active", "username": "owner"}}
        for person in dataset.organization.actors.people:
            self.users[person.key] = {"id": str(uuid4()), "email": person.email,
                                      "username": person.username, "role": person.role,
                                      "status": person.status}
        # fmt: on
        action = plan_mfa_controls(dataset)[0]
        self.selected = [action.actor_key, action.target_key]
        self.actor, self.target = (self.users[key]["id"] for key in self.selected)
        self.sessions = {}
        self.factors = {u["id"]: [] for u in self.users.values()}
        self.owner_factor = str(uuid4())
        self.factors[OWNER_ID] = [
            {"id": self.owner_factor, "factor_type": "totp", "status": "verified"}
        ]
        # fmt: off
        self.groups = {key: {"id": str(uuid4()), "revision": 1, "name": key,
                             "member_ids": [self.users[p.key]["id"]
                                            for p in dataset.organization.actors.people
                                            if key in p.groups], "access": []}
                       for key in dataset.organization.actors.group_access}
        # fmt: on
        self.events = []
        self.reset_receipt = None

    def response(self, body=None, status=200, headers=()):
        return httpx.Response(
            status,
            json=body if status != 204 else None,
            headers=[("X-Request-ID", str(uuid4())), ("Cache-Control", "no-store"), *headers],
        )

    def page(self, rows, request):
        limit, offset = (
            int(request.url.params.get(k, default))
            for k, default in (("limit", "100"), ("offset", "0"))
        )
        items = deepcopy(rows[offset : offset + limit])
        # fmt: off
        return self.response({"items": items, "pagination": {
            "limit": limit, "offset": offset, "count": len(items), "total": len(rows),
            "has_more": offset + len(items) < len(rows)}})
        # fmt: on

    def identity(self, request):
        cookies = dict(
            part.split("=", 1)
            for part in request.headers.get("cookie", "").split("; ")
            if "=" in part
        )
        access = cookies.get("openslate_access", "")
        session, _, aal = access.partition("|")
        return session, self.sessions.get(session), aal

    def event(self, request, response, operation, outcome, metadata):
        _, user_id, _ = self.identity(request)
        # fmt: off
        return {"id": str(uuid4()), "occurred_at": "2026-10-07T00:00:00Z",
                "event_type": "identity.mfa_reset", "source": "access.users", "outcome": outcome,
                "operation_id": operation, "actor_id": user_id, "subject_id": self.target,
                "labels": {}, "fingerprint": None, "reason": None,
                "request_id": response.headers["X-Request-ID"], "request_method": "POST",
                "request_path": request.url.path, "metadata": metadata}
        # fmt: on

    def handle(self, request):
        self.requests.append(request)
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else {}
        assert request.headers["origin"] == ORIGIN
        if path == "/api/auth/login":
            user = next(u for u in self.users.values() if u["email"] == body["email"])
            assert body["password"] == PASSWORD
            sid = str(uuid4())
            self.sessions[sid] = user["id"]
            return self.response(
                {"authenticated": True, "setup_required": False},
                headers=[
                    ("Set-Cookie", f"openslate_access={sid}|aal1; Path=/; HttpOnly"),
                    ("Set-Cookie", "openslate_csrf=private-fixture-csrf; Path=/"),
                ],
            )
        sid, user_id, aal = self.identity(request)
        if path == "/api/auth/session":
            return self.response(
                {
                    "authenticated": user_id is not None,
                    **({"user_id": user_id, "setup_required": False} if user_id else {}),
                }
            )
        if path == "/api/auth/refresh":
            return self.response({"authenticated": user_id is not None}, 200 if user_id else 401)
        assert user_id is not None, f"Unexpected unauthenticated request {method} {path}"
        if method != "GET":
            assert request.headers["x-csrf-token"] == "private-fixture-csrf"
        user = next(u for u in self.users.values() if u["id"] == user_id)
        if path == "/api/auth/me":
            return self.response(deepcopy(user))
        if path == "/api/auth/sessions":
            return self.response(
                [
                    {"id": s, "current": s == sid}
                    for s, uid in self.sessions.items()
                    if uid == user_id
                ]
            )
        if path == "/api/auth/mfa":
            level = "aal1" if self.fault == "no_aal2" and user_id == self.actor else aal
            # fmt: off
            return self.response({"user_id": user_id, "assurance_level": level, "required": False,
                                  "policy_required": False, "required_since": None,
                                  "enrollment_deadline": None,
                                  "factors": deepcopy(self.factors[user_id])})
            # fmt: on
        if path == "/api/auth/mfa/factors":
            assert method == "POST" and user_id != OWNER_ID
            factor = {"id": str(uuid4()), "factor_type": "totp", "status": "unverified"}
            self.factors[user_id].append(factor)
            return self.response(
                {
                    "id": factor["id"],
                    "totp": {"secret": SEED, "qr_code": "private-qr", "uri": "private-otpauth-uri"},
                },
                201,
            )
        if path.startswith("/api/auth/mfa/factors/"):
            factor_id = path.split("/")[5]
            factor = next(f for f in self.factors[user_id] if f["id"] == factor_id)
            if method == "POST":
                assert body == {"code": OTP}
                factor["status"] = "verified"
                return self.response(
                    {"verified": True, "access_token": None},
                    headers=[("Set-Cookie", f"openslate_access={sid}|aal2; Path=/; HttpOnly")],
                )
            assert method == "DELETE" and user_id != OWNER_ID
            if factor["status"] == "verified":
                assert aal == "aal2"
                if self.fault == "actor_cleanup":
                    return self.response(status=204)
                self.sessions = {s: uid for s, uid in self.sessions.items() if uid != user_id}
            self.factors[user_id].remove(factor)
            return self.response(status=204)
        if path == f"/api/users/{self.target}/mfa/reset":
            assert user_id == self.actor and user["role"] == "admin" and body == {}
            if aal == "aal1" and self.fault != "aal1_accept":
                if self.fault == "denial_mutates":
                    self.sessions = {
                        s: uid for s, uid in self.sessions.items() if uid != self.target
                    }
                return self.response({"detail": {"code": "security_aal2_required"}}, 403)
            count = sum(uid == self.target for uid in self.sessions.values())
            if self.fault != "target_factor_remains":
                self.factors[self.target] = []
            if self.fault != "target_session_remains":
                self.sessions = {s: uid for s, uid in self.sessions.items() if uid != self.target}
            operation = str(uuid4())
            self.reset_receipt = {
                "operation_id": operation,
                "user_id": self.target,
                "factors_cleared": True,
                "local_revocation": "committed",
                "revoked_sessions": count,
            }
            if self.fault == "receipt_count":
                self.reset_receipt["revoked_sessions"] = 0
            response = self.response(
                deepcopy(self.reset_receipt), 503 if self.fault == "unknown_reset" else 200
            )
            for outcome in ("attempt", "success"):
                metadata = {
                    "email_request": "not_attempted",
                    "local_revocation": "not_requested",
                    "revoked_sessions": 0,
                    "factors_cleared": None,
                }
                if outcome == "success":
                    metadata.update(
                        local_revocation="committed", revoked_sessions=count, factors_cleared=True
                    )
                self.events.append(self.event(request, response, operation, outcome, metadata))
            return response
        if path == "/api/security-events":
            return self.page(self.events, request)
        if path == "/api/access/groups":
            return self.page(list(self.groups.values()), request)
        if path.startswith("/api/access/groups/"):
            group = next(g for g in self.groups.values() if g["id"] == path.split("/")[4])
            if method == "PUT":
                assert request.headers["if-match"] == f'"{group["id"]}:{group["revision"]}"'
                assert user_id == OWNER_ID and self.actor in body["member_ids"]
                group["member_ids"] = body["member_ids"]
                group["revision"] += 1
            return self.response(
                deepcopy(group), headers=[("ETag", f'"{group["id"]}:{group["revision"]}"')]
            )
        if path.startswith("/api/users/"):
            target_id = path.split("/")[3]
            target = next(u for u in self.users.values() if u["id"] == target_id)
            if path.endswith("/security"):
                return self.response(
                    {
                        "user_id": target_id,
                        "target_eligible": True,
                        "smtp_configured": True,
                        "verified_factor_count": sum(
                            f["status"] == "verified" for f in self.factors[target_id]
                        ),
                    }
                )
            if path.endswith("/sessions"):
                return self.page(
                    [{"id": s} for s, uid in self.sessions.items() if uid == target_id], request
                )
            if method == "PATCH":
                assert user_id == OWNER_ID and target_id == self.actor
                target["role"] = body["role"]
                if body["role"] == "admin":
                    for group in self.groups.values():
                        if self.actor in group["member_ids"]:
                            group["member_ids"].remove(self.actor)
                            group["revision"] += 1
            return self.response(deepcopy(target))
        raise AssertionError(f"Unexpected MFA fixture route {method} {path}")


@pytest.fixture
def setup_mfa(tmp_path, monkeypatch):
    from operations.sample.controls import mfa

    monkeypatch.setattr(mfa, "time", lambda: 59)
    with ExitStack() as stack:

        def setup(pack="harbor", fault=None):
            dataset = build_dataset(
                "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack)
            )
            server = MfaServer(dataset, fault)

            def new_client():
                return SampleClient(
                    "http://api.example.test",
                    ORIGIN,
                    tmp_path / "requests.jsonl",
                    transport=httpx.MockTransport(server.handle),
                )

            clients = {}
            for key in ["admin", *server.selected]:
                client = stack.enter_context(new_client())
                assert client.login(server.users[key]["email"], PASSWORD).status_code == 200
                clients[key] = client
            context = PhaseExecutionContext(
                clients=clients,
                user_ids={key: u["id"] for key, u in server.users.items()},
                group_ids={key: g["id"] for key, g in server.groups.items()},
                department_ids={},
                module_ids={},
                field_ids={},
                mappings={},
                admin_password=PASSWORD,
                private_values={
                    "new_client": new_client,
                    "credentials": {
                        key: SampleActorCredential(
                            server.users[key]["id"], server.users[key]["email"], PASSWORD
                        )
                        for key in server.selected
                    },
                },
            )
            return dataset, mfa.plan_mfa_controls(dataset)[0], context, server

        yield setup


@pytest.mark.parametrize("pack", ["harbor", "school"])
def test_mfa_plan_uses_two_distinct_owned_active_members(pack):
    from operations.sample.controls.account import plan_account_controls
    from operations.sample.controls.mfa import plan_mfa_controls
    from operations.sample.controls.reads import plan_read_controls
    from operations.sample.phases.plan import plan_phases

    dataset = build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack)
    )
    eligible = {
        p.key
        for p in dataset.organization.actors.people
        if p.role == "member" and p.status == "active"
    }
    phase_people = {key for a in plan_phases(dataset) for key in (a.actor_key, a.target_key)}
    excluded = phase_people | {
        plan_account_controls(dataset)[0].actor_key,
        plan_read_controls(dataset)[0].target_key,
    }
    assert len(eligible - excluded) >= 2
    plan = plan_mfa_controls(dataset)
    assert len(plan) == 1
    selected = {plan[0].actor_key, plan[0].target_key}
    assert len(selected) == 2 and selected <= eligible and not selected & excluded
    assert plan[0].kind == "account_controls" and plan[0].values["operation"] == "real_mfa_reset"
    renamed = replace(
        dataset,
        organization=replace(
            dataset.organization,
            identity=replace(dataset.organization.identity, key="unrelated-name"),
        ),
    )
    assert plan_mfa_controls(renamed) == plan


@pytest.mark.parametrize("pack", ["harbor", "school"])
def test_mfa_success_requires_real_step_up_revocation_and_exact_restoration(
    setup_mfa, tmp_path, pack
):
    from operations.sample.controls.mfa import execute_mfa_control
    from operations.sample.controls.mfa_verification import verify_mfa_controls

    dataset, action, context, server = setup_mfa(pack)
    original_groups = deepcopy(server.groups)
    result = execute_mfa_control(action, dataset, context)
    assert result["status"] == "complete" and result["target_id"] == server.target
    assert len(result["target_session_ids"]) >= 2
    assert all(s not in server.sessions for s in result["target_session_ids"])
    assert all(s not in server.sessions for s in result["actor_session_ids"])
    assert server.factors[server.actor] == server.factors[server.target] == []
    assert server.factors[OWNER_ID][0]["id"] == server.owner_factor
    assert all(
        set(g["member_ids"]) == set(server.groups[key]["member_ids"])
        for key, g in original_groups.items()
    )
    assert all(
        context.clients[key].request("GET", "/api/auth/me").json()["role"] == "member"
        for key in server.selected
    )
    manifest = {
        "control_results": [result],
        "actor_ids": context.user_ids,
        "mappings": {"user": context.user_ids, "group": context.group_ids},
        "admin_id": OWNER_ID,
    }
    counts, issues = verify_mfa_controls(context.clients["admin"], dataset, manifest, OWNER_ID)
    assert issues == [] and counts["mfa_control_actions"] == 1
    assert "control_requests_verified" not in counts  # Family counts cannot replace totals.
    serialized = json.dumps(result) + (tmp_path / "requests.jsonl").read_text()
    for secret in (
        PASSWORD,
        SEED,
        OTP,
        "private-qr",
        "private-otpauth-uri",
        "private-fixture-csrf",
    ):
        assert secret not in serialized


@pytest.mark.parametrize(
    "invalid", ["owner_actor", "owner_target", "same_target", "wrong_binding", "missing_credential"]
)
def test_mfa_refuses_unsafe_prerequisites_before_any_transport(setup_mfa, invalid):
    from operations.sample.controls.mfa import execute_mfa_control

    dataset, action, context, server = setup_mfa()
    if invalid == "owner_actor":
        context.user_ids[action.actor_key] = OWNER_ID
    elif invalid == "owner_target":
        context.user_ids[action.target_key] = OWNER_ID
    elif invalid == "same_target":
        action = replace(action, target_key=action.actor_key)
    elif invalid == "wrong_binding":
        context.private_values["credentials"][action.actor_key] = SampleActorCredential(
            str(uuid4()), server.users[action.actor_key]["email"], PASSWORD
        )
    else:
        del context.private_values["credentials"][action.target_key]
    before = len(server.requests)
    with pytest.raises(SamplePhaseActionError):
        execute_mfa_control(action, dataset, context)
    assert len(server.requests) == before


def test_mfa_refuses_existing_factor_before_promoting_or_enrolling(setup_mfa):
    from operations.sample.controls.mfa import execute_mfa_control

    dataset, action, context, server = setup_mfa()
    server.factors[server.target] = [
        {"id": str(uuid4()), "factor_type": "totp", "status": "unverified"}
    ]
    before = len(server.requests)
    with pytest.raises(SamplePhaseActionError):
        execute_mfa_control(action, dataset, context)
    assert all(r.method == "GET" for r in server.requests[before:])


@pytest.mark.parametrize(
    "fault",
    (
        "aal1_accept denial_mutates no_aal2 receipt_count "
        "target_factor_remains target_session_remains actor_cleanup"
    ).split(),
)
def test_mfa_cannot_complete_false_security_or_cleanup_evidence(setup_mfa, fault):
    from operations.sample.controls.mfa import execute_mfa_control

    dataset, action, context, server = setup_mfa(fault=fault)
    with pytest.raises(SamplePhaseActionError):
        execute_mfa_control(action, dataset, context)
    if fault in {"aal1_accept", "denial_mutates", "no_aal2"}:
        assert sum(r.url.path.endswith("/mfa/reset") for r in server.requests) == 1


def test_unknown_reset_stops_without_replaying_or_cleanup_mutation(setup_mfa):
    from operations.sample.controls.mfa import execute_mfa_control

    dataset, action, context, server = setup_mfa(fault="unknown_reset")
    with pytest.raises(SampleWriteOutcomeUnknown):
        execute_mfa_control(action, dataset, context)
    reset = [i for i, r in enumerate(server.requests) if r.url.path.endswith("/mfa/reset")]
    assert len(reset) == 2  # One denied AAL1 request, one unreplayed AAL2 write.
    assert all(r.method == "GET" for r in server.requests[reset[-1] + 1 :])


@pytest.mark.parametrize(
    "tamper",
    (
        "actor status secret missing_step reused_id event_actor event_operation "
        "duplicate_event event_metadata"
    ).split(),
)
def test_mfa_verification_rejects_incomplete_misattributed_or_secret_evidence(setup_mfa, tamper):
    from operations.sample.controls.mfa import execute_mfa_control
    from operations.sample.controls.mfa_verification import verify_mfa_controls

    dataset, action, context, server = setup_mfa()
    result = execute_mfa_control(action, dataset, context)
    row = next(r for r in result["request_evidence"] if r["step"] == "reset_target_mfa")
    if tamper == "actor":
        row["actor_id"] = OWNER_ID
    elif tamper == "status":
        row["status_code"] = 403
    elif tamper == "secret":
        row["secret"] = SEED
    elif tamper == "missing_step":
        result["request_evidence"].remove(row)
    elif tamper == "reused_id":
        row["request_id"] = result["request_evidence"][0]["request_id"]
    elif tamper == "event_actor":
        server.events[-1]["actor_id"] = OWNER_ID
    elif tamper == "event_operation":
        server.events[-1]["operation_id"] = str(uuid4())
    elif tamper == "event_metadata":
        server.events[-2]["metadata"]["revoked_sessions"] = False
    else:
        server.events.append(deepcopy(server.events[-1]))
    counts, issues = verify_mfa_controls(
        context.clients["admin"],
        dataset,
        {
            "control_results": [result],
            "actor_ids": context.user_ids,
            "mappings": {"user": context.user_ids, "group": context.group_ids},
        },
        OWNER_ID,
    )
    assert issues and counts["mfa_control_actions"] == 0
