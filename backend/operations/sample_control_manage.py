"""Persisted Manage settings and session controls for either authored pack."""

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from app.systems.access.users.sessions_schemas import AdminSessionCollectionResponse
from app.systems.manage.workspace.security_schemas import WorkspaceSecurityResponse
from operations.sample_blueprint import SampleDataset
from operations.sample_control_account import plan_account_controls
from operations.sample_packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample_people import SampleActorCredential
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _id,
    _request_id,
    _request_object,
    _result,
)

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


def plan_manage_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = plan_account_controls(dataset)[0].actor_key
    specs: tuple[tuple[str, str, int, dict[str, PhaseJsonValue]], ...] = (
        ("review_workspace_security", "admin", 200, {"read_checks": 1}),
        ("update_workspace_security", "admin", 200, {"read_checks": 3, "policy_restored": True}),
        ("review_mfa_status", member, 200, {"read_checks": 1, "mfa_optional": True}),
        ("review_admin_sessions", "admin", 200, {"read_checks": 2}),
        (
            "revoke_admin_sessions",
            "admin",
            204,
            {
                "read_checks": 3 + 2 * len(_primary_keys(dataset)),
                "sessions_revoked": True,
                "primary_sessions_authenticated": True,
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
            if actor != "admin"
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
            step: ("admin", "PATCH", "/api/workspace/security", 200)
            for step in ("update_workspace_security", "restore_workspace_security")
        }
    if operation == "revoke_admin_sessions":
        return {
            "revoke_admin_sessions": ("admin", "DELETE", "/api/auth/admin-sessions", 204),
            **{
                f"reauth:{key}": (key, "POST", "/api/auth/login", 200)
                for key in _primary_keys(dataset)
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
        path: str, *, actor: str = action.actor_key, params: Mapping[str, Any] | None = None
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
            return {}
        from operations.sample_phase_actions import _read_json

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
        if original["mfa_policy"] != "optional" or original["ip_allow_list"] != []:
            raise SamplePhaseActionError(
                "Sample security baseline could restrict actor access", step=action.key
            )
        changes: dict[str, Any] = {
            "session_timeout_minutes": 30 if original["session_timeout_minutes"] != 30 else 60,
            "password_min_length": 20,
            "password_require_mixed_case": False,
            "password_require_number": False,
            "mfa_policy": "optional",
            "ip_allow_list": [],
        }
        updated = policy(
            write(
                "update_workspace_security",
                "admin",
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
                "admin",
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
        raw = context.private_values.get("credentials")
        credentials: dict[str, SampleActorCredential] = {}
        primary = set(context.clients) & set(context.user_ids) - {"admin"}
        if primary != set(_primary_keys(dataset)) or not isinstance(raw, Mapping):
            raise SamplePhaseActionError(
                "Primary actor login prerequisites are incomplete", step=action.key
            )
        for key in sorted(primary):
            value = raw.get(key)
            person = next(p for p in dataset.organization.actors.people if p.key == key)
            actor_id = _id(context.user_ids, key, label="primary actor", step=action.key)
            if (
                not isinstance(value, SampleActorCredential)
                or value.user_id != actor_id
                or value.email != person.email
                or not value.password
                or sum(uid == actor_id for uid in context.user_ids.values()) != 1
            ):
                raise SamplePhaseActionError(
                    "Primary actor credential binding is invalid", step=action.key
                )
            credentials[key] = value
        before = sessions({**_SESSION_QUERY, "limit": 100, "status": "current"})
        admin_id = _id(context.user_ids, "admin", label="administrator", step=action.key)
        if (
            len(before) != 1
            or before[0]["current"] is not True
            or before[0]["user_id"] != admin_id
            or not sessions({**_SESSION_QUERY, "limit": 100, "status": "remote"})
        ):
            raise SamplePhaseActionError(
                "Bulk session revocation has no valid current and remote sessions", step=action.key
            )
        write("revoke_admin_sessions", "admin", "DELETE", "/api/auth/admin-sessions", 204)
        after = sessions({**_SESSION_QUERY, "limit": 100}, complete=True)
        if (
            len(after) != 1
            or after[0]["id"] != before[0]["id"]
            or after[0]["current"] is not True
            or after[0]["user_id"] != admin_id
        ):
            raise SamplePhaseActionError(
                "Bulk session revocation did not preserve only the current administrator",
                step=action.key,
            )
        for key in credentials:
            if read("/api/auth/session", actor=key).get("authenticated") is not False:
                raise SamplePhaseActionError(
                    "A remote primary session remains authenticated", step=action.key
                )
        for key, credential in credentials.items():
            write(f"reauth:{key}", key, "POST", "/api/auth/login", 200, credential=credential)
            identity = read("/api/auth/me", actor=key)
            if (
                identity.get("id") != credential.user_id
                or identity.get("role") != "member"
                or identity.get("status") != "active"
            ):
                raise SamplePhaseActionError(
                    "Primary actor reauthentication resolved another identity", step=action.key
                )
        extra.update({"sessions_revoked": True, "primary_sessions_authenticated": True})
    extra["read_checks"] = checks
    return _result(action, context, evidence, [], extra=extra)
