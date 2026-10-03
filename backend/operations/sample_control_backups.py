"""Pack-derived backup metadata controls; host execution stays operator-owned."""

import json
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import uuid4

import httpx
from pydantic import BaseModel, ValidationError

from app.common.listing import StandardListResponse
from app.systems.manage.backups.schemas import (
    RELEASE_PREFIX,
    VERSION_PATTERN,
    BackupRunResponse,
    BackupStatusResponse,
    VersionResponse,
)
from operations.sample_blueprint import SampleDataset
from operations.sample_packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _result,
)

QUEUE_KEY = "control:backups:queue_backup"
HISTORY_QUERY = {
    "limit": 4,
    "offset": 0,
    "search": "",
    "sort_by": "requested_at",
    "sort_order": "desc",
    "deleted": "exclude",
}
_UNSTARTED_FACTS = (
    "started_at",
    "finished_at",
    "reconciled_at",
    "snapshot_id",
    "manifest_sha256",
    "verified_at",
    "failure_code",
    "expired_at",
)


def plan_backup_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    specs: tuple[tuple[str, int, dict[str, PhaseJsonValue]], ...] = (
        ("review_backup_status", 200, {"read_checks": 1, "policy_reviewed": True}),
        ("update_restore_backup_policy", 200, {"read_checks": 3, "policy_restored": True}),
        ("queue_backup", 201, {"read_checks": 1, "queued": True}),
        ("review_backup_history", 200, {"read_checks": 2, "owned_queue_verified": True}),
        ("review_version", 200, {"read_checks": 1, "version_reviewed": True}),
    )
    return tuple(
        PhaseAction(
            key=f"control:backups:{operation}",
            phase="reorganization",
            kind="backup_controls",
            actor_key="admin",
            target_key="control:version" if operation == "review_version" else "control:backups",
            values={
                "operation": operation,
                **(
                    {"name": f"{dataset.organization.identity.workspace_name} workspace backup"}
                    if operation == "queue_backup"
                    else {}
                ),
            },
            expected_status=status,
            expected_detail=None,
            expected_end_state=end_state,
        )
        for operation, status, end_state in specs
    )


def _parsed(body: object, schema: type[BaseModel], *, step: str) -> dict[str, Any]:
    def aware_times(value: object) -> bool:
        if isinstance(value, datetime):
            return value.utcoffset() is not None
        if isinstance(value, Mapping):
            return all(aware_times(item) for item in value.values())
        if isinstance(value, list):
            return all(aware_times(item) for item in value)
        return True

    try:
        parsed = schema.model_validate_json(json.dumps(body), strict=True)
        if not aware_times(parsed.model_dump()):
            raise ValueError("Missing timestamp offset")
        return parsed.model_dump(mode="json")
    except (ValidationError, TypeError, ValueError):
        raise SamplePhaseActionError("Backup metadata response is invalid", step=step) from None


def _policy(body: object, *, step: str) -> dict[str, Any]:
    status = _parsed(body, BackupStatusResponse, step=step)
    policy: dict[str, Any] = status["policy"]
    if (
        type(policy["revision"]) is not int
        or policy["revision"] < 1
        or status["queued_count"] < 0
        or not policy["timezone"]
        or (policy["schedule"] == "disabled" and policy["next_due_at"] is not None)
    ):
        raise SamplePhaseActionError("Backup status facts are inconsistent", step=step)
    return policy


def _queued(body: object, *, name: str, run_id: str | None = None, step: str) -> dict[str, Any]:
    run = _parsed(body, BackupRunResponse, step=step)
    if (
        run["name"] != name
        or run["state"] != "queued"
        or run["provenance"] != "manual"
        or run["installation"] != "current"
        or (run_id is not None and run["id"] != run_id)
        or any(run[key] is not None for key in _UNSTARTED_FACTS)
    ):
        raise SamplePhaseActionError("Owned backup request is not unstarted and queued", step=step)
    return run


