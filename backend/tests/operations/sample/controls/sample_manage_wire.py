"""Closed Manage HTTP fixture shared by the sample control journeys."""

import json
from datetime import date
from uuid import NAMESPACE_URL, uuid5

import httpx

from app.systems.access.users.sessions_schemas import AdminSessionCollectionRequest
from app.systems.manage.workspace.security_schemas import WorkspaceSecurityUpdate
from operations.sample.client import SampleClient
from operations.sample.controls.actions import plan_controls
from operations.sample.controls.manage import _shared_primary_keys
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext
from operations.sample.population.people import SampleActorCredential
from operations.sample.scenario import build_dataset


def _id(key: str) -> str:
    return str(uuid5(NAMESPACE_URL, "read-review:" + key))


def _workspace_profile(dataset):
    return {
        "id": _id("workspace"),
        "display_name": dataset.organization.identity.workspace_name,
        "legal_name": None,
        "description": None,
        "logo_file_id": None,
        "timezone": dataset.organization.identity.timezone,
        "locale": dataset.organization.identity.locale,
        "mark": "TEST",
        "currency": "GBP" if dataset.organization.identity.currency_symbol == "£" else "PHP",
        "week_start": "monday",
        "business_hours": "09:00–18:00",
        "theme": "stockroom",
        "invitation_expiry_days": 7,
        "guest_duration_days": 30,
        "revision": 3,
        "created_at": "2026-10-01T00:00:00Z",
        "updated_at": "2026-10-01T00:00:00Z",
        "contact_email": None,
        "contact_phone": None,
        "postal_address": None,
    }


_AT = "2026-11-05T10:42:00Z"
_PARTS = [{"key": "data", "status": "working"}, {"key": "email", "status": "set_up"}]


def _health_periods(problem):
    return {
        "items": [{"part": "email", "kind": "not_working", "started_at": "2026-11-04T09:00:00Z",
                   "ended_at": "2026-11-04T09:12:00Z"}],
        "pagination": {"limit": 5, "offset": 0, "count": 2 if problem == "health_periods_shape"
                       else 1, "total": 1, "has_more": False},
        "oldest_sample_at": "2026-10-06T00:00:00Z",
    }


def _organization_file(problem):
    body = {
        "summary": {"kind": "organization", "generated_at": _AT, "application_version": "0.1.0",
                    "parts": _PARTS, "problem_periods_30d": 0, "server_errors_30d": 0,
                    "storage_used_bytes": 1200},
        "versions": {"application": "0.1.0"},
        "periods": [],
        "storage": {"used_bytes": 1200},
        "server_errors": {"total_30d": 0, "truncated": False, "items": []},
    }
    if problem == "organization_file_scope":
        body["workers"] = []
    return body


def _installation_file(problem):
    body = {
        "summary": {"kind": "installation", "generated_at": _AT, "application_version": "0.1.0",
                    "parts": _PARTS, "problem_periods_30d": 0, "server_errors_30d": 1,
                    "workers_not_running": ["comms_jobs"], "database_bytes": 4096},
        "versions": {"application": "0.1.0", "schema_revision": "f8852c638a76",
                     "postgresql": "17.4"},
        "database": {"bytes": 4096, "measured_at": _AT},
        "workers": [{"key": "comms_jobs", "state": "never_seen", "last_seen_at": None}],
        "organizations": [{"org_id": _id("workspace"), "storage_used_bytes": 1200}],
        "samples": {"columns": ["sampled_at", "data_status"], "rows": [[_AT, "working"]]},
        "periods": [],
        "server_errors": {"total_30d": 1, "truncated": False, "items": [
            {"request_id": _id("server-error"), "occurred_at": _AT, "status": 500,
             "method": "GET", "route": "/api/records/{record_id}", "org_id": None},
        ]},
    }
    if problem == "installation_file_shape":
        body["summary"] = body.pop("summary")
    return body


