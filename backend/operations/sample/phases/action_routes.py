"""Access, Board and OpenView route steps for a recorded phase action."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _request,
    _request_id,
    _result,
)


def _group_snapshot(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    group_id: str,
    *,
    on_substep: PhaseSubstep | None,
) -> tuple[dict[str, Any], str]:
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="GET",
        path=f"/api/access/groups/{group_id}",
        step="read_group",
        expected=200,
        on_substep=on_substep,
    )
    body = _read_json(response, step="read_group", request_id=_request_id(response))
    revision = body.get("revision")
    etag = response.headers.get("ETag")
    if body.get("id") != group_id or type(revision) is not int or not etag:
        raise SamplePhaseActionError("Group revision could not be read", step="read_group")
    if etag != f'"{group_id}:{revision}"':
        raise SamplePhaseActionError("Group ETag did not match its revision", step="read_group")
    return body, etag


def _planned_access_rows(
    raw_rows: object,
    context: PhaseExecutionContext,
    *,
    step: str,
) -> tuple[tuple[str, str | None, str], ...]:
    if not isinstance(raw_rows, list):
        raise SamplePhaseActionError("Planned group access is invalid", step=step)
    rows: list[tuple[str, str | None, str]] = []
    for row in raw_rows:
        if not isinstance(row, Mapping):
            raise SamplePhaseActionError("Planned group access is invalid", step=step)
        department_key = row.get("department_key")
        module_key = row.get("module_key")
        level = row.get("level")
        if (
            not isinstance(department_key, str)
            or not isinstance(level, str)
            or level not in {"read", "write", "manage"}
            or (module_key is not None and not isinstance(module_key, str))
        ):
            raise SamplePhaseActionError("Planned group access is invalid", step=step)
        department_id = _id(
            context.department_ids,
            department_key,
            label="department",
            step=step,
        )
        module_id = (
            None
            if module_key is None
            else _id(
                context.module_ids,
                str(module_key),
                label="module",
                step=step,
            )
        )
        rows.append((department_id, module_id, level))
    return tuple(sorted(rows, key=lambda item: (item[0], item[1] or "", item[2])))


def _live_access_rows(raw_rows: object, *, step: str) -> tuple[tuple[str, str | None, str], ...]:
    if not isinstance(raw_rows, list):
        raise SamplePhaseActionError("Current group access could not be read", step=step)
    rows: list[tuple[str, str | None, str]] = []
    for row in raw_rows:
        if not isinstance(row, Mapping):
            raise SamplePhaseActionError("Current group access could not be read", step=step)
        department_id = row.get("department_id")
        module_id = row.get("module_id")
        level = row.get("level")
        if not isinstance(department_id, str) or not isinstance(level, str):
            raise SamplePhaseActionError("Current group access could not be read", step=step)
        department_id = _id(
            {"department": department_id}, "department", label="department", step=step
        )
        normalized_module_id = (
            None
            if module_id is None
            else _id({"module": str(module_id)}, "module", label="module", step=step)
        )
        rows.append((department_id, normalized_module_id, level))
    return tuple(sorted(rows, key=lambda item: (item[0], item[1] or "", item[2])))


def _updated_group(
    response: Any,
    group_id: str,
    old_revision: int,
    *,
    step: str,
) -> dict[str, Any]:
    body = _read_json(response, step=step, request_id=_request_id(response))
    revision = body.get("revision")
    if (
        body.get("id") != group_id
        or type(revision) is not int
        or revision != old_revision + 1
        or response.headers.get("ETag") != f'"{group_id}:{revision}"'
    ):
        raise SamplePhaseActionError("Group update response did not match its revision", step=step)
    return body


def _access_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    kind = action.kind
    mappings: list[dict[str, str]] = []

    if kind in {
        "refuse_role_change",
        "promote_user",
        "demote_user",
        "disable_user",
        "restore_disabled_user",
    }:
        user_id = _mapped_id(context, "user", action.target_key, step="update_user")
        path = f"/api/users/{user_id}"
        if kind in {"refuse_role_change", "promote_user", "demote_user"}:
            body = {"role": action.values["role"]}
        else:
            body = {"status": action.values["status"]}
        refusal = kind == "refuse_role_change"
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="PATCH",
            path=path,
            step="update_user",
            expected=action.expected_status,
            on_substep=on_substep,
            json_body=body,
            expected_detail=action.expected_detail if refusal else None,
            # A role lives on the membership (S04); status stays on the account.
            primary_entity_type=None
            if refusal
            else "memberships"
            if kind in {"promote_user", "demote_user"}
            else "users",
            primary_entity_id=None
            if refusal or kind in {"promote_user", "demote_user"}
            else user_id,
            primary_action=None if refusal else "update",
            expected_audit_rows=0 if refusal else 1,
            related_entity_types=("groups", "group_members")
            if kind == "promote_user"
            else ("identity_sessions",)
            if kind == "disable_user"
            else (),
        )
        return _result(
            action,
            context,
            evidence,
            mappings,
            outcome="refused" if refusal else "completed",
        )

    if kind in {"remove_group_member", "add_group_member", "replace_group_access"}:
        if kind == "remove_group_member":
            group_key = str(action.values["source_group_key"])
        elif kind == "add_group_member":
            group_key = str(action.values["destination_group_key"])
        else:
            group_key = action.target_key
        group_id = _id(context.group_ids, group_key, label="group", step="read_group")
        current, etag = _group_snapshot(action, context, evidence, group_id, on_substep=on_substep)
        headers = {"If-Match": etag}
        related: tuple[str, ...] = ()
        if kind in {"remove_group_member", "add_group_member"}:
            raw_members = current.get("member_ids")
            if not isinstance(raw_members, list) or any(
                not isinstance(item, str) for item in raw_members
            ):
                raise SamplePhaseActionError("Group members could not be read", step="read_group")
            member_id = _mapped_id(context, "user", action.target_key, step="replace_group_members")
            members = set(raw_members)
            if kind == "remove_group_member":
                if member_id not in members:
                    raise SamplePhaseActionError(
                        "Planned source group membership is missing", step="read_group"
                    )
                members.remove(member_id)
            else:
                if member_id in members:
                    raise SamplePhaseActionError(
                        "Planned destination membership already exists", step="read_group"
                    )
                members.add(member_id)
            member_ids = sorted(members)
            response = _request(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                method="PUT",
                path=f"/api/access/groups/{group_id}/members",
                step="replace_group_members",
                expected=200,
                on_substep=on_substep,
                json_body={"member_ids": member_ids},
                headers=headers,
                primary_entity_type="groups",
                primary_entity_id=group_id,
                primary_action="update",
                expected_audit_rows=1,
                related_entity_types=("group_members",),
            )
            updated = _updated_group(
                response,
                group_id,
                int(current["revision"]),
                step="replace_group_members",
            )
            updated_members = updated.get("member_ids")
            if (
                not isinstance(updated_members, list)
                or any(not isinstance(item, str) for item in updated_members)
                or set(updated_members) != set(member_ids)
            ):
                raise SamplePhaseActionError(
                    "Group membership update did not match its plan",
                    step="replace_group_members",
                )
        else:
            expected_before = _planned_access_rows(
                action.values.get("before_access"),
                context,
                step="replace_group_access",
            )
            current_access = _live_access_rows(current.get("access"), step="read_group")
            if current_access != expected_before:
                raise SamplePhaseActionError(
                    "Live group access differs from planned access",
                    step="read_group",
                )
            expected_after = _planned_access_rows(
                action.values.get("access"),
                context,
                step="replace_group_access",
            )
            access = [
                {"department_id": department, "module_id": module, "level": level}
                for department, module, level in expected_after
            ]
            related = ("group_access",)
            response = _request(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                method="PUT",
                path=f"/api/access/groups/{group_id}/access",
                step="replace_group_access",
                expected=200,
                on_substep=on_substep,
                json_body={"access": access},
                headers=headers,
                primary_entity_type="groups",
                primary_entity_id=group_id,
                primary_action="update",
                expected_audit_rows=1,
                related_entity_types=related,
            )
            updated = _updated_group(
                response,
                group_id,
                int(current["revision"]),
                step="replace_group_access",
            )
            if (
                _live_access_rows(updated.get("access"), step="replace_group_access")
                != expected_after
            ):
                raise SamplePhaseActionError(
                    "Group access update did not match its plan",
                    step="replace_group_access",
                )
        return _result(action, context, evidence, mappings)

    if kind == "end_session":
        person_key = action.target_key
        person_id = _mapped_id(context, "user", person_key, step="list_current_sessions")
        sessions_response = _request(
            action,
            context,
            evidence,
            actor_key=person_key,
            method="GET",
            path="/api/auth/sessions",
            step="list_current_sessions",
            expected=200,
            on_substep=on_substep,
        )
        try:
            sessions = sessions_response.json()
        except ValueError:
            raise SamplePhaseActionError(
                "Current sessions were not valid JSON", step="list_current_sessions"
            ) from None
        if not isinstance(sessions, list):
            raise SamplePhaseActionError(
                "Current sessions were not a list", step="list_current_sessions"
            )
        current_session_rows = [
            item for item in sessions if isinstance(item, dict) and item.get("current") is True
        ]
        if len(current_session_rows) != 1 or not isinstance(current_session_rows[0].get("id"), str):
            raise SamplePhaseActionError(
                "Planned person has no unique current session", step="list_current_sessions"
            )
        session_id = _id(
            {"session": current_session_rows[0]["id"]},
            "session",
            label="session",
            step="list_current_sessions",
        )
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=f"/api/users/{person_id}/sessions/{session_id}",
            step="revoke_user_session",
            expected=204,
            on_substep=on_substep,
            expected_audit_rows=0,
        )
        del response
        return _result(action, context, evidence, mappings, extra={"session_id": session_id})

    raise SamplePhaseActionError("Unsupported Access phase action", step=action.key)


def execute_route_phase_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    if action.kind in {
        "refuse_role_change",
        "promote_user",
        "demote_user",
        "remove_group_member",
        "add_group_member",
        "replace_group_access",
        "disable_user",
        "restore_disabled_user",
        "end_session",
    }:
        return _access_action(action, context, evidence, on_substep=on_substep)
    if action.kind in {
        "refuse_board_archive",
        "board_archive",
        "board_restore",
        "board_create_purge_target",
        "board_archive_purge_target",
        "board_purge_preview",
        "board_purge",
    }:
        from operations.sample.phases.action_board import execute_board_action

        return execute_board_action(action, context, evidence, mappings, on_substep=on_substep)
    if action.kind in {"openview_archive", "openview_restore"}:
        from operations.sample.phases.action_openview import execute_openview_action

        return execute_openview_action(action, context, evidence, on_substep=on_substep)
    raise SamplePhaseActionError("Unsupported planned phase action", step=action.key)
