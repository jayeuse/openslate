"""Public host-control request contract and final correlated readback."""

from collections.abc import Mapping
from typing import Any

from app.systems.manage.audit.schemas import SecurityEventResponse
from app.systems.manage.backups.schemas import BackupExportResponse, BackupRunResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.host_environment import require
from operations.sample.controls.mfa_verification import _factor_inventory, _group_members, _uuid
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import _read_json
from operations.sample.verification.core import list_all_rows


def host_request_contract(
    action: PhaseAction, result: Mapping[str, Any]
) -> dict[str, tuple[str, str, str, int]]:
    actor, user, export = action.actor_key, result["actor_id"], result["export_id"]
    export_path = f"/api/backups/exports/{export}"
    # fmt: off
    specs = {
        "owner_identity": ("admin", "GET", "/api/auth/me", 200),
        "owner_factors": ("admin", "GET", "/api/auth/mfa", 200),
        "actor_profile": ("admin", "GET", f"/api/users/{user}", 200),
        "actor_identity": (actor, "GET", "/api/auth/me", 200),
        "actor_factors": (actor, "GET", "/api/auth/mfa", 200),
        "mfa_policy": ("admin", "GET", "/api/workspace/security", 200),
        "development_idle": ("admin", "GET", "/api/backups/status", 200),
        "promote_actor": ("admin", "PATCH", f"/api/users/{user}", 200),
        "host_health": (actor, "GET", "/api/health", 200),
        "host_readiness": (actor, "GET", "/api/ready", 200),
        "login_actor": (actor, "POST", "/api/auth/login", 200),
        "login_actor_identity": (actor, "GET", "/api/auth/me", 200),
        "production_idle": (actor, "GET", "/api/backups/status", 200),
        "source_queued": (actor, "GET", "/api/backups/status", 200),
        "queue_source": (actor, "POST", "/api/backups", 201),
        "source_readback": (actor, "GET", "/api/backups", 200),
        "export_idle": (actor, "GET", "/api/backups/status", 200),
        "queue_export": (actor, "POST", "/api/backups/exports", 201),
        "export_readback": (actor, "GET", f"/api/backups/exports/{export}", 200),
        "native_login": (actor, "POST", "/api/auth/login", 200),
        "native_identity": (actor, "GET", "/api/auth/me", 200),
        "native_admission": (actor, "POST", export_path + "/download-admission", 200),
        "native_content": (actor, "GET", f"/api/backups/exports/{export}/content", 200),
        "restore_owner_refresh": ("admin", "POST", "/api/auth/refresh", 200),
        "restore_owner_identity": ("admin", "GET", "/api/auth/me", 200),
        "restore_actor_read": ("admin", "GET", f"/api/users/{user}", 200),
        "restore_actor_role": ("admin", "PATCH", f"/api/users/{user}", 200),
        "restored_actor": (actor, "GET", "/api/auth/me", 200),
        "restored_factors": (actor, "GET", "/api/auth/mfa", 200),
        "restored_owner_factors": ("admin", "GET", "/api/auth/mfa", 200),
    }
    # fmt: on
    for group in result["original_actor_group_ids"]:
        specs["restore_group_read:" + group] = ("admin", "GET", f"/api/access/groups/{group}", 200)
        specs["restore_group:" + group] = (
            "admin",
            "PUT",
            f"/api/access/groups/{group}/members",
            200,
        )
    for key in result["primary_actor_keys"]:
        specs["restore_primary:" + key] = (key, "POST", "/api/auth/login", 200)
        specs["restore_identity:" + key] = (key, "GET", "/api/auth/me", 200)
    return specs


