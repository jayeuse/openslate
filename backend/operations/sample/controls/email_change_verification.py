"""API-only email restoration and strict, non-private request/confirmation receipts."""

from collections.abc import Mapping
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.email_change import (
    EMAIL_READS,
    EMAIL_WRITES,
    plan_email_change_controls,
)
from operations.sample.controls.request_verification import _canonical_uuid
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError, _read_json

_RECEIPT_KEYS = {
    "step", "actor_key", "actor_id", "method", "path",
    "status_code", "expected_status", "request_id",
}


def verify_email_change_evidence(
    dataset: SampleDataset,
    action: PhaseAction,
    result: Mapping[str, Any],
    actors: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.verification.route_coverage import SEEDER_ROUTES, route_template

    actor_id = actors.get(action.actor_key)
    confirmations = [
        {"step": "confirm_current_email", "authenticated": False, "confirmation_required": True},
        {"step": "confirm_new_email", "authenticated": True, "confirmation_required": False,
         "setup_required": False},
        {"step": "confirm_temporary_email", "authenticated": False, "confirmation_required": True},
        {"step": "confirm_original_email", "authenticated": True, "confirmation_required": False,
         "setup_required": False},
    ]
    received = result.get("confirmation_results")
    identifiers: set[str] = set()
    try:
        if (
            action not in plan_email_change_controls(dataset)
            or _canonical_uuid(actor_id) is None or actor_id == admin_id
            or result.get("action_key") != action.key or result.get("kind") != action.kind
            or result.get("actor_key") != action.actor_key or result.get("actor_id") != actor_id
            or result.get("target_key") != action.target_key or result.get("status") != "complete"
            or any(result.get(key) is not value for key, value in action.expected_end_state.items())
            or result.get("mappings") != [] or not isinstance(received, list)
            or received != confirmations
            or any(
                type(value) is not bool
                for row in received for key, value in row.items() if key != "step"
            )
        ):
            raise ValueError
        for field, contract in (("request_evidence", EMAIL_WRITES), ("read_evidence", EMAIL_READS)):
            rows = result.get(field)
            if not isinstance(rows, list) or [
                row.get("step") if isinstance(row, Mapping) else None for row in rows
            ] != list(contract):
                raise ValueError
            for row in rows:
                method, path, status = contract[row["step"]]
                identifier = _canonical_uuid(row.get("request_id"))
                if (
                    set(row) != _RECEIPT_KEYS
                    or (row.get("method"), row.get("path")) != (method, path)
                    or type(row.get("status_code")) is not int or row["status_code"] != status
                    or type(row.get("expected_status")) is not int
                    or row["expected_status"] != status
                    or row.get("actor_key") != action.actor_key or row.get("actor_id") != actor_id
                    or identifier is None or identifier in identifiers | seen_request_ids
                    or (method, route_template(method, path)) not in SEEDER_ROUTES
                ):
                    raise ValueError
                identifiers.add(identifier)
    except (KeyError, TypeError, ValueError):
        issues.append("Email change request, confirmation or restoration evidence is invalid")
        return
    seen_request_ids.update(identifiers)
    observed["control_requests_verified"] += len(identifiers)


def verify_email_change_controls(
    admin: SampleClient, dataset: SampleDataset, manifest: Mapping[str, Any], admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    counts = {"email_change_controls": 0, "email_change_control_requests": 0}
    observed = {"control_requests_verified": 0}
    issues: list[str] = []
    action = plan_email_change_controls(dataset)[0]
    raw = manifest.get("control_results")
    results = (
        [row for row in raw if isinstance(row, Mapping) and row.get("action_key") == action.key]
        if isinstance(raw, list) else []
    )
    actors = manifest.get("actor_ids")
    if len(results) != 1 or not isinstance(actors, Mapping):
        return counts, ["Email change execution evidence is missing or duplicated"]
    verify_email_change_evidence(
        dataset, action, results[0], actors, admin_id, set(), observed, issues
    )
    if issues:
        return counts, issues
    actor_id = actors[action.actor_key]
    person = next(
        person for person in dataset.organization.actors.people if person.key == action.actor_key
    )
    try:
        response = admin.request("GET", f"/api/users/{actor_id}")
        body = _read_json(response, step="verify_email_change")
        if (
            response.status_code != 200 or body.get("id") != actor_id
            or body.get("email") != person.email or body.get("role") != "member"
            or body.get("status") != "active" or body.get("is_deleted") is not False
        ):
            raise ValueError
    except (SampleClientError, SamplePhaseActionError, ValueError):
        return counts, ["Email change original member identity was not restored"]
    counts["email_change_controls"] = 1
    counts["email_change_control_requests"] = observed["control_requests_verified"]
    return counts, []
