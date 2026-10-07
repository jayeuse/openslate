"""Owned People monitoring and recovery through the application's UI APIs."""

from collections.abc import Mapping
from datetime import timedelta
from typing import Any

import httpx

from app.systems.access.users.schemas import (
    AuthMeResponse,
    DirectoryRowResponse,
    UserRecoveryResponse,
    UserResponse,
    UserSecurityResponse,
    UserSummaryResponse,
)
from app.systems.access.users.sessions_schemas import AdminSessionResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClientError
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.people_security_verification import (
    Read,
    _dto,
    _events,
    _pages,
    _person,
    _require,
    _uuid,
)
from operations.sample.controls.reads import plan_read_controls
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _request,
    _request_id,
    _result,
)
from operations.sample.population.people import SampleActorCredential

CONTROL_ROUTES = frozenset(
    {
        ("GET", "/api/users/summary"),
        ("GET", "/api/users/{user_id}/security"),
        ("POST", "/api/users/{user_id}/recovery"),
        ("GET", "/api/security-events"),
        ("GET", "/api/security-events/{event_id}"),
    }
)


def _monitoring(read: Read, days: int) -> tuple[dict[str, object], dict[str, int]]:
    summary = _dto(
        read("/api/users/summary", {"inactive_days": days}, "people_summary"),
        UserSummaryResponse,
        "people_summary",
    )
    _require(summary.inactive_days == days and summary.as_of.tzinfo is not None, "people_summary")
    counts = {
        "without": summary.admins_without_mfa,
        "unknown": summary.admins_mfa_unknown,
        "no-recorded-sign-in": summary.no_recorded_sign_in,
        "inactive": summary.inactive_people,
    }
    pages: dict[str, int] = {}
    for category, expected in counts.items():
        rows, pages[category] = _pages(
            read,
            "/api/users",
            {
                "mfa" if category in {"without", "unknown"} else "history": category,
                "inactive_days": days,
                "sort_by": "name",
                "sort_order": "asc",
            },
            DirectoryRowResponse,
            f"people_directory:{category}",
        )
        _require(len(rows) == expected, f"people_directory:{category}")
        for row in rows:
            _require(
                row.status.value == "active"
                and not row.is_deleted
                and row.deleted_at is None
                and (row.expires_at is None or row.expires_at > summary.as_of),
                f"people_directory:{category}",
            )
            if category in {"without", "unknown"}:
                _require(row.role.value == "admin", "people_mfa_projection")
                _require(
                    row.mfa_verified_totp is False and row.mfa_observed_at is not None
                    if category == "without"
                    else row.mfa_verified_totp is None,
                    "people_mfa_projection",
                )
            elif category == "no-recorded-sign-in":
                _require(row.last_sign_in_at is None, "people_history_projection")
            else:
                _require(
                    row.last_active_at is not None
                    and row.last_active_at.tzinfo is not None
                    and row.last_active_at < summary.as_of - timedelta(days=days),
                    "people_history_projection",
                )
    return summary.model_dump(mode="json"), pages


def plan_people_security_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    excluded = {
        plan_account_controls(dataset)[0].actor_key,
        plan_read_controls(dataset)[0].target_key,
    }
    target = next(
        (
            person.key
            for person in dataset.organization.actors.people
            if person.role == "member" and person.status == "active" and person.key not in excluded
        ),
        None,
    )
    if target is None:
        raise ValueError("People controls require an authored active member target")
    return (
        PhaseAction(
            key="control:people-security",
            phase="admin",
            kind="access_controls",
            actor_key="admin",
            target_key=target,
            values={"operation": "review_people_security", "inactive_days": 30},
            expected_status=200,
            expected_detail=None,
            expected_end_state={"primary_session_authenticated": True, "recoveries_verified": 2},
        ),
    )