def verify_host_controls(
    admin: SampleClient, dataset: SampleDataset, manifest: Mapping[str, Any], admin_id: str
) -> tuple[dict[str, int], list[str]]:
    from operations.sample.controls.host_delivery import plan_host_controls

    counts = {
        "host_control_actions": 0,
        "host_control_requests": 0,
        "host_control_security_events": 0,
    }
    try:
        action = plan_host_controls(dataset)[0]
        results = [
            row for row in manifest["control_results"] if row.get("action_key") == action.key
        ]
        require(len(results) == 1, "host_result")
        result, actors = results[0], manifest["actor_ids"]
        actor_id = _uuid(result["actor_id"], "host_result")
        require(
            actor_id == actors[action.actor_key] == manifest["mappings"]["user"][action.actor_key]
            and actor_id != admin_id
            and result["outcome"] == "completed"
            and result["actor_key"] == action.actor_key
            and result["target_key"] == action.target_key
            and all(result.get(key) is value for key, value in action.expected_end_state.items()),
            "host_result",
        )
        contract, seen, ids = host_request_contract(action, result), set(), set()
        for row in result["request_evidence"]:
            step = row["step"]
            require(
                step not in seen
                and (row["actor_key"], row["method"], row["path"], row["status_code"])
                == contract[step]
                and row["expected_status"] == row["status_code"]
                and row["actor_id"]
                == (admin_id if row["actor_key"] == "admin" else actors[row["actor_key"]]),
                "host_result",
            )
            identifier = _uuid(row["request_id"], "host_result")
            require(identifier not in ids, "host_result")
            seen.add(step)
            ids.add(identifier)
        optional = {
            "restore_actor_role",
            *("restore_group:" + g for g in result["original_actor_group_ids"]),
        }
        require(set(contract) - optional <= seen <= set(contract), "host_result")
        person = _read_json(admin.request("GET", f"/api/users/{actor_id}"), step="host_result")
        require(
            person.get("id") == actor_id
            and person.get("role") == "member"
            and person.get("status") == "active",
            "host_result",
        )
        groups = _group_members(admin)
        require(
            sorted(g for g, members in groups.items() if actor_id in members)
            == result["original_actor_group_ids"],
            "host_result",
        )
        owner = _read_json(admin.request("GET", "/api/auth/me"), step="host_result")
        require(
            owner.get("id") == admin_id
            and owner.get("role") == "admin"
            and owner.get("status") == "active"
            and _factor_inventory(
                _read_json(admin.request("GET", "/api/auth/mfa"), step="host_result"),
                admin_id,
                "host_result",
            )[1]
            == result["owner_factors"],
            "host_result",
        )
        sources = list_all_rows(admin, "/api/backups", params={"run_id": result["backup_run_id"]})
        require(len(sources) == 1, "host_result")
        source = BackupRunResponse.model_validate(sources[0])
        exported = BackupExportResponse.model_validate(
            _read_json(
                admin.request("GET", f"/api/backups/exports/{result['export_id']}"),
                step="host_result",
            )
        )
        require(
            source.state == "succeeded"
            and source.verified_at is not None
            and source.reconciled_at is not None
            and source.snapshot_id == result["source_snapshot_id"]
            and source.manifest_sha256 == result["source_manifest_sha256"]
            and str(exported.backup_run_id) == result["backup_run_id"]
            and exported.state == "ready"
            and exported.size_bytes == result["archive_size_bytes"]
            and exported.size_bytes is not None
            and exported.size_bytes > 25 * 1024 * 1024
            and exported.sha256 == result["archive_sha256"],
            "host_result",
        )
        events = [
            SecurityEventResponse.model_validate(row)
            for row in list_all_rows(admin, "/api/security-events")
            if row.get("id") == result["native_attempt_event_id"]
        ]
        require(len(events) == 1, "host_result")
        event = events[0]
        require(
            event.event_type == "backup.export.download"
            and event.source == "backup"
            and event.outcome == "attempt"
            and str(event.actor_id) == actor_id
            and str(event.operation_id) == str(event.subject_id) == result["export_id"]
            and str(event.request_id) == result["native_content_request_id"]
            and event.request_method == "GET"
            and event.request_path == f"/api/backups/exports/{result['export_id']}/content"
            and event.metadata
            == {
                "backup_run_id": result["backup_run_id"],
                "size_bytes": result["archive_size_bytes"],
                "sha256": result["archive_sha256"],
            },
            "host_result",
        )
        counts.update(
            host_control_actions=1, host_control_requests=len(seen), host_control_security_events=1
        )
        return counts, []
    except Exception:
        return counts, ["Physical host control receipt or final readback is not verified"]
