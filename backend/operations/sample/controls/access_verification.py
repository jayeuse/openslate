"""Read-only verification for sample Access control actions."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.expectations import read_phase_plan
from operations.sample.verification.core import SampleVerificationError


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
    del admin_id
    issues: list[str] = []
    actions, results = _control_data(manifest, "access_controls", issues)
    operations = {action.values.get("operation"): action for action in actions}
    expected_operations = {
        "create_temporary_group",
        "rename_temporary_group",
        "delete_temporary_group",
        "delete_user",
        "restore_user",
        "resend_invitation",
        "revoke_invitation",
    }
    if set(operations) != expected_operations:
        issues.append("Access control plan does not cover the required operations")
    if any(action.key not in results for action in actions):
        issues.append("Access control result journal is incomplete")

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
    if revoke_invitation is not None:
        user_id = _mapped_id_from_contextless_result(manifest, revoke_invitation.target_key)
        if user_id is None:
            issues.append("Pending invitation user mapping is missing")
        else:
            response = admin.request("GET", f"/api/users/{user_id}")
            try:
                user = response.json()
            except ValueError:
                user = None
            if (
                response.status_code != 200
                or not isinstance(user, Mapping)
                or user.get("status") != "pending"
                or user.get("is_deleted") is not False
                or user.get("invitation_sent_at") is not None
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
