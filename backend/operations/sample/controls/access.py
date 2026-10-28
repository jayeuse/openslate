"""Planned Access controls for a UI-equivalent sample run."""

from __future__ import annotations

from collections.abc import Callable

from app.systems.access.users.schemas import UserResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.access_verification import _pending_invitation
from operations.sample.controls.access_verification import (
    verify_access_controls as verify_access_controls,
)
from operations.sample.controls.planned_actors import OPERATOR
from operations.sample.packs.phase_types import PhaseAction, PhaseActionKind, PhaseJsonValue
from operations.sample.phases.action_routes import _group_snapshot, _updated_group
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_object,
    _result,
)
from operations.sample.phases.plan import plan_phases

CONTROL_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("POST", "/api/access/groups"),
        ("GET", "/api/access/groups/{group_id}"),
        ("PATCH", "/api/access/groups/{group_id}"),
        ("DELETE", "/api/access/groups/{group_id}"),
        ("DELETE", "/api/users/{user_id}"),
        ("POST", "/api/users/{user_id}/restore"),
        ("POST", "/api/auth/invitations/{user_id}/resend"),
        ("POST", "/api/auth/invitations/{user_id}/reconcile"),
        ("DELETE", "/api/auth/invitations/{user_id}"),
        ("GET", "/api/users/{user_id}"),
        ("GET", "/api/users/{user_id}/access"),
    }
)

_GROUP_KEY = "control_temporary_group"


def _make_action(
    *,
    key: str,
    kind: PhaseActionKind,
    target_key: str,
    operation: str,
    values: dict[str, PhaseJsonValue],
    expected_status: int,
    expected_end_state: dict[str, PhaseJsonValue],
    actor_key: str = "admin",
) -> PhaseAction:
    return PhaseAction(
        key=key,
        phase="admin",
        kind=kind,
        actor_key=actor_key,
        target_key=target_key,
        values={"operation": operation, **values},
        expected_status=expected_status,
        expected_detail=None,
        expected_end_state=expected_end_state,
    )


def _person_targets(dataset: SampleDataset) -> tuple[str, str]:
    people = dataset.organization.actors.people
    phase_people = {
        key for action in plan_phases(dataset) for key in (action.actor_key, action.target_key)
    }
    guests = sorted(
        person.key
        for person in people
        if person.status == "active" and person.role == "guest" and person.key not in phase_people
    )
    pending = sorted(
        person.key for person in people if person.status == "pending" and person.role == "member"
    )
    if not guests or not pending:
        raise ValueError("Access controls require an active guest and a pending member")
    return guests[0], pending[0]


