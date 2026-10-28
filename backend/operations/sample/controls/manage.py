"""Persisted Manage settings and session controls for either authored pack."""

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from app.systems.access.users.sessions_schemas import AdminSessionCollectionResponse
from app.systems.manage.workspace.security_schemas import WorkspaceSecurityResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.planned_actors import OPERATOR, partner_action
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _id,
    _request_id,
    _request_object,
    _result,
)
from operations.sample.population.people import SampleActorCredential

CONTROL_ROUTES = frozenset(
    {
        ("GET", "/api/auth/admin-sessions"),
        ("DELETE", "/api/auth/admin-sessions"),
        ("GET", "/api/workspace/security"),
        ("PATCH", "/api/workspace/security"),
        ("GET", "/api/auth/mfa"),
    }
)
_SESSION_QUERY = {
    "limit": 4,
    "offset": 0,
    "search": "",
    "sort_by": "refreshed_at",
    "sort_order": "desc",
    "status": "all",
    "device": "all",
}


def organization_settings(dataset: SampleDataset) -> dict[str, str]:
    identity = dataset.organization.identity
    currency = {"₱": "PHP", "£": "GBP"}.get(identity.currency_symbol)
    if currency is None:
        raise ValueError("The pack currency symbol has no declared ISO currency")
    return {
        "display_name": identity.workspace_name,
        "locale": identity.locale,
        "timezone": identity.timezone,
        "currency": currency,
        "mark": "".join(word[0].upper() for word in identity.workspace_name.split())[:32],
        "week_start": "monday",
        "business_hours": "09:00–18:00",
    }


def _primary_keys(dataset: SampleDataset) -> tuple[str, ...]:
    return tuple(
        sorted(
            p.key
            for p in dataset.organization.actors.people
            if p.role == "member" and p.status == "active"
        )
    )


def _shared_primary_keys(dataset: SampleDataset) -> tuple[str, ...]:
    """Primary members who joined the partner organization before the bulk revocation."""
    from operations.sample.controls.comms_structure import plan_structure_controls

    keys = {plan_account_controls(dataset)[0].actor_key}
    for action in plan_structure_controls(dataset):
        listed = action.values.get("member_keys")
        if partner_action(action.values) and isinstance(listed, list):
            keys |= {key for key in listed if isinstance(key, str)}
    return tuple(sorted(keys & set(_primary_keys(dataset))))


def _revoked_primary_keys(dataset: SampleDataset) -> tuple[str, ...]:
    shared = set(_shared_primary_keys(dataset))
    return tuple(key for key in _primary_keys(dataset) if key not in shared)


def plan_manage_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = plan_account_controls(dataset)[0].actor_key
    # The pack administrator revokes; accounts shared with another organization keep sessions.
    revoke_checks = 5 + len(_primary_keys(dataset)) + len(_revoked_primary_keys(dataset))
    specs: tuple[tuple[str, str, int, dict[str, PhaseJsonValue]], ...] = (
        ("review_workspace_security", "admin", 200, {"read_checks": 1}),
        # Installation-wide security fields need the installation owner.
        (
            "update_workspace_security",
            OPERATOR,
            200,
            {"read_checks": 3, "policy_restored": True},
        ),
        ("review_mfa_status", member, 200, {"read_checks": 1, "mfa_optional": True}),
        ("review_admin_sessions", "admin", 200, {"read_checks": 2}),
        (
            "revoke_admin_sessions",
            "admin",
            204,
            {
                "read_checks": revoke_checks,
                "sessions_revoked": True,
                "primary_sessions_authenticated": True,
                "shared_sessions_kept": True,
            },
        ),
    )
    return tuple(
        PhaseAction(
            key="control:" + operation.replace("_", "-"),
            phase="reorganization",
            kind="manage_controls",
            actor_key=actor,
            target_key=actor
            if actor not in {"admin", OPERATOR}
            else "control:admin-sessions"
            if operation in {"review_admin_sessions", "revoke_admin_sessions"}
            else "control:workspace-security",
            values={"operation": operation},
            expected_status=status,
            expected_detail=None,
            expected_end_state=end_state,
        )
        for operation, actor, status, end_state in specs
    )


def manage_request_contract(
    action: PhaseAction, dataset: SampleDataset
) -> dict[str, tuple[str, str, str, int]]:
    operation = action.values.get("operation")
    if operation == "update_workspace_security":
        return {
            step: (OPERATOR, "PATCH", "/api/workspace/security", 200)
            for step in ("update_workspace_security", "restore_workspace_security")
        }
    if operation == "revoke_admin_sessions":
        return {
            "revoke_admin_sessions": ("admin", "DELETE", "/api/auth/admin-sessions", 204),
            **{
                f"reauth:{key}": (key, "POST", "/api/auth/login", 200)
                for key in _revoked_primary_keys(dataset)
            },
        }
    return {}


