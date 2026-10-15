"""Closed People/security transport fixture; never real provider/event proof."""

import json
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict
from datetime import date
from importlib import import_module
from uuid import NAMESPACE_URL, uuid5

import httpx

from app.systems.access.users.directory import UserListRequest, UserSummaryRequest
from app.systems.access.users.schemas import UserRecoveryRequest
from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext
from operations.sample.population.people import SampleActorCredential
from operations.sample.scenario import build_dataset

ORIGIN = "http://127.0.0.1:3000"
PASSWORD = "owned-member-fixture-password"
STAMP = "2026-10-07T12:00:00Z"


def identifier(key):
    return str(uuid5(NAMESPACE_URL, "people-security:" + key))


def dataset(pack="harbor"):
    return build_dataset("small", 42, date(2026, 10, 1), organization=get_pack(pack))


def unit():
    # Deferred imports keep the incumbent planning red collectable. Missing
    # modules remain prerequisites, never meaningful journey-red evidence.
    return (
        import_module("operations.sample.controls.people_security"),
        import_module("operations.sample.controls.people_security_verification"),
    )


class PeopleWire:
    def __init__(self, source, action, fault=None):
        self.source, self.action, self.fault = source, action, fault
        self.person = next(
            p for p in source.organization.actors.people if p.key == action.target_key
        )
        self.admin, self.target = identifier("admin"), identifier(self.person.key)
        self.requests, self.recoveries, self.events, self.details = [], [], [], []
        self.fault_hits = set()
        self.sessions = {identifier("secondary"): self.target}
        self.primary_logins, self.final_mode = 0, False
        self.owner_factors = (identifier("owner-factor"),)
        self.profiles = {
            self.admin: self.profile(self.admin, "admin", "owner@example.test"),
            self.target: self.profile(self.target, "member", self.person.email),
        }
        self.profiles[self.target].update(
            username=self.person.username, display_name=self.person.name
        )
        self.directory = {
            "without": [self.row(f"without:{i}", "admin", False) for i in range(3)],
            "unknown": [self.row(f"unknown:{i}", "admin", None) for i in range(2)],
            "no-recorded-sign-in": [self.row("no-history", "member", None, history=None)],
            "inactive": [self.row("inactive", "member", None, history="2026-08-01T00:00:00Z")],
        }

    def profile(self, user_id, role, email):
        return {
            "id": user_id,
            "email": email,
            "username": "owned-person",
            "role": role,
            "status": "active",
            "display_name": "Owned person",
            "job_title": None,
            "sponsor_user_id": None,
            "expires_at": None,
            "invitation_sent_at": STAMP,
            "created_at": STAMP,
            "updated_at": STAMP,
            "deleted_at": None,
            "is_deleted": False,
            "performed_by": identifier("admin"),
        }

    def row(self, key, role, verified, *, history=STAMP):
        return {
            **self.profile(identifier(key), role, key + "@example.test"),
            "active_session_count": 0,
            "mfa_verified_totp": verified,
            "mfa_observed_at": STAMP if verified is not None else None,
            "last_sign_in_at": history,
            "last_active_at": history,
        }

    def response(self, body, status=200, headers=()):
        return httpx.Response(
            status,
            json=body,
            headers=[
                ("X-Request-ID", identifier(f"request:{len(self.requests)}")),
                ("Cache-Control", "private, no-store"),
                *headers,
            ],
        )

    def page(self, rows, request):
        limit, offset = (int(request.url.params[name]) for name in ("limit", "offset"))
        items = deepcopy(rows[offset : offset + limit])
        return {
            "items": items,
            "pagination": {
                "limit": limit,
                "offset": offset,
                "count": len(items),
                "total": len(rows),
                "has_more": offset + len(items) < len(rows),
            },
        }

    def identity(self, request):
        cookies = dict(
            part.split("=", 1)
            for part in request.headers.get("cookie", "").split("; ")
            if "=" in part
        )
        return self.sessions.get(cookies.get("openslate_access"))

    def event(self, request, response, operation, outcome, revoke, count):
        return {
            "id": identifier(f"event:{operation}:{outcome}"),
            "occurred_at": STAMP,
            "event_type": "identity.recovery",
            "source": "access.users",
            "outcome": outcome,
            "operation_id": operation,
            "actor_id": self.admin,
            "subject_id": self.target,
            "labels": {},
            "fingerprint": None,
            "reason": None,
            "request_id": response.headers["X-Request-ID"],
            "request_method": "POST",
            "request_path": request.url.path,
            "metadata": {
                "email_request": "accepted"
                if outcome == "success"
                else "unconfirmed"
                if outcome == "partial"
                else "not_attempted",
                "local_revocation": "committed"
                if revoke and outcome in {"success", "partial"}
                else "unconfirmed"
                if revoke
                else "not_requested",
                "revoked_sessions": count if outcome in {"success", "partial"} else 0,
                "factors_cleared": None,
            },
        }

    def handle(self, request):
        self.requests.append(request)
        method, path = request.method, request.url.path
        assert request.headers["origin"] == ORIGIN
        if path == "/api/auth/login":
            body = json.loads(request.content)
            assert body["password"] == PASSWORD
            actor = self.target if body["email"] == self.person.email else self.admin
            if actor == self.target:
                self.primary_logins += 1
                if self.primary_logins > 1 and self.fault == "reauth_denied":
                    self.fault_hits.add(self.fault)
                    return self.response({"authenticated": False}, 401)
            session = identifier(f"session:{len(self.requests)}")
            self.sessions[session] = actor
            return self.response(
                {"authenticated": True, "setup_required": False},
                headers=[
                    ("Set-Cookie", f"openslate_access={session}; Path=/; HttpOnly"),
                    ("Set-Cookie", "openslate_csrf=owned-csrf; Path=/"),
                ],
            )
        actor = self.identity(request)
        if path == "/api/auth/session":
            return self.response(
                {"authenticated": actor is not None, **({"user_id": actor} if actor else {})}
            )
        if path == "/api/auth/refresh":
            assert actor is None, "This fixture refresh is only a revoked-session refusal"
            return self.response({"detail": "Session is no longer active"}, 401)
        assert actor is not None, "Unexpected unauthenticated fixture operation"
        if method != "GET":
            assert request.headers["x-csrf-token"] == "owned-csrf"
        if path == "/api/auth/me":
            body = {**self.profiles[actor], "access": []}
            account = {key: value for key, value in body.items() if key not in {
                "role", "access", "sponsor_user_id", "expires_at", "invitation_sent_at",
            }}
            org = {"org_id": self.admin, "name": "Example", "slug": "example",
                   "role": body["role"]}
            body.update(account=account, memberships=[org], pending_invitations=[],
                        current_organization={**org, "access": []},
                        default_organization_blocked=None)
            if actor == self.target and self.primary_logins > 1 and self.fault == "reauth_identity":
                body["id"] = self.admin
                self.fault_hits.add(self.fault)
            return self.response(body)
        assert actor == self.admin
        if path == "/api/users/summary":
            query = UserSummaryRequest.model_validate(dict(request.url.params))
            body = {
                "admins_without_mfa": 3,
                "admins_mfa_unknown": 2,
                "no_recorded_sign_in": 1,
                "inactive_people": 1,
                "as_of": STAMP,
                "inactive_days": query.inactive_days,
            }
            if self.fault == "summary_count":
                body["admins_without_mfa"] = 4
            if self.fault == "summary_cutoff":
                body["as_of"] = "not-an-instant"
            if self.fault in {"summary_count", "summary_cutoff"}:
                self.fault_hits.add(self.fault)
            return self.response(body)
        if path == "/api/users":
            query = UserListRequest.model_validate(dict(request.url.params))
            key = query.mfa or query.history
            assert key in self.directory and query.inactive_days == 30
            rows = deepcopy(self.directory[key])
            if key == "without" and self.fault == "unknown_as_without":
                rows[0]["mfa_verified_totp"] = None
            if key == "without" and self.fault == "duplicate_person":
                rows[1] = deepcopy(rows[0])
            if key == "inactive" and self.fault in {"null_inactive", "future_inactive"}:
                rows[0]["last_active_at"] = None if self.fault == "null_inactive" else STAMP
            rows.sort(key=lambda row: row["id"], reverse=query.sort_order == "desc")
            body = self.page(rows, request)
            if self.fault == "wrong_page":
                body["pagination"]["offset"] += 1
            faults = {
                "wrong_page": True,
                "duplicate_person": key == "without",
                "unknown_as_without": key == "without",
                "null_inactive": key == "inactive",
                "future_inactive": key == "inactive",
            }
            if faults.get(self.fault):
                self.fault_hits.add(self.fault)
            return self.response(body)
        if path == f"/api/users/{self.target}":
            body = deepcopy(self.profiles[self.target])
            if self.final_mode and self.fault == "final_identity":
                body["role"] = "admin"
            return self.response(body)
        if path == f"/api/users/{self.target}/security":
            if self.fault in {"security_identity", "ineligible", "smtp_missing"}:
                self.fault_hits.add(self.fault)
            return self.response(
                {
                    "user_id": self.admin if self.fault == "security_identity" else self.target,
                    "verified_factor_count": 0,
                    "target_eligible": self.fault != "ineligible",
                    "smtp_configured": self.fault != "smtp_missing",
                }
            )
        if path == f"/api/users/{self.target}/sessions":
            rows = [
                {
                    "id": sid,
                    "created_at": STAMP,
                    "refreshed_at": STAMP,
                    "expires_at": "2026-10-08T12:00:00Z",
                    "user_agent": None,
                    "ip_address": None,
                    "current": False,
                }
                for sid, owner in self.sessions.items()
                if owner == self.target
            ]
            return self.response(self.page(rows, request))
        if path == f"/api/users/{self.target}/recovery":
            return self.recover(request)
        if path == "/api/security-events":
            operation = request.url.params["operation_id"]
            assert request.url.params["person_id"] == self.target
            assert request.url.params["event_type"] == "identity.recovery"
            rows = [row for row in self.events if row["operation_id"] == operation]
            if self.fault == "missing_event":
                rows = rows[:1]
            if self.fault == "duplicate_event":
                rows[1] = {**rows[1], "id": rows[0]["id"]}
            fields = {
                "event_actor": "actor_id",
                "event_subject": "subject_id",
                "event_request": "request_id",
                "event_operation": "operation_id",
            }
            if self.fault in fields:
                rows[-1] = {**rows[-1], fields[self.fault]: identifier("foreign")}
            if self.fault == "event_outcome":
                rows[-1] = {**rows[-1], "outcome": "denied"}
            if self.fault in {*fields, "missing_event", "duplicate_event", "event_outcome"}:
                self.fault_hits.add(self.fault)
            rows.sort(
                key=lambda row: (row["occurred_at"], row["id"]),
                reverse=request.url.params["sort_order"] == "desc",
            )
            return self.response(self.page(rows, request))
        if path.startswith("/api/security-events/"):
            event_id = path.rsplit("/", 1)[1]
            self.details.append(event_id)
            body = deepcopy(next(row for row in self.events if row["id"] == event_id))
            if self.fault == "event_detail":
                body["request_path"] = "/api/users/foreign/recovery"
                self.fault_hits.add(self.fault)
            return self.response(body)
        raise AssertionError(f"Unexpected People fixture route {method} {path}")

    def recover(self, request):
        parsed = UserRecoveryRequest.model_validate_json(request.content, strict=True)
        revoke = parsed.revoke_sessions
        self.recoveries.append(revoke)
        assert self.recoveries == [False] or self.recoveries == [False, True]
        if revoke and self.fault != "sessions_remain":
            self.sessions = {
                sid: owner for sid, owner in self.sessions.items() if owner != self.target
            }
        operation = identifier(f"operation:{len(self.recoveries)}")
        count = 3 if revoke else 0  # Includes one older session beyond the active list.
        body = {
            "operation_id": operation,
            "user_id": self.target,
            "email_request": "accepted",
            "local_revocation": "committed" if revoke else "not_requested",
            "revoked_sessions": count if revoke else None,
        }
        if self.fault == "receipt_target":
            body["user_id"] = self.admin
        if self.fault == "false_revocation":
            body.update(local_revocation="committed", revoked_sessions=1)
        if revoke and self.fault == "receipt_count":
            body["revoked_sessions"] = 0
        if self.fault in {"receipt_target", "false_revocation"}:
            self.fault_hits.add(self.fault)
        if revoke and self.fault in {
            "receipt_count",
            "sessions_remain",
            "partial",
            "unknown_write",
        }:
            self.fault_hits.add(self.fault)
        response = self.response(body)
        terminal = "partial" if revoke and self.fault == "partial" else "success"
        self.events.extend(
            self.event(request, response, operation, outcome, revoke, count)
            for outcome in ("attempt", terminal)
        )
        if revoke and self.fault == "partial":
            return self.response(
                {
                    "detail": {
                        "code": "security_action_incomplete",
                        "message": "This action could not be confirmed.",
                        "operation_id": operation,
                        "email_request": "unconfirmed",
                        "local_revocation": "committed",
                        "factors_cleared": None,
                    }
                },
                503,
            )
        if revoke and self.fault == "unknown_write":
            raise httpx.ReadTimeout("Owned fixture response lost", request=request)
        return response


