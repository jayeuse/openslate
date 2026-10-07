"""Independent sample MFA receipt, security-event and final-state verification."""

import base64
import binascii
import hashlib
import hmac
import struct
from collections.abc import Mapping
from typing import Any, cast
from uuid import UUID

from pydantic import ValidationError

from app.systems.manage.audit.schemas import SecurityEventResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError, _read_json
from operations.sample.verification.core import SampleVerificationError, list_all_rows

# fmt: off
CONTROL_ROUTES = frozenset({
    ("GET", "/api/auth/mfa"), ("POST", "/api/auth/mfa/factors"),
    ("POST", "/api/auth/mfa/factors/{factor_id}/verification"),
    ("DELETE", "/api/auth/mfa/factors/{factor_id}"),
    ("GET", "/api/users/{user_id}/security"), ("POST", "/api/users/{user_id}/mfa/reset"),
    ("GET", "/api/users/{user_id}/sessions"), ("GET", "/api/security-events"),
})
# fmt: on


def _uuid(value: object, step: str) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError
    except ValueError:
        raise SamplePhaseActionError("MFA control identity is invalid", step=step) from None
    return value


def _require(valid: bool, step: str) -> None:
    if not valid:
        raise SamplePhaseActionError("MFA control state differs from its contract", step=step)