def plan_access_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Plan an empty-group cleanup, guest restoration and invitation lifecycle."""
    guest_key, pending_key = _person_targets(dataset)
    departments = dataset.organization.catalog.departments
    if not departments:
        raise ValueError("Access controls require at least one organization department")
    department_name = departments[0][1]
    original_name = f"{department_name} handover"
    renamed_name = f"{department_name} coordination"
    description = f"Coordinate {department_name.lower()} handovers and agree access for the team."
    return (
        _make_action(
            key="controls:access:create_temporary_group",
            kind="access_controls",
            target_key=_GROUP_KEY,
            operation="create_temporary_group",
            values={"name": original_name, "description": description},
            expected_status=201,
            expected_end_state={"name": original_name, "is_deleted": False},
        ),
        _make_action(
            key="controls:access:rename_temporary_group",
            kind="access_controls",
            target_key=_GROUP_KEY,
            operation="rename_temporary_group",
            values={"before_name": original_name, "name": renamed_name},
            expected_status=200,
            expected_end_state={"name": renamed_name, "is_deleted": False},
        ),
        _make_action(
            key="controls:access:delete_temporary_group",
            kind="access_controls",
            target_key=_GROUP_KEY,
            operation="delete_temporary_group",
            values={"name": renamed_name},
            expected_status=204,
            expected_end_state={"is_deleted": True},
        ),
        _make_action(
            key="controls:access:delete_guest",
            kind="access_controls",
            target_key=guest_key,
            operation="delete_user",
            values={"role": "guest"},
            expected_status=204,
            expected_end_state={"is_deleted": True},
        ),
        _make_action(
            key="controls:access:restore_guest",
            kind="access_controls",
            target_key=guest_key,
            operation="restore_user",
            values={"role": "guest"},
            expected_status=200,
            expected_end_state={"role": "guest", "status": "active", "is_deleted": False},
            # Deleting a single-organization guest removes the account; only the
            # installation owner restores a removed account.
            actor_key=OPERATOR,
        ),
        _make_action(
            key="controls:access:resend_invitation",
            kind="access_controls",
            target_key=pending_key,
            operation="resend_invitation",
            values={},
            expected_status=200,
            expected_end_state={"status": "pending", "invitation_sent": True},
        ),
        _make_action(
            key="controls:access:revoke_invitation",
            kind="access_controls",
            target_key=pending_key,
            operation="revoke_invitation",
            values={},
            expected_status=204,
            expected_end_state={"status": "pending", "invitation_sent": False},
        ),
        _make_action(
            key="controls:access:reconcile_invitation",
            kind="access_controls",
            target_key=pending_key,
            operation="reconcile_invitation",
            values={},
            expected_status=200,
            expected_end_state={"status": "pending", "invitation_sent": True},
        ),
        _make_action(
            key="controls:access:revoke_reconciled_invitation",
            kind="access_controls",
            target_key=pending_key,
            operation="revoke_invitation",
            values={},
            expected_status=204,
            expected_end_state={"status": "pending", "invitation_sent": False},
        ),
    )


def _action_value(action: PhaseAction, name: str) -> str:
    value = action.values.get(name)
    if not isinstance(value, str) or not value:
        raise SamplePhaseActionError("Planned Access value is invalid", step=action.key)
    return value


def _group_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: Callable[[str], None] | None,
) -> dict[str, object]:
    operation = action.values.get("operation")
    client = context.clients.get(action.actor_key)
    if client is None:
        raise SamplePhaseActionError("Planned Access actor is unavailable", step=action.key)
    if operation == "create_temporary_group":
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path="/api/access/groups",
            step="create_temporary_group",
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={
                "name": _action_value(action, "name"),
                "description": _action_value(action, "description"),
            },
            primary_entity_type="groups",
            primary_action="create",
            expected_audit_rows=1,
        )
        body = _read_json(response, step="create_temporary_group")
        group_id = _id(
            {"group": body.get("id")}, "group", label="group", step="create_temporary_group"
        )
        if (
            body.get("name") != action.values.get("name")
            or body.get("revision") != 1
            or response.headers.get("ETag") != f'"{group_id}:1"'
        ):
            raise SamplePhaseActionError(
                "Temporary Access group did not match its plan", step="create_temporary_group"
            )
        evidence[-1]["primary_entity_id"] = group_id
        _record_mapping(context, client, "control_groups", action.target_key, group_id, mappings)
        return _result(action, context, evidence, mappings)

    group_id = _mapped_id(context, "control_groups", action.target_key, step="read_group")
    current, etag = _group_snapshot(action, context, evidence, group_id, on_substep=on_substep)
    if operation == "rename_temporary_group":
        if current.get("name") != action.values.get("before_name"):
            raise SamplePhaseActionError(
                "Temporary Access group changed unexpectedly", step="read_group"
            )
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="PATCH",
            path=f"/api/access/groups/{group_id}",
            step="rename_temporary_group",
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={"name": _action_value(action, "name")},
            headers={"If-Match": etag},
            primary_entity_type="groups",
            primary_entity_id=group_id,
            primary_action="update",
            expected_audit_rows=1,
        )
        updated = _updated_group(
            response, group_id, int(current["revision"]), step="rename_temporary_group"
        )
        if updated.get("name") != action.values.get("name"):
            raise SamplePhaseActionError(
                "Temporary Access group rename did not match", step="rename_temporary_group"
            )
        return _result(action, context, evidence, mappings)

    if operation == "delete_temporary_group":
        if current.get("name") != action.values.get("name"):
            raise SamplePhaseActionError(
                "Temporary Access group changed unexpectedly", step="read_group"
            )
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=f"/api/access/groups/{group_id}",
            step="delete_temporary_group",
            expected=action.expected_status,
            on_substep=on_substep,
            headers={"If-Match": etag},
            primary_entity_type="groups",
            primary_entity_id=group_id,
            primary_action="delete",
            expected_audit_rows=1,
        )
        return _result(action, context, evidence, mappings)
    raise SamplePhaseActionError("Unsupported planned Access group operation", step=action.key)


def _user_action(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: Callable[[str], None] | None,
) -> dict[str, object]:
    user_id = _mapped_id(context, "user", action.target_key, step=action.key)
    operation = action.values.get("operation")
    if operation == "delete_user":
        before_access = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path=f"/api/users/{user_id}/access",
            step="read_user_access_before_delete",
            on_substep=on_substep,
        )
        if before_access.get("user_id") != user_id or before_access.get("role") != "guest":
            raise SamplePhaseActionError(
                "Planned guest access is unavailable", step="read_user_access_before_delete"
            )
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=f"/api/users/{user_id}",
            step="delete_guest",
            expected=action.expected_status,
            on_substep=on_substep,
            primary_entity_type="users",
            primary_entity_id=user_id,
            primary_action="delete",
            expected_audit_rows=1,
        )
        return _result(
            action,
            context,
            evidence,
            mappings,
            extra={"access_before": before_access},
        )
    if operation == "restore_user":
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=f"/api/users/{user_id}/restore",
            step="restore_guest",
            expected=action.expected_status,
            on_substep=on_substep,
            primary_entity_type="users",
            primary_entity_id=user_id,
            primary_action="update",
            expected_audit_rows=1,
        )
        body = _read_json(response, step="restore_guest")
        if (
            body.get("id") != user_id
            or body.get("role") != "guest"
            or body.get("status") != "active"
            or body.get("is_deleted") is not False
        ):
            raise SamplePhaseActionError(
                "Restored guest did not match its plan", step="restore_guest"
            )
        return _result(action, context, evidence, mappings)
    if operation in {"resend_invitation", "reconcile_invitation", "revoke_invitation"}:
        person = next(
            (p for p in dataset.organization.actors.people if p.key == action.target_key), None
        )
        if (
            action.actor_key != "admin"
            or person is None
            or person.role != "member"
            or person.status != "pending"
        ):
            raise SamplePhaseActionError("Planned pending invitation is invalid", step=action.key)
        after_sent = operation != "revoke_invitation"
        root = f"/api/auth/invitations/{user_id}"
        path = f"{root}/{operation.removesuffix('_invitation')}" if after_sent else root

        def checked(raw: object, *, sent: bool) -> UserResponse:
            profile = _pending_invitation(raw, user_id, person.email, person.username, sent=sent)
            if profile is None:
                raise SamplePhaseActionError(
                    "Pending invitation did not match its plan", step=str(operation)
                )
            return profile

        before = checked(
            _request_object(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                path=f"/api/users/{user_id}",
                step=f"read_before_{operation}",
                on_substep=on_substep,
            ),
            sent=operation != "reconcile_invitation",
        )
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST" if after_sent else "DELETE",
            path=path,
            step=str(operation),
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={} if after_sent else None,
            primary_entity_type="users",
            primary_entity_id=user_id,
            primary_action="update",
            expected_audit_rows=1,
        )
        if after_sent:
            body = _read_json(response, step=str(operation))
            checked(body.get("user") if operation == "resend_invitation" else body, sent=True)
        after = checked(
            _request_object(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                path=f"/api/users/{user_id}",
                step=f"read_after_{operation}",
                on_substep=on_substep,
            ),
            sent=after_sent,
        )
        return _result(
            action,
            context,
            evidence,
            mappings,
            extra={
                "invitation_before": before.model_dump(mode="json"),
                "invitation_after": after.model_dump(mode="json"),
            },
        )
    raise SamplePhaseActionError("Unsupported planned Access user operation", step=action.key)


def execute_access_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: Callable[[str], None] | None = None,
) -> dict[str, object]:
    """Execute one planned Access action through authenticated UI APIs."""
    if action.kind != "access_controls":
        raise SamplePhaseActionError("Unsupported planned Access control", step=action.key)
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    if action.values.get("operation") in {
        "create_temporary_group",
        "rename_temporary_group",
        "delete_temporary_group",
    }:
        return _group_action(action, context, evidence, mappings, on_substep=on_substep)
    return _user_action(action, dataset, context, evidence, mappings, on_substep=on_substep)