def execute_manage_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_manage_controls(dataset):
        raise SamplePhaseActionError(
            "Manage action differs from the pack-derived plan", step=action.key
        )
    evidence: list[dict[str, object]] = []
    checks = 0

    def read(
        path: str,
        *,
        actor: str = action.actor_key,
        params: Mapping[str, Any] | None = None,
        refresh_first: bool = True,
    ) -> dict[str, Any]:
        nonlocal checks
        body = _request_object(
            action,
            context,
            evidence,
            actor_key=actor,
            path=path,
            step=f"read:{checks + 1}",
            params=params,
            on_substep=on_substep,
            refresh_first=refresh_first,
        )
        checks += 1
        return body

    def write(
        step: str,
        actor: str,
        method: str,
        path: str,
        expected: int,
        body: Mapping[str, Any] | None = None,
        credential: SampleActorCredential | None = None,
    ) -> dict[str, Any]:
        if on_substep is not None:
            on_substep(step)
        client = _client(context, actor, step=step)
        response = (
            client.login(credential.email, credential.password)
            if credential
            else client.request(method, path, json_body=body)
        )
        request_id = _request_id(response)
        if response.status_code != expected or request_id is None:
            raise SamplePhaseActionError(
                "Manage write did not match its planned result",
                step=step,
                status_code=response.status_code,
                request_id=request_id,
            )
        evidence.append(
            {
                "step": step,
                "actor_key": actor,
                "actor_id": _id(context.user_ids, actor, label="actor", step=step),
                "method": method,
                "path": path,
                "expected_status": expected,
                "status_code": response.status_code,
                "request_id": request_id,
            }
        )
        if expected == 204:
            return dict(response.headers)
        from operations.sample.phases.actions import _read_json

        return _read_json(response, step=step, request_id=request_id)

    def policy(body: dict[str, Any]) -> dict[str, Any]:
        import json

        try:
            return WorkspaceSecurityResponse.model_validate_json(
                json.dumps(body), strict=True
            ).model_dump()
        except ValidationError:
            raise SamplePhaseActionError(
                "Workspace security response is invalid", step=action.key
            ) from None

    def sessions(params: Mapping[str, Any], *, complete: bool = False) -> list[dict[str, Any]]:
        import json

        body = read("/api/auth/admin-sessions", params=params)
        try:
            page = AdminSessionCollectionResponse.model_validate_json(json.dumps(body), strict=True)
        except ValidationError:
            raise SamplePhaseActionError(
                "Administrator session page is invalid", step=action.key
            ) from None
        metadata = page.pagination
        if (
            metadata.limit != params["limit"]
            or metadata.offset != params["offset"]
            or metadata.count != len(page.items)
            or metadata.total < metadata.offset + metadata.count
            or metadata.has_more != (metadata.offset + metadata.count < metadata.total)
            or (complete and (metadata.total != metadata.count or metadata.has_more))
            or len({row.id for row in page.items}) != len(page.items)
        ):
            raise SamplePhaseActionError(
                "Administrator session pagination is incomplete or ambiguous", step=action.key
            )
        return [row.model_dump(mode="json") for row in page.items]

    operation = action.values["operation"]
    extra: dict[str, object] = {}
    if operation == "review_workspace_security":
        policy(read("/api/workspace/security"))
    elif operation == "update_workspace_security":
        original = policy(read("/api/workspace/security"))
        if (
            any(original[f"mfa_require_{role}"] for role in ("admin", "member", "guest"))
            or original["ip_allow_list"] != []
        ):
            raise SamplePhaseActionError(
                "Sample security baseline could restrict actor access", step=action.key
            )
        changes: dict[str, Any] = {
            "session_timeout_minutes": 30 if original["session_timeout_minutes"] != 30 else 60,
            "session_retention_days": 367 if original["session_retention_days"] == 366 else 366,
            "security_event_retention_days": 731
            if original["security_event_retention_days"] == 730
            else 730,
            "password_min_length": 20,
            "password_require_mixed_case": False,
            "password_require_number": False,
            "mfa_require_admin": False,
            "mfa_require_member": False,
            "mfa_require_guest": False,
            "ip_allow_list": [],
        }
        updated = policy(
            write(
                "update_workspace_security",
                action.actor_key,
                "PATCH",
                "/api/workspace/security",
                200,
                {"revision": original["revision"], **changes},
            )
        )
        expected = {**original, **changes, "revision": original["revision"] + 1}
        saved = policy(read("/api/workspace/security"))
        if updated != expected or saved != expected:
            raise SamplePhaseActionError(
                "Workspace security update was not persisted", step=action.key
            )
        restored = policy(
            write(
                "restore_workspace_security",
                action.actor_key,
                "PATCH",
                "/api/workspace/security",
                200,
                {**original, "revision": saved["revision"]},
            )
        )
        final = policy(read("/api/workspace/security"))
        if restored != {**original, "revision": original["revision"] + 2} or final != restored:
            raise SamplePhaseActionError(
                "Workspace security policy was not restored", step=action.key
            )
        extra["policy_restored"] = True
    elif operation == "review_mfa_status":
        body = read("/api/auth/mfa")
        if (
            body.get("user_id")
            != _id(context.user_ids, action.actor_key, label="MFA actor", step=action.key)
            or body.get("assurance_level") != "aal1"
            or body.get("required") is not False
            or body.get("factors") != []
        ):
            raise SamplePhaseActionError(
                "Sample MFA status differs from the unenrolled actor", step=action.key
            )
        extra["mfa_optional"] = True
    elif operation == "review_admin_sessions":
        if not sessions(_SESSION_QUERY):
            raise SamplePhaseActionError(
                "Administrator session review has no active sessions", step=action.key
            )
        person = next(
            p
            for p in dataset.organization.actors.people
            if p.key == plan_account_controls(dataset)[0].actor_key
        )
        filtered = sessions(
            {
                **_SESSION_QUERY,
                "search": person.name,
                "sort_by": "person_name",
                "sort_order": "asc",
                "status": "remote",
                "device": "Unknown",
            }
        )
        if not filtered or any(
            row["current"]
            or row["device"] != "Unknown"
            or person.name.lower() not in row["person_name"].lower()
            for row in filtered
        ):
            raise SamplePhaseActionError(
                "Administrator session filters differ from their request", step=action.key
            )
    elif operation == "revoke_admin_sessions":
        from operations.sample.controls.manage_sessions import revoke_admin_sessions

        extra.update(revoke_admin_sessions(action, dataset, context, read, write, sessions))
    extra["read_checks"] = checks
    return _result(action, context, evidence, [], extra=extra)
