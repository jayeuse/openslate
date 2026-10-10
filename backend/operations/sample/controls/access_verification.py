"""Read-only verification for sample Access control actions."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast
from uuid import UUID

from pydantic import ValidationError

from app.systems.access.users.schemas import UserResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.expectations import read_phase_plan
from operations.sample.verification.core import SampleVerificationError


def _pending_invitation(
    raw: object, user_id: str, email: str, username: str, *, sent: bool
) -> UserResponse | None:
    try:
        user = UserResponse.model_validate(raw)
    except ValidationError:
        return None
    timestamp = user.invitation_sent_at
    if (
        str(user.id) != user_id
        or user.email != email
        or user.username != username
        or user.role != "member"
        or user.status != "pending"
        or user.is_deleted
        or user.deleted_at is not None
        or (timestamp is not None) != sent
        or (timestamp is not None and (timestamp.tzinfo is None or timestamp.utcoffset() is None))
    ):
        return None
    return user


def _invitation_receipts(
    actions: list[PhaseAction],
    results: Mapping[str, Mapping[str, Any]],
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    issues: list[str],
) -> bool:
    invitations = [
        action
        for action in actions
        if action.values.get("operation")
        in {
            "resend_invitation",
            "reconcile_invitation",
            "revoke_invitation",
        }
    ]
    valid = [action.values.get("operation") for action in invitations] == [
        "resend_invitation",
        "revoke_invitation",
        "reconcile_invitation",
        "revoke_invitation",
    ] and len({action.target_key for action in invitations}) == 1
    if not valid:
        issues.append("Pending invitation receipt sequence is invalid")
    raw_results = manifest.get("control_results", [])
    request_ids: set[UUID] = set()
    for action in invitations:
        user_id = _mapped_id_from_contextless_result(manifest, action.target_key)
        person = next(
            (p for p in dataset.organization.actors.people if p.key == action.target_key), None
        )
        result = results.get(action.key, {})
        evidence = result.get("request_evidence")
        row = (
            evidence[0]
            if isinstance(evidence, list)
            and len(evidence) == 1
            and isinstance(evidence[0], Mapping)
            else {}
        )
        raw_id = row.get("request_id")
        try:
            request_id = UUID(raw_id) if isinstance(raw_id, str) else None
        except ValueError:
            request_id = None
        operation = action.values.get("operation")
        sent = operation != "revoke_invitation"
        root = f"/api/auth/invitations/{user_id}"
        path = f"{root}/{str(operation).removesuffix('_invitation')}" if sent else root
        status = 200 if sent else 204
        before = (
            _pending_invitation(
                result.get("invitation_before"),
                user_id,
                person.email,
                person.username,
                sent=operation != "reconcile_invitation",
            )
            if person and user_id
            else None
        )
        after = (
            _pending_invitation(
                result.get("invitation_after"), user_id, person.email, person.username, sent=sent
            )
            if person and user_id
            else None
        )
        if (
            not isinstance(raw_results, list)
            or sum(
                isinstance(raw, Mapping) and raw.get("action_key") == action.key
                for raw in raw_results
            )
            != 1
            or action.actor_key != "admin"
            or action.expected_status != status
            or result.get("actor_key") != "admin"
            or result.get("actor_id") != admin_id
            or result.get("target_key") != action.target_key
            or result.get("outcome") != "completed"
            or row.get("actor_key") != "admin"
            or row.get("actor_id") != admin_id
            or row.get("method") != ("POST" if sent else "DELETE")
            or row.get("path") != path
            or row.get("expected_status") != status
            or row.get("status_code") != status
            or row.get("primary_entity_type") != "users"
            or row.get("primary_entity_id") != user_id
            or row.get("primary_action") != "update"
            or row.get("expected_audit_rows") != 1
            or request_id is None
            or request_id in request_ids
            or before is None
            or after is None
        ):
            valid = False
            issues.append(f"Pending invitation receipt is invalid: {action.key}")
        if request_id is not None:
            request_ids.add(request_id)
    return valid


def _control_data(
    manifest: Mapping[str, Any], kind: str, issues: list[str]
) -> tuple[list[PhaseAction], dict[str, Mapping[str, Any]]]:
    raw_plan = manifest.get("control_plan")
    if not isinstance(raw_plan, list):
        issues.append("Access control plan is missing")
        return [], {}
    try:
        actions = [
            action for action in read_phase_plan({"phase_plan": raw_plan}) if action.kind == kind
        ]
    except (SampleVerificationError, TypeError, ValueError):
        issues.append("Access control plan is invalid")
        return [], {}
    raw_results = manifest.get("control_results")
    if not isinstance(raw_results, list) or any(
        not isinstance(row, Mapping) for row in raw_results
    ):
        issues.append("Access control results are missing")
        return actions, {}
    results: dict[str, Mapping[str, Any]] = {}
    for row in raw_results:
        key = row.get("action_key")
        if isinstance(key, str):
            results[key] = row
    return actions, results


def _mapping_id(result: Mapping[str, Any], kind: str, logical_id: str) -> str | None:
    rows = result.get("mappings")
    if not isinstance(rows, list):
        return None
    for row in rows:
        if (
            isinstance(row, Mapping)
            and row.get("kind") == kind
            and row.get("logical_id") == logical_id
            and isinstance(row.get("server_id"), str)
        ):
            return cast(str, row["server_id"])
    return None


def verify_access_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Read back the restored guest, revoked invite and removed temporary group."""
    issues: list[str] = []
    actions, results = _control_data(manifest, "access_controls", issues)
    # People security shares this kind but has its own verifier.
    actions = [
        action for action in actions if action.values.get("operation") != "review_people_security"
    ]
    operations = {action.values.get("operation"): action for action in actions}
    expected_operations = {
        "create_temporary_group",
        "rename_temporary_group",
        "delete_temporary_group",
        "delete_user",
        "restore_user",
        "resend_invitation",
        "reconcile_invitation",
        "revoke_invitation",
    }
    if set(operations) != expected_operations:
        issues.append("Access control plan does not cover the required operations")
    if any(action.key not in results for action in actions):
        issues.append("Access control result journal is incomplete")
    invitation_receipts_valid = _invitation_receipts(
        actions, results, dataset, manifest, admin_id, issues
    )

    groups_deleted = 0
    create = operations.get("create_temporary_group")
    if create is not None:
        created = results.get(create.key, {})
        group_id = _mapping_id(created, "control_groups", create.target_key)
        if group_id is None:
            issues.append("Temporary Access group mapping is missing")
        else:
            response = admin.request("GET", f"/api/access/groups/{group_id}")
            try:
                group = response.json()
            except ValueError:
                group = None
            delete_group = operations.get("delete_temporary_group")
            if (
                response.status_code != 200
                or not isinstance(group, Mapping)
                or group.get("id") != group_id
                or delete_group is None
                or group.get("name") != delete_group.values.get("name")
                or group.get("is_deleted") is not True
                or not isinstance(group.get("deleted_at"), str)
                or not group.get("deleted_at")
                or group.get("member_ids") != []
                or group.get("access") != []
            ):
                issues.append("Temporary Access group remains available")
            else:
                groups_deleted = 1

    users_restored = 0
    delete_user = operations.get("delete_user")
    restore_user = operations.get("restore_user")
    if delete_user is not None and restore_user is not None:
        user_id = _mapped_id_from_contextless_result(manifest, delete_user.target_key)
        if user_id is None:
            issues.append("Restored guest user mapping is missing")
        else:
            response = admin.request("GET", f"/api/users/{user_id}")
            try:
                user = response.json()
            except ValueError:
                user = None
            restore_result = results.get(delete_user.key, {})
            before_access = restore_result.get("access_before")
            access_response = admin.request("GET", f"/api/users/{user_id}/access")
            try:
                access = access_response.json()
            except ValueError:
                access = None
            if (
                response.status_code != 200
                or not isinstance(user, Mapping)
                or user.get("role") != "guest"
                or user.get("status") != "active"
                or user.get("is_deleted") is not False
                or access_response.status_code != 200
                or not isinstance(access, Mapping)
                or access.get("role") != "guest"
                or access.get("unrestricted") is not False
                or access != before_access
            ):
                issues.append("Guest account or group access was not restored")
            else:
                users_restored = 1

    invitations_revoked = 0
    revoke_invitation = operations.get("revoke_invitation")
    if revoke_invitation is not None and invitation_receipts_valid:
        user_id = _mapped_id_from_contextless_result(manifest, revoke_invitation.target_key)
        if user_id is None:
            issues.append("Pending invitation user mapping is missing")
        else:
            response = admin.request("GET", f"/api/users/{user_id}")
            try:
                user = response.json()
            except ValueError:
                user = None
            person = next(
                (
                    p
                    for p in dataset.organization.actors.people
                    if p.key == revoke_invitation.target_key
                ),
                None,
            )
            if (
                response.status_code != 200
                or person is None
                or _pending_invitation(user, user_id, person.email, person.username, sent=False)
                is None
            ):
                issues.append("Pending invitation was not revoked")
            else:
                invitations_revoked = 1

    return {
        "access_groups_deleted": groups_deleted,
        "access_users_restored": users_restored,
        "access_invitations_revoked": invitations_revoked,
    }, issues


def _mapped_id_from_contextless_result(manifest: Mapping[str, Any], logical_id: str) -> str | None:
    mappings = manifest.get("mappings")
    if not isinstance(mappings, Mapping):
        return None
    for bucket_name in ("user", "users"):
        bucket = mappings.get(bucket_name)
        if isinstance(bucket, Mapping) and isinstance(bucket.get(logical_id), str):
            return cast(str, bucket[logical_id])
    return None