def _page(body: object, *, run_id: str | None = None, step: str) -> dict[str, Any]:
    page = _parsed(body, StandardListResponse[BackupRunResponse], step=step)
    metadata, rows = page["pagination"], page["items"]
    if (
        metadata["limit"] != HISTORY_QUERY["limit"]
        or metadata["offset"] != 0
        or metadata["count"] != len(rows)
        or metadata["count"] != min(4, metadata["total"])
        or metadata["has_more"] != (metadata["total"] > metadata["count"])
        or len({row["id"] for row in rows}) != len(rows)
        or (run_id is not None and (metadata["total"] != 1 or rows[0]["id"] != run_id))
    ):
        raise SamplePhaseActionError("Backup history paging or exact identity differs", step=step)
    return page


def _version(body: object, *, step: str) -> dict[str, Any]:
    version = _parsed(body, VersionResponse, step=step)
    observation = (version["latest_version"], version["observed_at"], version["release_url"])
    present = all(value is not None for value in observation)
    absent = all(value is None for value in observation)
    if (
        not version["current_version"].strip()
        or not (present or absent)
        or (
            present
            and (
                not VERSION_PATTERN.fullmatch(version["latest_version"])
                or version["release_url"]
                not in {
                    RELEASE_PREFIX + version["latest_version"],
                    RELEASE_PREFIX + "v" + version["latest_version"],
                }
            )
        )
        or (present and version["checked_at"] is None)
        or (version["status"] == "unknown" and version["failure_code"] is not None)
        or (
            version["status"] == "unavailable"
            and (
                version["checked_at"] is None
                or version["failure_code"]
                not in {
                    "release_unavailable",
                    "release_invalid",
                    "release_timeout",
                }
            )
        )
        or (
            version["status"] in {"available", "current", "stale"}
            and (
                not present or version["checked_at"] is None or version["failure_code"] is not None
            )
        )
    ):
        raise SamplePhaseActionError("Recorded version observation is inconsistent", step=step)
    return version


def backup_request_contract(action: PhaseAction) -> dict[str, tuple[str, str, str, int]]:
    status = "/api/backups/status"
    routes = {
        "review_backup_status": (("backup_status", "GET", status),),
        "update_restore_backup_policy": (
            ("policy_before", "GET", status),
            ("update_policy", "PATCH", status),
            ("policy_saved", "GET", status),
            ("restore_policy", "PATCH", status),
            ("policy_restored", "GET", status),
        ),
        "queue_backup": (
            ("queue_backup", "POST", "/api/backups"),
            ("queued_readback", "GET", "/api/backups"),
        ),
        "review_backup_history": (
            ("backup_history", "GET", "/api/backups"),
            ("owned_queue", "GET", "/api/backups"),
        ),
        "review_version": (("version_observation", "GET", "/api/version"),),
    }
    return {
        step: ("admin", method, path, 201 if method == "POST" else 200)
        for step, method, path in routes[str(action.values["operation"])]
    }