def _manage_run(tmp_path, pack_key, problem=None):
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(pack_key))
    actions = [a for a in plan_controls(dataset) if a.kind == "manage_controls"]
    assert len(actions) == 10, "Every new noninteractive Phase B route needs its own action"
    people = {
        p.key: p
        for p in dataset.organization.actors.people
        if p.role == "member" and p.status == "active"
    }
    staff = {"admin": _id("admin"), "operator": _id("operator")}
    user_ids = {key: _id(key) for key in people} | staff
    # Accounts that also belong to another organization: the server keeps their sessions.
    shared = {"operator", *_shared_primary_keys(dataset)}
    credentials = {
        key: SampleActorCredential(user_ids[key], p.email, "Owned-Fixture-Password-123")
        for key, p in people.items()
    }
    emails = {c.email: key for key, c in credentials.items()} | {
        f"{key}@example.test": key for key in staff
    }
    sessions, clients = {}, {}
    policy = {
        "revision": 7,
        "session_timeout_minutes": 60,
        "session_retention_days": 271,
        "security_event_retention_days": 613,
        "password_min_length": 12,
        "password_require_mixed_case": True,
        "password_require_number": False,
        **{f"mfa_require_{role}": False for role in ("admin", "member", "guest")},
        "mfa_grace_days": 0,
        "session_absolute_lifetime_minutes": None,
        "session_concurrent_limit": None,
        "login_failed_attempt_threshold": 5,
        **dict.fromkeys(("login_window_minutes", "login_cooldown_minutes"), 15),
        "ip_allow_list": [],
    }
    state = {
        "seen": [],
        "policy": policy,
        "patches": [],
        "logins": [],
        "revoked": False,
        "shared": shared,
    }

    def handler(request):
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else {}
        state["seen"].append((method, path))
        headers = [("X-Request-ID", _id(f"request:{len(state['seen'])}"))]
        if path == "/api/auth/login":
            actor = emails[body["email"]]
            if problem == "reauth_denied" and state["revoked"]:
                return httpx.Response(401, headers=headers, json={"authenticated": False})
            assert body["password"] == "Owned-Fixture-Password-123"
            session = _id(f"session:{len(state['seen'])}")
            sessions[session] = actor
            state["logins"].append(actor)
            return httpx.Response(
                200,
                headers=[
                    *headers,
                    ("Set-Cookie", f"slateops_access={session}; Path=/; HttpOnly"),
                    ("Set-Cookie", "slateops_csrf=c; Path=/"),
                ],
                json={"authenticated": True},
            )
        cookies = dict(
            part.split("=", 1)
            for part in request.headers.get("cookie", "").split("; ")
            if "=" in part
        )
        session = cookies.get("slateops_access")
        actor = sessions.get(session)
        if path == "/api/auth/session":
            return httpx.Response(
                200,
                headers=headers,
                json={"authenticated": actor is not None, "user_id": user_ids.get(actor)},
            )
        if actor is None:
            return httpx.Response(401, headers=headers, json={"detail": "Not authenticated"})
        if path == "/api/auth/me":
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "id": user_ids[actor],
                    "role": "admin" if actor in staff else "member",
                    "status": "active",
                },
            )
        if path == "/api/auth/mfa":
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "user_id": _id("wrong") if problem == "mfa_identity" else user_ids[actor],
                    "assurance_level": "aal1",
                    "required": False,
                    "policy_required": False,
                    **dict.fromkeys(("required_since", "enrollment_deadline")),
                    "factors": [],
                },
            )
        if path == "/api/system/status":
            keys = ["data", "signing_in", "files", "email"]
            if problem == "system_status_shape":
                keys.reverse()
            statuses = dict(zip(keys, ("working", "working", "not_working", "set_up"), strict=True))
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "parts": [{"key": key, "status": statuses[key]} for key in keys],
                    "version": "0.1.0",
                    "checked_at": "2026-11-02T10:42:05.123456Z",
                    # The status control runs as a plain member, who gets no organization or
                    # installation part.
                    "organization": None,
                    "installation": None,
                },
            )
        if path == "/api/system/health-periods":
            return httpx.Response(200, headers=headers, json=_health_periods(problem))
        if path == "/api/system/diagnostics/organization":
            assert actor == "admin"
            return httpx.Response(200, headers=headers, json=_organization_file(problem))
        if path == "/api/system/diagnostics/installation":
            assert actor == "operator"
            return httpx.Response(200, headers=headers, json=_installation_file(problem))
        if path == "/api/auth/sign-in-events":
            kinds = ["sign_in_failed"] if problem == "sign_in_history_shape" else ["signed_in"]
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "items": [
                        {
                            "id": _id(f"sign-in-{kind}"),
                            "kind": kind,
                            "occurred_at": "2026-11-03T08:15:00Z",
                            "user_agent": "Sample agent",
                            "ip_address": "192.0.2.10",
                        }
                        for kind in kinds
                    ],
                    "pagination": {
                        "limit": 25, "offset": 0, "count": 1, "total": 1, "has_more": False,
                    },
                },
            )
        assert actor in staff
        if path == "/api/workspace/security":
            if method == "PATCH":
                # Installation-wide fields need the installation owner.
                assert actor == "operator"
                state["patches"].append(body)
                payload = WorkspaceSecurityUpdate.model_validate(body)
                assert payload.revision == policy["revision"]
                assert (
                    body.get("password_min_length", policy["password_min_length"]),
                    body.get("password_require_mixed_case", policy["password_require_mixed_case"]),
                    body.get("password_require_number", policy["password_require_number"]),
                ) in {(12, True, False), (16, True, True), (20, False, False)}
                assert not any(v for k, v in body.items() if k.startswith("mfa_require_"))
                assert body.get("ip_allow_list", policy["ip_allow_list"]) == []
                merged = {**policy, **body, "revision": policy["revision"] + 1}
                if problem != "policy_not_saved":
                    persisted = dict(merged)
                    ignored = {
                        "session_retention_ignored": "session_retention_days",
                        "event_retention_ignored": "security_event_retention_days",
                    }.get(problem)
                    if ignored is not None and len(state["patches"]) == 1:
                        persisted[ignored] = policy[ignored]
                    if problem == "retention_restore_lost" and len(state["patches"]) == 2:
                        persisted["session_retention_days"] = policy["session_retention_days"]
                    policy.update(persisted)
                return httpx.Response(200, headers=headers, json=merged)
            return httpx.Response(200, headers=headers, json=policy)
        if path == "/api/auth/admin-sessions":
            assert actor == "admin"
            if method == "DELETE":
                assert not request.content and not request.url.query
                if problem == "bulk_unknown":
                    return httpx.Response(
                        503, headers=headers, json={"detail": "Session revocation is unavailable"}
                    )
                kept = {"operator"} if problem == "shared_revoked" else shared
                skipped = {key for sid, key in sessions.items() if sid != session} & kept
                for sid, key in list(sessions.items()):
                    if sid != session and key not in kept:
                        del sessions[sid]
                if problem == "remaining_page":
                    sessions[_id("unmapped-remote-session")] = next(
                        key for key in people if key not in shared
                    )
                state["revoked"] = True
                count = len(skipped) + (problem == "skipped_count")
                return httpx.Response(
                    204, headers=[*headers, ("X-Skipped-Shared-Accounts", str(count))]
                )
            query = AdminSessionCollectionRequest.model_validate(dict(request.url.params))
            rows = [
                {
                    "id": sid,
                    "user_id": user_ids[key],
                    "person_name": key.title() if key in staff else people[key].name,
                    "user_agent": "python-httpx",
                    "ip_address": None,
                    "device": "Unknown",
                    "browser": "Unknown",
                    "created_at": "2026-10-01T00:00:00Z",
                    "refreshed_at": "2026-10-01T00:00:00Z",
                    "expires_at": "2026-10-03T00:00:00Z",
                    "current": sid == session,
                }
                for sid, key in sessions.items()
            ]
            rows = [
                row
                for row in rows
                if (query.status == "all" or row["current"] == (query.status == "current"))
                and (query.device == "all" or row["device"] == query.device)
                and (not query.search or query.search.lower() in row["person_name"].lower())
            ]
            rows.sort(
                key=lambda row: (
                    row["person_name"].lower()
                    if query.sort_by == "person_name"
                    else row["refreshed_at"],
                    row["id"],
                ),
                reverse=query.sort_order == "desc",
            )
            items = rows[query.offset : query.offset + query.limit]
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "items": items,
                    "pagination": {
                        "limit": query.limit,
                        "offset": query.offset,
                        "count": len(items) + (problem == "pagination"),
                        "total": len(rows),
                        "has_more": query.offset + len(items) < len(rows),
                    },
                },
            )
        raise AssertionError(f"Unexpected Manage request {method} {path}")

    for actor in user_ids:
        client = SampleClient(
            "https://api.example.test",
            "https://ui.example.test",
            tmp_path / "manage.jsonl",
            transport=httpx.MockTransport(handler),
        )
        client.login(
            f"{actor}@example.test" if actor in staff else credentials[actor].email,
            "Owned-Fixture-Password-123",
        )
        clients[actor] = client
    if problem == "missing_credential":
        credentials.pop(next(iter(credentials)))
    context = PhaseExecutionContext(
        clients=clients,
        user_ids=user_ids,
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="Owned-Fixture-Password-123",
        private_values={"credentials": credentials},
    )
    return dataset, actions, context, state