def execute_people_security_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    _require(action in plan_people_security_controls(dataset), "people_plan")
    target = _uuid(context.user_ids.get(action.target_key), "people_setup")
    admin = _uuid(context.user_ids.get("admin"), "people_setup")
    person = next(p for p in dataset.organization.actors.people if p.key == action.target_key)
    credentials = context.private_values.get("credentials")
    credential = credentials.get(action.target_key) if isinstance(credentials, Mapping) else None
    primary = context.clients.get(action.target_key)
    if (
        not isinstance(credential, SampleActorCredential)
        or credential.user_id != target
        or credential.email != person.email
        or not credential.password
        or primary is None
        or target == admin
    ):
        raise SamplePhaseActionError("Owned People credential is invalid", step="people_credential")
    evidence: list[dict[str, object]] = []

    def record(response: httpx.Response, actor: str, method: str, path: str, step: str) -> None:
        request_id = _request_id(response)
        _require(response.status_code == 200 and request_id is not None, step)
        evidence.append(
            {
                "step": step,
                "actor_key": actor,
                "actor_id": context.user_ids[actor],
                "method": method,
                "path": path,
                "expected_status": 200,
                "status_code": response.status_code,
                "request_id": request_id,
            }
        )

    def request(
        actor: str,
        method: str,
        path: str,
        step: str,
        params: Mapping[str, Any] | None = None,
        body: Mapping[str, Any] | None = None,
        *,
        refresh_first: bool = True,
    ) -> httpx.Response:
        response = _request(
            action,
            context,
            [],
            actor_key=actor,
            method=method,
            path=path,
            step=step,
            expected=200,
            on_substep=on_substep,
            params=params,
            json_body=body,
            refresh_first=refresh_first,
        )
        record(response, actor, method, path, step)
        return response

    def read(path: str, params: Mapping[str, Any] | None, step: str) -> httpx.Response:
        return request("admin", "GET", path, step, params)

    def authenticated(step: str) -> None:
        response = request(action.target_key, "GET", "/api/auth/session", step)
        body = response.json()
        _require(
            isinstance(body, dict)
            and body.get("authenticated") is True
            and body.get("user_id") == target,
            step,
        )
        me = _dto(
            request(action.target_key, "GET", "/api/auth/me", step + ":me"), AuthMeResponse, step
        )
        _person(me, target, person.email, step)

    def sessions(step: str) -> list[str]:
        rows, _ = _pages(
            read,
            f"/api/users/{target}/sessions",
            {"sort_by": "refreshed_at", "sort_order": "desc"},
            AdminSessionResponse,
            step,
        )
        return [str(row.id) for row in rows]

    owner = _dto(read("/api/auth/me", None, "people_owner"), AuthMeResponse, "people_owner")
    _require(
        str(owner.id) == admin
        and owner.role.value == "admin"
        and owner.status.value == "active"
        and not owner.is_deleted,
        "people_owner",
    )
    _person(
        _dto(read(f"/api/users/{target}", None, "people_target"), UserResponse, "people_target"),
        target,
        person.email,
        "people_target",
    )
    authenticated("people_primary_before")
    security = _dto(
        read(f"/api/users/{target}/security", None, "people_security"),
        UserSecurityResponse,
        "people_security",
    )
    _require(
        str(security.user_id) == target and security.target_eligible and security.smtp_configured,
        "people_security",
    )
    summary, directory_pages = _monitoring(read, 30)
    captured = sessions("people_sessions_before")
    _require(bool(captured), "people_sessions_before")
    receipts: list[dict[str, Any]] = []
    for revoke in (False, True):
        step = "people_recovery:" + str(revoke).lower()
        try:
            response = request(
                "admin",
                "POST",
                f"/api/users/{target}/recovery",
                step,
                body={"revoke_sessions": revoke},
            )
            receipt = _dto(response, UserRecoveryResponse, step)
            _require(
                str(receipt.user_id) == target
                and receipt.local_revocation == ("committed" if revoke else "not_requested")
                and (
                    receipt.revoked_sessions is not None
                    and receipt.revoked_sessions >= len(captured)
                    if revoke
                    else receipt.revoked_sessions is None
                ),
                step,
            )
            identifiers, pages = _events(
                read, receipt.model_dump(mode="json"), evidence[-1], admin, target, revoke
            )
            receipts.append(
                {
                    **receipt.model_dump(mode="json"),
                    "revoke_sessions": revoke,
                    "event_ids": identifiers,
                    "event_pages": pages,
                }
            )
            remaining = sessions("people_sessions_after:" + str(revoke).lower())
            _require(
                not set(captured) & set(remaining) if revoke else set(captured) <= set(remaining),
                step,
            )
            if revoke:
                session = request(
                    action.target_key,
                    "GET",
                    "/api/auth/session",
                    "people_primary_revoked",
                    refresh_first=False,
                ).json()
                _require(isinstance(session, dict) and session.get("authenticated") is False, step)
            else:
                authenticated("people_primary_preserved")
        finally:
            if revoke:
                # A failed/lost response may follow committed revocation. Never replay
                # recovery; restore only the owned primary using its unchanged secret.
                if on_substep is not None:
                    on_substep("people_restore_primary")
                try:
                    login = primary.login(credential.email, credential.password)
                    record(
                        login,
                        action.target_key,
                        "POST",
                        "/api/auth/login",
                        "people_restore_primary",
                    )
                    authenticated("people_primary_restored")
                except (SampleClientError, ValueError):
                    raise SamplePhaseActionError(
                        "Owned primary authentication could not be restored",
                        step="people_restore_primary",
                    ) from None
    return _result(
        action,
        context,
        evidence,
        [],
        extra={
            "target_id": target,
            "summary": summary,
            "directory_pages": directory_pages,
            "captured_session_ids": captured,
            "recoveries": receipts,
            "recoveries_verified": 2,
            "primary_session_authenticated": True,
        },
    )
