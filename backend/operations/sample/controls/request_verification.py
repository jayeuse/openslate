"""Request shape, status, actor and outcome evidence for sample control journeys."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from operations.sample.blueprint import SampleDataset
from operations.sample.packs.phase_types import PhaseAction

_REVIEW_READ_CHECKS = {
    "review_workspace_appearance": 3,
    "review_view_fields": 4,
    "review_report_run": 2,
    "review_board_tools": 9,
    "review_my_events": 1,
    "review_member_candidates": 1,
}
_REVOKE_USER_SESSIONS = "revoke_user_sessions"
_REPEATABLE_PURGE_REVIEWS = {
    ("record_lifecycle", "preview_purge_record"),
    ("relationship_delete", "preview_purge_relationship_source"),
    ("relationship_delete", "preview_purge_relationship_target"),
}
_EVIDENCE_KEYS = {
    "step",
    "actor_key",
    "actor_id",
    "method",
    "path",
    "expected_status",
    "status_code",
    "request_id",
    "primary_entity_type",
    "primary_entity_id",
    "primary_action",
    "expected_audit_rows",
    "related_entity_types",
}


def _canonical_uuid(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        canonical = str(UUID(value))
    except ValueError:
        return None
    return canonical if canonical == value else None


def _repeatable_purge_review(
    action: PhaseAction, previous: Mapping[str, Any], item: Mapping[str, Any]
) -> bool:
    from operations.sample.verification.route_coverage import route_template

    operation, step = action.values.get("operation"), item.get("step")
    return (
        action.kind == "openview_controls"
        and isinstance(operation, str)
        and isinstance(step, str)
        and (operation, step) in _REPEATABLE_PURGE_REVIEWS
        and item.get("method") == "POST"
        and isinstance(item.get("path"), str)
        and route_template("POST", item["path"]) == "/api/records/{record_id}/purge/preview"
        and item.get("expected_status") == item.get("status_code") == 200
        and all(
            previous.get(key) == item.get(key)
            for key in ("actor_key", "actor_id", "method", "path", "expected_status", "status_code")
        )
    )


def _revoke_target_id(
    action: PhaseAction,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    issues: list[str],
) -> str | None:
    from operations.sample.controls.account import plan_account_controls
    from operations.sample.phases.plan import plan_phases

    actors, people = manifest.get("actor_ids"), manifest.get("people")
    mappings = manifest.get("mappings")
    user_mappings = mappings.get("user") if isinstance(mappings, Mapping) else None
    person_data = people.get(action.target_key) if isinstance(people, Mapping) else None
    target_id = user_mappings.get(action.target_key) if isinstance(user_mappings, Mapping) else None
    target_actor_id = actors.get(action.target_key) if isinstance(actors, Mapping) else None
    target_actor_keys = (
        [key for key, value in actors.items() if value == target_id]
        if isinstance(actors, Mapping)
        else []
    )
    dataset_person = next(
        (
            person
            for person in dataset.organization.actors.people
            if person.key == action.target_key
        ),
        None,
    )
    account_actions = plan_account_controls(dataset)
    account_actor = account_actions[0].actor_key if account_actions else None
    phase_people = {
        key for phase in plan_phases(dataset) for key in (phase.actor_key, phase.target_key)
    }
    if (
        dataset_person is None
        or dataset_person.role != "member"
        or dataset_person.status != "active"
        or action.target_key == account_actor
        or action.target_key in phase_people
        or not isinstance(person_data, Mapping)
        or person_data.get("role") != "member"
        or person_data.get("status") != "active"
        or _canonical_uuid(target_id) is None
        or target_id == admin_id
        or target_actor_id != target_id
        or target_actor_keys != [action.target_key]
        or person_data.get("user_id") != target_id
    ):
        issues.append("Bulk session revocation target is not an eligible mapped member")
        return None
    return target_id


def _validate_revoke_descriptor(
    action: PhaseAction,
    evidence_rows: list[Any],
    target_id: str | None,
    issues: list[str],
) -> bool:
    if (
        action.key != "control:revoke-user-sessions"
        or action.actor_key != "admin"
        or action.expected_status != 204
        or action.expected_end_state != {"sessions_revoked": True}
        or action.values != {"operation": _REVOKE_USER_SESSIONS}
    ):
        issues.append("Bulk session revocation action differs from its contract")
        return False
    expected: dict[str, object] = {
        "step": _REVOKE_USER_SESSIONS,
        "actor_key": "admin",
        "actor_id": None,
        "method": "DELETE",
        "path": f"/api/users/{target_id}/sessions" if target_id else None,
        "expected_status": 204,
        "status_code": 204,
        "request_id": None,
    }
    if len(evidence_rows) != 1 or not isinstance(evidence_rows[0], Mapping):
        issues.append("Bulk session revocation has no unique request descriptor")
        return False
    descriptor = evidence_rows[0]
    if (
        set(descriptor) - _EVIDENCE_KEYS
        or any(descriptor.get(key) != value for key, value in expected.items() if value is not None)
        or descriptor.get("actor_id") is None
        or _canonical_uuid(descriptor.get("actor_id")) is None
        or _canonical_uuid(descriptor.get("request_id")) is None
    ):
        issues.append("Bulk session revocation request descriptor differs from its contract")
        return False
    return True


def verify_request_evidence(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    actors: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.verification.route_coverage import SEEDER_ROUTES, route_template

    if action.values.get("operation") == "self_email_change":
        from operations.sample.controls.email_change_verification import (
            verify_email_change_evidence,
        )

        verify_email_change_evidence(
            dataset, action, result, actors, admin_id, seen_request_ids, observed, issues
        )
        return

    if action.kind == "jobs_controls":
        from operations.sample.controls.jobs_verification import verify_job_evidence

        verify_job_evidence(
            dataset, manifest, action, result, admin_id, seen_request_ids, observed, issues
        )
        return

    if action.values.get("operation") == "chart_lifecycle":
        from operations.sample.controls.charts_verification import verify_chart_evidence

        verify_chart_evidence(
            dataset, manifest, action, result, admin_id, seen_request_ids, observed, issues
        )
        return

    evidence_rows = result.get("request_evidence")
    if not isinstance(evidence_rows, list):
        issues.append("A sample control result has invalid request evidence")
        return
    operation = action.values.get("operation")
    if operation == "physical_backup_export":
        from operations.sample.controls.host_delivery import plan_host_controls
        from operations.sample.controls.host_receipts import host_request_contract

        try:
            contract = host_request_contract(action, result)
            optional = {
                "restore_actor_role",
                *("restore_group:" + g for g in result["original_actor_group_ids"]),
            }
            host_steps = [row["step"] for row in evidence_rows]
            if (
                action not in plan_host_controls(dataset)
                or any(
                    result.get(key) is not value for key, value in action.expected_end_state.items()
                )
                or len(set(host_steps)) != len(host_steps)
                or not set(contract) - optional <= set(host_steps) <= set(contract)
            ):
                raise ValueError
            identifiers: set[str] = set()
            for row in evidence_rows:
                actor, host_method, host_path, status = contract[row["step"]]
                identifier = _canonical_uuid(row["request_id"])
                if (
                    set(row)
                    != {
                        "step",
                        "actor_key",
                        "actor_id",
                        "method",
                        "path",
                        "expected_status",
                        "status_code",
                        "request_id",
                    }
                    or (row["actor_key"], row["method"], row["path"], row["status_code"])
                    != (actor, host_method, host_path, status)
                    or type(row["status_code"]) is not int
                    or type(row["expected_status"]) is not int
                    or row["expected_status"] != status
                    or row["actor_id"] != (admin_id if actor == "admin" else actors.get(actor))
                    or _canonical_uuid(row["actor_id"]) is None
                    or (host_method, route_template(host_method, host_path)) not in SEEDER_ROUTES
                    or identifier is None
                    or identifier in identifiers | seen_request_ids
                ):
                    raise ValueError
                identifiers.add(identifier)
        except (KeyError, TypeError, ValueError):
            issues.append(
                "Host control evidence differs from its route or request identity contract"
            )
            return
        seen_request_ids.update(identifiers)
        observed["control_requests_verified"] += len(identifiers)
        return
    if operation == "real_mfa_reset":
        from operations.sample.controls.mfa_verification import verify_mfa_request_evidence

        verify_mfa_request_evidence(
            dataset, manifest, action, result, actors, admin_id, seen_request_ids, observed, issues
        )
        return
    from operations.sample.controls.files import FILE_OPERATIONS
    from operations.sample.controls.files_verification import verify_file_evidence
    from operations.sample.controls.notifications_verification import verify_notification_evidence
    from operations.sample.controls.people_security_verification import (
        verify_people_security_evidence,
    )

    evidence_verifier = (
        verify_file_evidence
        if operation in FILE_OPERATIONS
        else verify_notification_evidence
        if operation == "review_notifications"
        else verify_people_security_evidence
        if operation == "review_people_security"
        else None
    )
    if evidence_verifier is not None:
        evidence_verifier(
            dataset, manifest, action, result, admin_id, seen_request_ids, observed, issues
        )
        return
    if action.kind == "platform_controls":
        from operations.sample.controls.platform_verification import verify_platform_evidence

        verify_platform_evidence(
            dataset, manifest, action, result, admin_id, seen_request_ids, observed, issues
        )
        return
    target_id: str | None = None
    manage_steps: dict[str, tuple[str, str, str, int]] = {}
    if action.kind in {"manage_controls", "backup_controls"}:
        if action.kind == "manage_controls":
            from operations.sample.controls.manage import (
                manage_request_contract,
                plan_manage_controls,
            )

            expected_actions = plan_manage_controls(dataset)
            manage_steps = manage_request_contract(action, dataset)
        else:
            from operations.sample.controls.backups import (
                backup_request_contract,
                plan_backup_controls,
            )

            expected_actions = plan_backup_controls(dataset)
            manage_steps = backup_request_contract(action)
        if (
            action not in expected_actions
            or any(
                type(result.get(key)) is not type(value) or result.get(key) != value
                for key, value in action.expected_end_state.items()
            )
            or [row.get("step") if isinstance(row, Mapping) else None for row in evidence_rows]
            != list(manage_steps)
            or any(
                not isinstance(row, Mapping)
                or set(row)
                != {
                    "step",
                    "actor_key",
                    "actor_id",
                    "method",
                    "path",
                    "expected_status",
                    "status_code",
                    "request_id",
                }
                or (
                    row.get("actor_key"),
                    row.get("method"),
                    row.get("path"),
                    row.get("expected_status"),
                )
                != manage_steps[row["step"]]
                for row in evidence_rows
            )
        ):
            issues.append(
                "Manage or backup control evidence or end state differs from its route contract"
            )
            return
    elif action.kind == "read_controls":
        expected_checks = _REVIEW_READ_CHECKS.get(operation) if isinstance(operation, str) else None
        if operation == _REVOKE_USER_SESSIONS:
            expected_checks = 2
            target_id = _revoke_target_id(action, dataset, manifest, admin_id, issues)
            if not _validate_revoke_descriptor(action, evidence_rows, target_id, issues):
                return
        elif (
            expected_checks is None
            or type(action.expected_end_state.get("read_checks")) is not int
            or action.expected_end_state.get("read_checks") != expected_checks
            or evidence_rows != []
        ):
            issues.append("Read-only control read checks or request evidence differ from its plan")
            return
        if (
            type(result.get("read_checks")) is not int
            or result.get("read_checks") != expected_checks
        ):
            issues.append("Sample control read check count differs from its planned journey")
            return
        if operation == _REVOKE_USER_SESSIONS and result.get("sessions_revoked") is not True:
            issues.append("Bulk session revocation result does not confirm its end state")
            return
    elif action.kind != "audit_controls" and not evidence_rows:
        issues.append("A sample control result has no recorded request evidence")
        return

    admin_steps_value = action.values.get("admin_steps", [])
    if (
        not isinstance(admin_steps_value, list)
        or any(not isinstance(step, str) or not step for step in admin_steps_value)
        or len(admin_steps_value) != len(set(admin_steps_value))
    ):
        issues.append("A sample control admin-step declaration is invalid")
        return
    admin_steps = tuple(admin_steps_value)
    steps: dict[str, Mapping[str, Any]] = {}
    for item in evidence_rows:
        if not isinstance(item, Mapping):
            issues.append("A sample control request descriptor is invalid")
            continue
        step = item.get("step")
        method = item.get("method")
        path = item.get("path")
        expected_status = item.get("expected_status")
        status_code = item.get("status_code")
        request_id = _canonical_uuid(item.get("request_id"))
        valid = True
        if (
            not isinstance(step, str)
            or not step
            or (step in steps and not _repeatable_purge_review(action, steps[step], item))
        ):
            issues.append("A sample control request step is missing or duplicated")
            valid = False
        else:
            steps[step] = item
        template = (
            route_template(method, path)
            if isinstance(method, str) and isinstance(path, str)
            else None
        )
        if (
            not isinstance(method, str)
            or method != method.upper()
            or method
            not in (
                {"GET", "POST", "PATCH"}
                if action.kind == "backup_controls"
                else {"POST", "PUT", "PATCH", "DELETE"}
            )
            or not isinstance(path, str)
            or not path.startswith("/api/")
            or template is None
            or (method, template) not in SEEDER_ROUTES
        ):
            issues.append(
                "A sample control request route is unknown or outside its allowed methods"
            )
            valid = False
        if (
            type(expected_status) is not int
            or not 200 <= expected_status < 300
            or type(status_code) is not int
            or status_code != expected_status
        ):
            issues.append("A sample control request status is invalid or unsuccessful")
            valid = False
        if request_id is None:
            issues.append("A sample control request ID is invalid or noncanonical")
            valid = False
        elif request_id in seen_request_ids:
            issues.append("Sample control requests reuse a request ID")
            valid = False
        else:
            seen_request_ids.add(request_id)

        if not isinstance(step, str):
            expected_actor_key, expected_actor_id = action.actor_key, None
        else:
            expected_actor_key = (
                manage_steps[step][0]
                if action.kind in {"manage_controls", "backup_controls"}
                else "admin"
                if step in admin_steps
                else action.actor_key
            )
            actor_id_value = (
                admin_id if expected_actor_key == "admin" else actors.get(expected_actor_key)
            )
            expected_actor_id = actor_id_value if isinstance(actor_id_value, str) else None
        if (
            expected_actor_id is None
            or _canonical_uuid(expected_actor_id) is None
            or item.get("actor_key") != expected_actor_key
            or item.get("actor_id") != expected_actor_id
        ):
            issues.append("A sample control request actor differs from its planned step")
            valid = False

        if valid:
            observed["control_requests_verified"] += 1