def execute_backup_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_backup_controls(dataset):
        raise SamplePhaseActionError(
            "Backup action differs from its authored plan", step=action.key
        )
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []

    def request(
        method: str,
        path: str,
        step: str,
        *,
        body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], httpx.Response]:
        response = _request(
            action,
            context,
            [],
            actor_key="admin",
            method=method,
            path=path,
            step=step,
            expected=201 if method == "POST" else 200,
            on_substep=on_substep,
            json_body=body,
            params=params,
            headers=headers,
        )
        request_id = _request_id(response)
        if request_id is None or "no-store" not in {
            token.strip().lower() for token in response.headers.get("Cache-Control", "").split(",")
        }:
            raise SamplePhaseActionError("Backup response headers are invalid", step=step)
        evidence.append(
            {
                "step": step,
                "actor_key": "admin",
                "actor_id": _id(context.user_ids, "admin", label="actor", step=step),
                "method": method,
                "path": path,
                "expected_status": response.status_code,
                "status_code": response.status_code,
                "request_id": request_id,
            }
        )
        return _read_json(response, step=step, request_id=request_id), response

    def read(
        path: str,
        step: str,
        *,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        return request("GET", path, step, params=params)[0]

    operation = action.values["operation"]
    extra: dict[str, object] = dict(action.expected_end_state)
    if operation == "review_backup_status":
        extra["original_policy"] = _policy(
            read("/api/backups/status", "backup_status"), step=action.key
        )
    elif operation == "update_restore_backup_policy":
        original = _policy(read("/api/backups/status", "policy_before"), step=action.key)
        if not original["adopted"]:
            raise SamplePhaseActionError(
                "Backup policy requires operator adoption", step=action.key
            )
        changes = {
            "schedule": "daily" if original["schedule"] != "daily" else "weekly",
            "retention_days": 7 if original["retention_days"] != 7 else 30,
        }
        updated = _policy(
            request(
                "PATCH",
                "/api/backups/status",
                "update_policy",
                body={
                    "revision": original["revision"],
                    **changes,
                },
            )[0],
            step=action.key,
        )
        saved = _policy(read("/api/backups/status", "policy_saved"), step=action.key)
        expected = {**original, **changes, "revision": original["revision"] + 1}
        if (
            any(updated[key] != expected[key] for key in expected if key != "next_due_at")
            or saved != updated
        ):
            raise SamplePhaseActionError("Backup policy update was not persisted", step=action.key)
        restored = _policy(
            request(
                "PATCH",
                "/api/backups/status",
                "restore_policy",
                body={
                    "revision": saved["revision"],
                    "schedule": original["schedule"],
                    "retention_days": original["retention_days"],
                },
            )[0],
            step=action.key,
        )
        final = _policy(read("/api/backups/status", "policy_restored"), step=action.key)
        expected = {**original, "revision": original["revision"] + 2}
        if (
            any(restored[key] != expected[key] for key in expected if key != "next_due_at")
            or final != restored
        ):
            raise SamplePhaseActionError("Original backup policy was not restored", step=action.key)
        extra.update(original_policy=original, restored_policy=restored)
    elif operation == "queue_backup":
        if context.runtime_mappings.get("backup_requests"):
            raise SamplePhaseActionError("Backup queue already has a receipt", step=action.key)
        name = str(action.values["name"])
        body, response = request(
            "POST",
            "/api/backups",
            "queue_backup",
            body={"name": name},
            headers={"Idempotency-Key": str(uuid4())},
        )
        run = _queued(body, name=name, step=action.key)
        if response.headers.get("Location") != f"/api/backups?run_id={run['id']}":
            raise SamplePhaseActionError(
                "Backup queue Location differs from its exact ID", step=action.key
            )
        page = _page(
            read("/api/backups", "queued_readback", params={**HISTORY_QUERY, "run_id": run["id"]}),
            run_id=run["id"],
            step=action.key,
        )
        if _queued(page["items"][0], name=name, run_id=run["id"], step=action.key) != run:
            raise SamplePhaseActionError(
                "Queued backup readback differs from its receipt", step=action.key
            )
        _record_mapping(
            context, context.clients["admin"], "backup_requests", QUEUE_KEY, run["id"], mappings
        )
        extra["queued_run"] = run
    elif operation == "review_backup_history":
        run_id = _mapped_id(context, "backup_requests", QUEUE_KEY, step=action.key)
        _page(read("/api/backups", "backup_history", params=HISTORY_QUERY), step=action.key)
        page = _page(
            read("/api/backups", "owned_queue", params={**HISTORY_QUERY, "run_id": run_id}),
            run_id=run_id,
            step=action.key,
        )
        name = str(
            next(
                row.values["name"]
                for row in plan_backup_controls(dataset)
                if row.values["operation"] == "queue_backup"
            )
        )
        extra["queued_run"] = _queued(page["items"][0], name=name, run_id=run_id, step=action.key)
    elif operation == "review_version":
        extra["version_observation"] = _version(
            read("/api/version", "version_observation"), step=action.key
        )
    return _result(action, context, evidence, mappings, extra=extra)
