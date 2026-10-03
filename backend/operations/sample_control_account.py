"""Pack-derived self-service account actions using only owned API identities."""

import secrets
from collections.abc import Mapping
from contextlib import ExitStack
from typing import Any
from uuid import UUID

import httpx

from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient, SampleClientError
from operations.sample_invitations import InvitationMailbox, SampleInvitationError
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_people import SampleActorCredential
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _read_json,
    _request_id,
)
from operations.sample_verification import SampleVerificationError, list_all_rows

CONTROL_ROUTES = frozenset(
    {
        ("GET", "/api/auth/session"),
        ("POST", "/api/auth/refresh"),
        ("POST", "/api/auth/password/change"),
        ("POST", "/api/auth/recovery/request"),
        ("POST", "/api/auth/recovery/complete"),
        ("GET", "/api/auth/sessions"),
        ("DELETE", "/api/auth/sessions/{session_id}"),
        ("POST", "/api/auth/sessions/revoke-others"),
        ("GET", "/api/events"),
    }
)

_WRITES = {
    "refresh_session": ("POST", "/api/auth/refresh", 200),
    "login_end_target": ("POST", "/api/auth/login", 200),
    "end_current_session": ("DELETE", "/api/auth/sessions/", 204),
    "login_other_target": ("POST", "/api/auth/login", 200),
    "end_other_sessions": ("POST", "/api/auth/sessions/revoke-others", 204),
    "change_password": ("POST", "/api/auth/password/change", 200),
    "login_changed_password": ("POST", "/api/auth/login", 200),
    "request_recovery": ("POST", "/api/auth/recovery/request", 204),
    "complete_recovery": ("POST", "/api/auth/recovery/complete", 204),
    "restore_primary_login": ("POST", "/api/auth/login", 200),
}


def _uuid(value: object, step: str) -> str:
    try:
        return str(UUID(str(value)))
    except ValueError:
        raise SamplePhaseActionError("Account control identity is invalid", step=step) from None


def _current_session(response: httpx.Response, step: str) -> str:
    try:
        rows = response.json()
    except ValueError:
        rows = None
    if not isinstance(rows, list):
        raise SamplePhaseActionError("Account session listing is invalid", step=step)
    current = [
        row.get("id") for row in rows if isinstance(row, dict) and row.get("current") is True
    ]
    if len(current) != 1:
        raise SamplePhaseActionError("Account current session is unavailable", step=step)
    return _uuid(current[0], step)


def plan_account_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    person = next(
        (
            person
            for person in dataset.organization.actors.people
            if person.role == "member" and person.status == "active"
        ),
        None,
    )
    if person is None:
        raise ValueError("An account control run requires an active non-admin pack person")
    return (
        PhaseAction(
            key="control:account-security",
            phase="admin",
            kind="account_controls",
            actor_key=person.key,
            target_key=person.key,
            values={"operation": "self_service_security"},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "original_password_restored": True,
                "primary_session_authenticated": True,
                "role": "member",
                "status": "active",
            },
        ),
    )