@contextmanager
def journey(tmp_path, pack="harbor", fault=None):
    people, verification = unit()
    source = dataset(pack)
    action = people.plan_people_security_controls(source)[0]
    server = PeopleWire(source, action, fault)
    clients = {
        key: SampleClient(
            ORIGIN,
            ORIGIN,
            tmp_path / "requests.jsonl",
            transport=httpx.MockTransport(server.handle),
        )
        for key in ("admin", action.target_key)
    }
    clients["admin"].login("owner@example.test", PASSWORD)
    clients[action.target_key].login(server.person.email, PASSWORD)
    credential = SampleActorCredential(server.target, server.person.email, PASSWORD)
    if fault == "credential_identity":
        credential = SampleActorCredential(server.admin, server.person.email, PASSWORD)
    private = {"credentials": {action.target_key: credential}}
    if fault == "missing_credential":
        private["credentials"].clear()
    context = PhaseExecutionContext(
        clients=clients,
        user_ids={"admin": server.admin, action.target_key: server.target},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password=PASSWORD,
        private_values=private,
    )
    try:
        yield people, verification, source, action, context, server
    finally:
        for client in clients.values():
            client.close()


def manifest(action, result, server):
    return {
        "actor_ids": {action.target_key: server.target},
        "control_plan": [asdict(action)],
        "control_results": [result],
        "mappings": {"user": {action.target_key: server.target}},
    }