def _totp(secret: str, timestamp: float) -> str:
    try:
        key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
        digest = hmac.new(key, struct.pack(">Q", int(timestamp) // 30), hashlib.sha1).digest()
        index = digest[-1] & 15
        number = (struct.unpack(">I", digest[index : index + 4])[0] & 0x7FFFFFFF) % 1_000_000
        return f"{number:06d}"
    except (ValueError, binascii.Error):
        raise SamplePhaseActionError(
            "MFA enrollment material is invalid", step="mfa_verify"
        ) from None


def _factor_inventory(
    body: Mapping[str, Any], user_id: str, step: str
) -> tuple[str, list[dict[str, str]]]:
    raw = body.get("factors")
    _require(
        body.get("user_id") == user_id
        and isinstance(raw, list)
        and body.get("assurance_level") in ("aal1", "aal2"),
        step,
    )
    rows: list[dict[str, str]] = []
    for item in cast(list[Any], raw):
        _require(
            isinstance(item, dict)
            and isinstance(item.get("factor_type"), str)
            and item.get("status") in ("unverified", "verified"),
            step,
        )
        rows.append(
            {
                "id": _uuid(item.get("id"), step),
                "factor_type": item["factor_type"],
                "status": item["status"],
            }
        )
    _require(len({item["id"] for item in rows}) == len(rows), step)
    return body["assurance_level"], sorted(rows, key=lambda row: row["id"])


def _group_members(admin: SampleClient) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for row in list_all_rows(admin, "/api/access/groups"):
        group_id, members = _uuid(row.get("id"), "mfa_groups"), row.get("member_ids")
        _require(group_id not in groups and isinstance(members, list), "mfa_groups")
        ids = [_uuid(item, "mfa_groups") for item in cast(list[Any], members)]
        _require(len(ids) == len(set(ids)), "mfa_groups")
        groups[group_id] = sorted(ids)
    return groups


# fmt: off
_RESULT_KEYS = frozenset({
    "action_key", "kind", "actor_key", "target_key", "actor_id", "target_id", "status",
    "aal1_reset_denied", "factors_removed", "sessions_revoked", "role_groups_restored",
    "primary_sessions_authenticated", "owner_mfa_unchanged", "actor_aal2_observed",
    "target_aal2_observed", "cancelled_factor_id", "actor_factor_id", "target_factor_id",
    "actor_session_ids", "target_session_ids", "original_actor_group_ids",
    "original_target_group_ids", "original_group_members", "owner_factors", "reset_receipt",
    "request_evidence", "mappings",
})
# fmt: on
_REQUEST_KEYS = frozenset(
    {
        "step",
        "actor_key",
        "actor_id",
        "method",
        "path",
        "expected_status",
        "status_code",
        "request_id",
    }
)


def _identifiers(value: object, step: str, minimum: int = 0) -> list[str]:
    _require(isinstance(value, list), step)
    ids = [_uuid(item, step) for item in cast(list[Any], value)]
    _require(len(ids) >= minimum and len(set(ids)) == len(ids), step)
    return ids


def _result(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    admin_id: str,
) -> None:
    actors, mappings = manifest.get("actor_ids"), manifest.get("mappings")
    users = mappings.get("user") if isinstance(mappings, Mapping) else None
    groups = mappings.get("group") if isinstance(mappings, Mapping) else None
    _uuid(admin_id, "mfa_result")
    _require(
        isinstance(actors, Mapping)
        and isinstance(users, Mapping)
        and isinstance(groups, Mapping)
        and set(result) == _RESULT_KEYS,
        "mfa_result",
    )
    actors, users, groups = (
        cast(Mapping[str, Any], actors),
        cast(Mapping[str, Any], users),
        cast(Mapping[str, Any], groups),
    )
    ids = [admin_id]
    for key, field in ((action.actor_key, "actor_id"), (action.target_key, "target_id")):
        identifier = _uuid(result.get(field), "mfa_result")
        _require(
            actors.get(key) == users.get(key) == identifier
            and sum(value == identifier for value in actors.values()) == 1,
            "mfa_result",
        )
        ids.append(identifier)
    _require(
        len(set(ids)) == 3
        and result.get("action_key") == action.key
        and result.get("kind") == "account_controls"
        and result.get("actor_key") == action.actor_key
        and result.get("target_key") == action.target_key
        and result.get("status") == "complete"
        and result.get("mappings") == []
        and result.get("actor_aal2_observed") is True
        and result.get("target_aal2_observed") is True
        and all(result.get(key) is value for key, value in action.expected_end_state.items()),
        "mfa_result",
    )
    factors = [
        _uuid(result.get(key), "mfa_result")
        for key in ("cancelled_factor_id", "actor_factor_id", "target_factor_id")
    ]
    _require(len(set(factors)) == 3, "mfa_result")
    actor_sessions = _identifiers(result.get("actor_session_ids"), "mfa_result", 2)
    target_sessions = _identifiers(result.get("target_session_ids"), "mfa_result", 2)
    _require(not set(actor_sessions) & set(target_sessions), "mfa_result")
    people = {p.key: p for p in dataset.organization.actors.people}
    for key, field in (
        (action.actor_key, "original_actor_group_ids"),
        (action.target_key, "original_target_group_ids"),
    ):
        _require(
            _identifiers(result.get(field), "mfa_result")
            == sorted(_uuid(groups.get(group), "mfa_result") for group in people[key].groups),
            "mfa_result",
        )
    original = result.get("original_group_members")
    _require(
        isinstance(original, Mapping)
        and original
        == {
            _uuid(groups.get(group), "mfa_result"): sorted(
                _uuid(users.get(person.key), "mfa_result")
                for person in people.values()
                if group in person.groups
            )
            for group in dataset.organization.actors.group_access
        },
        "mfa_result",
    )
    owner = result.get("owner_factors")
    _require(
        isinstance(owner, list)
        and all(
            isinstance(row, Mapping) and set(row) == {"id", "factor_type", "status"}
            for row in owner
        ),
        "mfa_result",
    )
    _factor_inventory(
        {"user_id": admin_id, "assurance_level": "aal1", "factors": owner}, admin_id, "mfa_result"
    )
    receipt = result.get("reset_receipt")
    _require(isinstance(receipt, Mapping), "mfa_result")
    receipt = cast(Mapping[str, Any], receipt)
    _uuid(receipt.get("operation_id"), "mfa_result")
    _require(
        set(receipt)
        == {"operation_id", "user_id", "factors_cleared", "local_revocation", "revoked_sessions"}
        and receipt.get("user_id") == ids[2]
        and receipt.get("factors_cleared") is True
        and receipt.get("local_revocation") == "committed"
        and type(receipt.get("revoked_sessions")) is int
        and receipt.get("revoked_sessions") == len(target_sessions),
        "mfa_result",
    )


def mfa_request_contract(
    action: PhaseAction, result: Mapping[str, Any]
) -> dict[str, tuple[str, str, str, int]]:
    actor, target = action.actor_key, action.target_key
    actor_id, target_id = result["actor_id"], result["target_id"]
    # These declarative steps include denial probes; only 2xx steps count as route coverage.
    contract = {
        "promote_actor": ("admin", "PATCH", f"/api/users/{actor_id}", 200),
        "login_actor": (actor, "POST", "/api/auth/login", 200),
        "deny_aal1_reset": (actor, "POST", f"/api/users/{target_id}/mfa/reset", 403),
        "cancel_enroll": (actor, "POST", "/api/auth/mfa/factors", 201),
        "cancel_factor": (
            actor,
            "DELETE",
            f"/api/auth/mfa/factors/{result['cancelled_factor_id']}",
            204,
        ),
        "actor_enroll": (actor, "POST", "/api/auth/mfa/factors", 201),
        "actor_verify": (
            actor,
            "POST",
            f"/api/auth/mfa/factors/{result['actor_factor_id']}/verification",
            200,
        ),
        "login_target": (target, "POST", "/api/auth/login", 200),
        "target_enroll": (target, "POST", "/api/auth/mfa/factors", 201),
        "target_verify": (
            target,
            "POST",
            f"/api/auth/mfa/factors/{result['target_factor_id']}/verification",
            200,
        ),
        "reset_target_mfa": (actor, "POST", f"/api/users/{target_id}/mfa/reset", 200),
        "target_primary_refresh_refused": (target, "POST", "/api/auth/refresh", 401),
        "target_extra_refresh_refused": (target, "POST", "/api/auth/refresh", 401),
        "remove_actor_factor": (
            actor,
            "DELETE",
            f"/api/auth/mfa/factors/{result['actor_factor_id']}",
            204,
        ),
        "actor_primary_refresh_refused": (actor, "POST", "/api/auth/refresh", 401),
        "restore_actor_role": ("admin", "PATCH", f"/api/users/{actor_id}", 200),
    }
    contract.update(
        {
            f"restore_group:{group}": ("admin", "PUT", f"/api/access/groups/{group}/members", 200)
            for group in result["original_actor_group_ids"]
        }
    )
    contract.update(
        {
            "restore_actor_primary": (actor, "POST", "/api/auth/login", 200),
            "restore_target_primary": (target, "POST", "/api/auth/login", 200),
        }
    )
    return contract


def verify_mfa_request_evidence(
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
    from operations.sample.controls.mfa import plan_mfa_controls

    try:
        _require(action in plan_mfa_controls(dataset), "mfa_result")
        _result(dataset, manifest, action, result, admin_id)
        contract = mfa_request_contract(action, result)
        rows = result.get("request_evidence")
        _require(
            isinstance(rows, list) and all(isinstance(row, Mapping) for row in rows), "mfa_requests"
        )
        rows = cast(list[Mapping[str, Any]], rows)
        _require([row.get("step") for row in rows] == list(contract), "mfa_requests")
        successful = 0
        for row in rows:
            key, method, path, status = contract[row["step"]]
            identifier = admin_id if key == "admin" else actors.get(key)
            request_id = _uuid(row.get("request_id"), "mfa_requests")
            _require(
                set(row) == _REQUEST_KEYS
                and row.get("actor_key") == key
                and row.get("actor_id") == identifier
                and row.get("method") == method
                and row.get("path") == path
                and type(row.get("status_code")) is int
                and type(row.get("expected_status")) is int
                and row.get("status_code") == row.get("expected_status") == status
                and request_id not in seen_request_ids,
                "mfa_requests",
            )
            seen_request_ids.add(request_id)
            successful += int(200 <= status < 300)
        observed["control_requests_verified"] = (
            observed.get("control_requests_verified", 0) + successful
        )
    except (SamplePhaseActionError, KeyError, TypeError, ValueError):
        issues.append("MFA control request evidence differs from its exact owned-actor contract")


def _security_events(admin: SampleClient, result: Mapping[str, Any]) -> int:
    receipt = result["reset_receipt"]
    descriptor = next(
        row for row in result["request_evidence"] if row["step"] == "reset_target_mfa"
    )
    rows = list_all_rows(admin, "/api/security-events")
    matches = [row for row in rows if row.get("request_id") == descriptor["request_id"]]
    _require(len(matches) == 2, "mfa_events")
    events = [SecurityEventResponse.model_validate(row) for row in matches]
    _require(
        {event.outcome for event in events} == {"attempt", "success"}
        and len({event.id for event in events}) == 2,
        "mfa_events",
    )
    for event in events:
        metadata = {
            "email_request": "not_attempted",
            "local_revocation": "not_requested",
            "revoked_sessions": 0,
            "factors_cleared": None,
        }
        if event.outcome == "success":
            metadata.update(
                local_revocation="committed",
                revoked_sessions=receipt["revoked_sessions"],
                factors_cleared=True,
            )
        _require(
            event.event_type == "identity.mfa_reset"
            and event.source == "access.users"
            and str(event.operation_id) == receipt["operation_id"]
            and str(event.actor_id) == result["actor_id"]
            and str(event.subject_id) == result["target_id"]
            and str(event.request_id) == descriptor["request_id"]
            and event.request_method == "POST"
            and event.request_path == descriptor["path"]
            and event.metadata == metadata
            and all(type(event.metadata.get(key)) is type(value) for key, value in metadata.items())
            and sum(row.get("id") == str(event.id) for row in rows) == 1,
            "mfa_events",
        )
    return 2


def _final_state(
    admin: SampleClient, action: PhaseAction, result: Mapping[str, Any], admin_id: str
) -> None:
    groups = _group_members(admin)
    for _key, field, session_field, group_field in (
        (action.actor_key, "actor_id", "actor_session_ids", "original_actor_group_ids"),
        (action.target_key, "target_id", "target_session_ids", "original_target_group_ids"),
    ):
        user_id = result[field]
        response = admin.request("GET", f"/api/users/{user_id}")
        person = _read_json(response, step="mfa_final_person")
        _require(
            response.status_code == 200
            and person.get("id") == user_id
            and person.get("role") == "member"
            and person.get("status") == "active",
            "mfa_final_person",
        )
        security_response = admin.request("GET", f"/api/users/{user_id}/security")
        security = _read_json(security_response, step="mfa_final_security")
        _require(
            security_response.status_code == 200
            and security.get("user_id") == user_id
            and security.get("target_eligible") is True
            and type(security.get("verified_factor_count")) is int
            and security.get("verified_factor_count") == 0,
            "mfa_final_security",
        )
        sessions = list_all_rows(admin, f"/api/users/{user_id}/sessions")
        _require(
            not any(row.get("id") in result[session_field] for row in sessions),
            "mfa_final_sessions",
        )
        _require(
            sorted(group for group, members in groups.items() if user_id in members)
            == result[group_field],
            "mfa_final_groups",
        )
    owner = admin.request("GET", "/api/auth/me")
    _require(
        owner.status_code == 200
        and owner.json().get("id") == admin_id
        and owner.json().get("role") == "admin"
        and owner.json().get("status") == "active",
        "mfa_final_owner",
    )
    mfa = admin.request("GET", "/api/auth/mfa")
    _require(
        mfa.status_code == 200
        and _factor_inventory(_read_json(mfa, step="mfa_final_owner"), admin_id, "mfa_final_owner")[
            1
        ]
        == result["owner_factors"],
        "mfa_final_owner",
    )


def verify_mfa_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    from operations.sample.controls.mfa import plan_mfa_controls

    counts = {"mfa_control_actions": 0, "mfa_control_security_events": 0}
    issues: list[str] = []
    action = plan_mfa_controls(dataset)[0]
    raw = manifest.get("control_results")
    results = (
        [row for row in raw if isinstance(row, Mapping) and row.get("action_key") == action.key]
        if isinstance(raw, list)
        else []
    )
    if len(results) != 1:
        return counts, ["MFA control result is missing or duplicated"]
    result = results[0]
    actors = manifest.get("actor_ids")
    verify_mfa_request_evidence(
        dataset,
        manifest,
        action,
        result,
        actors if isinstance(actors, Mapping) else {},
        admin_id,
        set(),
        counts,
        issues,
    )
    counts["mfa_control_requests"] = counts.pop("control_requests_verified", 0)
    if issues:
        return counts, issues
    try:
        counts["mfa_control_security_events"] = _security_events(admin, result)
        _final_state(admin, action, result, admin_id)
    except (
        SampleClientError,
        SamplePhaseActionError,
        SampleVerificationError,
        ValidationError,
        KeyError,
        TypeError,
        ValueError,
        StopIteration,
    ):
        issues.append("MFA control event correlation or final-state readback is invalid")
    if not issues:
        counts["mfa_control_actions"] = 1
    return counts, issues
