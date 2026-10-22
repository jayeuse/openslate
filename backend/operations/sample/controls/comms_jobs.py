"""API-only schedule, protected-retention and real-export journeys on newly owned rooms."""

import csv
import io
import time
import zipfile
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4
from xml.etree import ElementTree

import httpx

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _request,
    _result,
)


def plan_comms_job_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = next(
        person.key
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active"
    )
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-jobs",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:jobs-disposable",
            values={
                "operation": "jobs_roundtrip" if org == "primary" else "partner_jobs_roundtrip",
                "organization": org,
                "member_key": member,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"jobs_verified": True},
        )
        for org in ("primary", "partner")
    )


def execute_comms_job_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_comms_job_controls(dataset):
        raise SamplePhaseActionError("Unsupported Comms job operation", step=action.key)
    member = str(action.values["member_key"])
    if action.values["organization"] == "partner":
        admin_factory, actor_factory = (
            context.private_values.get(key) for key in ("partner_admin", "partner_actor")
        )
        if not callable(admin_factory) or not callable(actor_factory):
            raise SamplePhaseActionError("Partner clients are unavailable", step=action.key)
        admin, peer = admin_factory(), actor_factory(member)
        check(
            admin.organization_id == peer.organization_id
            and admin.organization_id != context.clients["admin"].organization_id,
            "partner_org",
        )
        context = bound_context(context, {**context.clients, "admin": admin, member: peer})
    org = _id(
        {"org": context.clients["admin"].organization_id},
        "org",
        label="organization",
        step=action.key,
    )
    _id(context.user_ids, member, label="member", step=action.key)
    evidence: list[dict[str, object]] = []

    def call(
        method: str, path: str, step: str, expected: int = 200, actor: str = "admin", **kwargs: Any
    ) -> httpx.Response:
        return _request(
            action,
            context,
            evidence,
            actor_key=actor,
            method=method,
            path=path,
            step=step,
            expected=expected,
            on_substep=on_substep,
            **kwargs,
        )

    room = call(
        "POST",
        "/api/comms/conversations",
        "create_owned_room",
        201,
        json_body={
            "name": "Owned jobs check",
            "scope": "organization",
            "position": 0,
            "topic": "",
            "category_id": None,
        },
    ).json()
    check(room["org_id"] == org, "room_org")
    root = "/api/comms/conversations/" + room["id"]
    schedules = "/api/comms/scheduled-messages"
    payload = {
        "conversation_id": room["id"],
        "client_key": str(uuid4()),
        "body": "Before scheduled edit",
        "send_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
    }
    created = call("POST", schedules, "schedule", 201, actor=member, json_body=payload)
    path = schedules + "/" + created.json()["id"]
    payload["body"] = "=SUM(1,2)"
    edited = call(
        "PUT",
        path,
        "edit_schedule",
        actor=member,
        json_body=payload,
        headers={"If-Match": created.headers["ETag"]},
    )
    sent = call(
        "POST",
        path + "/send",
        "send_now",
        actor=member,
        headers={"If-Match": edited.headers["ETag"]},
    ).json()
    check(sent["status"] == "succeeded" and sent["message_id"] is not None, "scheduled_send")
    message = call("GET", root + "/messages/" + sent["message_id"], "sent_message").json()
    check(message["body"] == payload["body"], "edited_content_sent")
    call("GET", path, "schedule_detail", actor=member)
    check(
        any(
            row["id"] == sent["id"]
            for row in call(
                "GET",
                schedules,
                "schedule_list",
                actor=member,
            ).json()["items"]
        ),
        "listed_schedule",
    )
    canceled = call(
        "POST",
        schedules,
        "cancel_source",
        201,
        actor=member,
        json_body={**payload, "client_key": str(uuid4())},
    )
    cancel_path = schedules + "/" + canceled.json()["id"] + "/cancellation"
    check(
        call(
            "POST",
            cancel_path,
            "cancel_schedule",
            actor=member,
            headers={"If-Match": canceled.headers["ETag"]},
        ).json()["status"]
        == "cancelled",
        "preclaim_canceled",
    )

    # Only this newly created channel's policy is changed; never shorten workspace retention.
    scope = {"kind": "channel", "id": room["id"]}
    query = {"scope_kind": "channel", "channel_id": room["id"]}
    for days in (7, None):
        current = call("GET", "/api/comms/retention", f"retention_read:{days}", params=query)
        proposal = {
            "scope": scope,
            "message_days": days,
            "file_days": days,
            "password": context.admin_password,
        }
        preview = call(
            "POST",
            "/api/comms/retention/preview",
            f"retention_preview:{days}",
            json_body=proposal,
            headers={"If-Match": current.headers["ETag"]},
        ).json()
        check(preview["message_count"] == preview["file_count"] == 0, "owned_recent_content")
        result = call(
            "PUT",
            "/api/comms/retention",
            f"retention_update:{days}",
            json_body={**proposal, "preview_digest": preview["preview_digest"]},
            headers={"If-Match": current.headers["ETag"]},
        ).json()
        check(result["policy"]["message_days"] == days, "policy_persisted")
        check(
            result["sources"]["message_days"] == ("channel" if days else "workspace"),
            "null_inheritance",
        )
    exports = "/api/comms/exports"
    selection = {"conversation_ids": [room["id"]], "format": "csv", "reason": "Owned sample"}
    call("POST", exports, "private_proof_required", 403, json_body=selection)
    call("POST", exports, "member_export_denied", 403, actor=member, json_body=selection)
    for format in ("csv", "xlsx"):
        job = call(
            "POST",
            exports,
            "export:" + format,
            201,
            json_body={
                **selection,
                "format": format,
                "password": context.admin_password,
            },
        ).json()
        check("password" not in job["request"], "proof_not_persisted")
        export_path = exports + "/" + job["id"]
        deadline, cycle = time.monotonic() + 30, 0
        while job["status"] in ("pending", "running") and time.monotonic() < deadline:
            job = call("GET", export_path, f"poll:{format}:{cycle}").json()
            cycle += 1
            if job["status"] in ("pending", "running"):
                time.sleep(0.1)  # Bounded observation of the actual worker, not a test-order delay.
        check(job["status"] == "succeeded", "background_export")
        check("artifact_key" not in job, "private_metadata")
        response = call("GET", export_path + "/content", "download:" + format)
        check(
            response.headers["Cache-Control"] == "private, no-store"
            and response.headers["X-Content-Type-Options"] == "nosniff"
            and int(response.headers["Content-Length"]) == len(response.content),
            "safe_download",
        )
        if format == "csv":
            rows = list(csv.DictReader(io.StringIO(response.content.decode())))
            check(len(rows) == 1 and rows[0]["body"] == "'=SUM(1,2)", "real_csv")
        else:
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            check(
                not sheet.findall(".//s:f", namespace)
                and "=SUM(1,2)" in [node.text for node in sheet.findall(".//s:t", namespace)],
                "real_literal_xlsx",
            )
        call("GET", export_path + "/content", "member_download_denied:" + format, 403, actor=member)
    check(
        all(
            "artifact_key" not in row
            for row in call(
                "GET",
                exports,
                "export_list",
            ).json()["items"]
        ),
        "metadata_only_list",
    )
    current = call("GET", root, "before_archive")
    call("POST", root + "/archive", "archive", headers={"If-Match": current.headers["ETag"]})
    preview = call("POST", root + "/purge/preview", "purge_preview").json()
    check(preview["message_count"] == 1 and preview["file_count"] == 0, "source_file_count")
    result = call(
        "POST",
        root + "/purge",
        "purge",
        json_body={
            "token": preview["token"],
            "confirmation_name": preview["confirmation_name"],
            "password": context.admin_password,
        },
    ).json()
    check(result["purged_message_count"] == 1, "owned_source_purged")
    call("GET", root, "room_gone", 404)
    return _result(
        action, context, evidence, [], extra={"organization_id": org, "jobs_verified": True}
    )