def execute_account_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_account_controls(dataset):
        raise SamplePhaseActionError(
            "Account action differs from the non-admin pack plan", step="account_plan"
        )
    private = context.private_values
    credentials = private.get("credentials", {})
    credential = credentials.get(action.actor_key) if isinstance(credentials, Mapping) else None
    primary = context.clients.get(action.actor_key)
    factory = private.get("new_client")
    origin, mailpit_url = private.get("origin"), private.get("mailpit_url")
    if (
        not isinstance(credential, SampleActorCredential)
        or primary is None
        or not callable(factory)
        or not isinstance(origin, str)
        or not isinstance(mailpit_url, str)
    ):
        raise SamplePhaseActionError(
            "Private account run prerequisites are unavailable", step="account_setup"
        )
    actor_id = _uuid(context.user_ids.get(action.actor_key), "account_setup")
    if actor_id != credential.user_id or actor_id == context.user_ids.get("admin"):
        raise SamplePhaseActionError(
            "Account control target must be the planned non-admin", step="account_setup"
        )
    evidence: list[dict[str, object]] = []
    ended: list[str] = []

    def observed(
        step: str, method: str, path: str, response: httpx.Response, expected: int
    ) -> httpx.Response:
        request_id = _request_id(response)
        if method != "GET":
            evidence.append(
                {
                    "step": step,
                    "actor_key": action.actor_key,
                    "actor_id": actor_id,
                    "method": method,
                    "path": path,
                    "status_code": response.status_code,
                    "expected_status": expected,
                    "request_id": request_id,
                    "expected_audit_rows": 0,
                }
            )
        if response.status_code != expected or (method != "GET" and request_id is None):
            raise SamplePhaseActionError(
                "Account request did not match its planned result",
                step=step,
                status_code=response.status_code,
                request_id=request_id,
            )
        return response

    def notify(step: str) -> None:
        if on_substep is not None:
            on_substep(step)

    def request(
        client: SampleClient,
        step: str,
        method: str,
        path: str,
        expected: int = 200,
        body: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        notify(step)
        return observed(step, method, path, client.request(method, path, json_body=body), expected)

    def login(client: SampleClient, step: str, password: str) -> None:
        notify(step)
        observed(step, "POST", "/api/auth/login", client.login(credential.email, password), 200)
        identity = _read_json(request(client, f"{step}_identity", "GET", "/api/auth/me"), step=step)
        if identity.get("id") != actor_id or identity.get("role") != "member":
            raise SamplePhaseActionError(
                "Account login did not resolve the planned person", step=step
            )

    try:
        with ExitStack() as stack:
            mailbox = stack.enter_context(InvitationMailbox(mailpit_url, origin))
            baseline = (
                mailbox.snapshot()
            )  # Refuse an unavailable mailbox before changing a password.
            current = _read_json(
                request(primary, "read_session", "GET", "/api/auth/session"), step="read_session"
            )
            if current.get("authenticated") is not True or current.get("user_id") != actor_id:
                raise SamplePhaseActionError(
                    "Primary actor session is unavailable", step="read_session"
                )
            notify("refresh_session")
            observed("refresh_session", "POST", "/api/auth/refresh", primary.refresh(), 200)
            ended.append(
                _current_session(
                    request(primary, "list_sessions", "GET", "/api/auth/sessions"), "list_sessions"
                )
            )
            notify("event_stream")
            stream = primary.check_event_stream()

            end_target = stack.enter_context(factory())
            login(end_target, "login_end_target", credential.password)
            session_id = _current_session(
                request(end_target, "list_end_target", "GET", "/api/auth/sessions"),
                "list_end_target",
            )
            ended.append(session_id)
            request(
                end_target, "end_current_session", "DELETE", f"/api/auth/sessions/{session_id}", 204
            )
            if (
                _read_json(
                    request(end_target, "check_ended_session", "GET", "/api/auth/session"),
                    step="check_ended_session",
                ).get("authenticated")
                is not False
            ):
                raise SamplePhaseActionError(
                    "Ended session remains authenticated", step="check_ended_session"
                )

            other = stack.enter_context(factory())
            login(other, "login_other_target", credential.password)
            ended.append(
                _current_session(
                    request(other, "list_other_target", "GET", "/api/auth/sessions"),
                    "list_other_target",
                )
            )
            request(primary, "end_other_sessions", "POST", "/api/auth/sessions/revoke-others", 204)
            if (
                _read_json(
                    request(other, "check_other_session", "GET", "/api/auth/session"),
                    step="check_other_session",
                ).get("authenticated")
                is not False
            ):
                raise SamplePhaseActionError(
                    "Other session remains authenticated", step="check_other_session"
                )

            temporary_password = secrets.token_urlsafe(27)
            request(
                primary,
                "change_password",
                "POST",
                "/api/auth/password/change",
                body={"current_password": credential.password, "password": temporary_password},
            )
            changed = stack.enter_context(factory())
            login(changed, "login_changed_password", temporary_password)
            ended.append(
                _current_session(
                    request(changed, "list_changed_session", "GET", "/api/auth/sessions"),
                    "list_changed_session",
                )
            )
            request(
                primary,
                "request_recovery",
                "POST",
                "/api/auth/recovery/request",
                204,
                {"email": credential.email},
            )
            notify("wait_recovery_email")
            token = mailbox.recovery_token(baseline, credential.email)
            completion = stack.enter_context(factory())
            notify("complete_recovery")
            observed(
                "complete_recovery",
                "POST",
                "/api/auth/recovery/complete",
                completion.complete_recovery(token, credential.password),
                204,
            )
            if (
                _read_json(
                    request(primary, "check_recovered_session", "GET", "/api/auth/session"),
                    step="check_recovered_session",
                ).get("authenticated")
                is not False
            ):
                raise SamplePhaseActionError(
                    "Recovery did not end the original session", step="check_recovered_session"
                )
            login(primary, "restore_primary_login", credential.password)
            restored = _read_json(
                request(primary, "check_primary_session", "GET", "/api/auth/session"),
                step="check_primary_session",
            )
            if restored.get("authenticated") is not True or restored.get("user_id") != actor_id:
                raise SamplePhaseActionError(
                    "Restored primary session is unavailable", step="check_primary_session"
                )
    except SampleInvitationError:
        raise SamplePhaseActionError(
            "Owned recovery email could not be confirmed", step="recovery_email"
        ) from None
    return {
        "action_key": action.key,
        "kind": action.kind,
        "actor_key": action.actor_key,
        "target_key": action.target_key,
        "actor_id": actor_id,
        "status": "complete",
        "original_password_restored": True,
        "primary_session_authenticated": True,
        "ended_session_ids": ended,
        "sse_resyncs": stream["resyncs"],
        "request_evidence": evidence,
        "mappings": [],
    }


def verify_account_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    counts = {
        "account_control_actions": 0,
        "account_control_requests": 0,
    }
    issues: list[str] = []
    action = plan_account_controls(dataset)[0]
    raw = manifest.get("control_results")
    results = (
        [item for item in raw if isinstance(item, Mapping) and item.get("action_key") == action.key]
        if isinstance(raw, list)
        else []
    )
    if len(results) != 1:
        return counts, ["account control execution evidence is missing or duplicated"]
    result = results[0]
    actor_ids = manifest.get("actor_ids")
    actor_id = actor_ids.get(action.actor_key) if isinstance(actor_ids, Mapping) else None
    if (
        not isinstance(actor_id, str)
        or actor_id == admin_id
        or result.get("actor_id") != actor_id
        or result.get("actor_key") != action.actor_key
        or result.get("target_key") != action.target_key
        or result.get("status") != "complete"
        or result.get("original_password_restored") is not True
        or result.get("primary_session_authenticated") is not True
        or result.get("sse_resyncs") != 1
    ):
        return counts, ["account control end-state evidence differs from the planned non-admin"]
    evidence = result.get("request_evidence")
    if not isinstance(evidence, list) or [
        row.get("step") for row in evidence if isinstance(row, Mapping)
    ] != list(_WRITES):
        return counts, ["account control requests differ from the planned sequence"]
    ended = result.get("ended_session_ids")
    try:
        if not isinstance(ended, list) or len(ended) != 4 or len(set(ended)) != 4:
            raise ValueError
        ended = [str(UUID(value)) for value in ended]
        seen: set[str] = set()
        for row in evidence:
            method, path, status = _WRITES[row["step"]]
            if row["step"] == "end_current_session":
                path += ended[1]
            request_id = str(UUID(row.get("request_id", "")))
            if (
                request_id in seen
                or row.get("method") != method
                or row.get("path") != path
                or row.get("status_code") != status
                or row.get("expected_status") != status
                or row.get("actor_id") != actor_id
                or row.get("actor_key") != action.actor_key
            ):
                issues.append("account control request attribution or route differs from its plan")
            seen.add(request_id)
            counts["account_control_requests"] += 1
        person = admin.request("GET", f"/api/users/{actor_id}")
        body = _read_json(person, step="verify_account_person")
        if (
            person.status_code != 200
            or body.get("role") != "member"
            or body.get("status") != "active"
        ):
            issues.append("account control person is no longer an active non-admin")
        sessions = list_all_rows(admin, f"/api/users/{actor_id}/sessions")
        if any(row.get("id") in ended for row in sessions):
            issues.append("an account control session planned to end remains active")
    except (
        ValueError,
        TypeError,
        KeyError,
        SampleClientError,
        SamplePhaseActionError,
        SampleVerificationError,
    ):
        issues.append("account control identity or readback evidence is invalid")
    if not issues:
        counts["account_control_actions"] = 1
    return counts, issues
