"""Owned disposable moderation/purge journeys; no existing conversation is destroyed."""

from typing import Any
from uuid import uuid4

import httpx

from app.systems.comms.moderation.schemas import CommsReportResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.dummy_files import dummy_file
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _request,
    _result,
)


def plan_moderation_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = next(person.key for person in dataset.organization.actors.people
                  if person.role == "member" and person.status == "active")
    return tuple(PhaseAction(
        key=f"control:comms:{org}-moderation", phase="reorganization", kind="comms_controls",
        actor_key="admin", target_key=f"{org}:comms:moderation-disposable",
        values={"operation": "moderation_roundtrip" if org == "primary"
                else "partner_moderation_roundtrip", "organization": org, "member_key": member},
        expected_status=200, expected_detail=None, expected_end_state={"moderation_verified": True},
    ) for org in ("primary", "partner"))


def execute_moderation_control(
    action: PhaseAction, dataset: SampleDataset, context: PhaseExecutionContext,
    *, on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_moderation_controls(dataset):
        raise SamplePhaseActionError("Unsupported moderation operation", step=action.key)
    member = str(action.values["member_key"])
    if action.values["organization"] == "partner":
        admin_factory, actor_factory = (context.private_values.get(key)
                                        for key in ("partner_admin", "partner_actor"))
        if not callable(admin_factory) or not callable(actor_factory):
            raise SamplePhaseActionError("Partner clients are unavailable", step=action.key)
        admin, peer = admin_factory(), actor_factory(member)
        check(admin.organization_id == peer.organization_id
              and admin.organization_id != context.clients["admin"].organization_id, "partner_org")
        context = bound_context(context, {**context.clients, "admin": admin, member: peer})
    org = _id({"org": context.clients["admin"].organization_id}, "org",
              label="organization", step=action.key)
    check(context.clients[member].organization_id == org, "member_org")
    person = _id(context.user_ids, member, label="member", step=action.key)
    evidence: list[dict[str, object]] = []

    def call(method: str, path: str, step: str, expected: int = 200,
             actor: str = "admin", **kwargs: Any) -> httpx.Response:
        return _request(action, context, evidence, actor_key=actor, method=method, path=path,
                        step=step, expected=expected, on_substep=on_substep, **kwargs)

    created = call("POST", "/api/comms/conversations", "create_owned_room", 201, json_body={
        "name": "Owned moderation check", "scope": "members", "member_ids": [person],
        "position": 0, "topic": "", "category_id": None,
    }).json()
    check(created["org_id"] == org, "room_org")
    root = "/api/comms/conversations/" + created["id"]
    content = dummy_file("moderation.png")
    file = call("POST", root + "/files", "reserve", 201, actor=member, json_body={
        "filename": "moderation.png", "expected_size": len(content),
    }).json()
    file_path = root + "/files/" + file["id"] + "/content"
    ready = call("PUT", file_path, "upload", actor=member, content=content,
                 headers={"Content-Type": "application/octet-stream"}).json()
    check(ready["state"] == "ready", "ready_file")
    source = call("POST", root + "/messages", "send", 201, actor=member, json_body={
        "client_key": str(uuid4()), "body": "Original moderation sample",
        "attachment_ids": [file["id"]],
    }).json()
    path = root + "/messages/" + source["id"]
    call("PATCH", path, "edit", actor=member, json_body={
        "body": "Current moderation sample", "mention_user_ids": [],
        "mentions_channel": False, "mentions_here": False,
    })
    revisions = call("GET", path + "/revisions", "revisions", actor=member).json()
    check(revisions["pagination"]["total"] == 1
          and revisions["items"][0]["body"] == source["body"], "retained_revision")
    check(call("POST", path + "/reports", "report", 204, actor=member,
               json_body={"reason": "Owned report review"}).content == b"", "report_ack")
    call("GET", "/api/comms/reports", "reporter_refused", 403, actor=member)
    offset = 0
    found: list[dict[str, Any]] = []
    while not found:
        page = call("GET", "/api/comms/reports", f"queue:{offset}",
                    params={"limit": 100, "offset": offset}).json()
        found = [row for row in page["items"] if row["message_id"] == source["id"]]
        if not found:
            check(page["pagination"]["has_more"] and bool(page["items"]), "report_present")
            offset += len(page["items"])
    check(len(found) == 1, "one_report")
    report_path = "/api/comms/reports/" + found[0]["id"]
    report = call("GET", report_path, "report_read")
    for operation in ("message-removal", "message-restoration"):
        report = call("POST", report_path + "/" + operation, operation,
                      headers={"If-Match": report.headers["ETag"]})
        body = CommsReportResponse.model_validate_json(report.content)
        check(body.status == "open" and str(body.org_id) == org, "body_free_report")
    resolved = call("POST", report_path + "/resolution", "resolve",
                    headers={"If-Match": report.headers["ETag"]})
    check(CommsReportResponse.model_validate_json(resolved.content).status == "resolved",
          "resolved")
    current = call("GET", path, "current_source")
    removed = call("POST", path + "/removal", "ordinary_remove",
                   headers={"If-Match": current.headers["ETag"]})
    check(removed.json()["state"] == "deleted" and "body" not in removed.json(), "tombstone")
    removed_page = call("GET", root + "/removed-messages", "removed_list").json()
    check([row["id"] for row in removed_page["items"]] == [source["id"]], "removed_source")
    restored = call("POST", path + "/restoration", "ordinary_restore",
                    headers={"If-Match": removed.headers["ETag"]}).json()
    check(restored["state"] == "live" and restored["body"] == "Current moderation sample",
          "restored")
    settings = call("GET", "/api/comms/settings/channel/" + created["id"], "settings")
    for people in ([person], []):
        settings = call("PUT", root + "/restrictions",
                        "restrict" if people else "clear_restriction",
                        headers={"If-Match": settings.headers["ETag"]},
                        json_body={"user_ids": people, "until": None})
    current = call("GET", root, "before_archive")
    call("POST", root + "/archive", "archive", headers={"If-Match": current.headers["ETag"]})
    preview = call("POST", root + "/purge/preview", "purge_preview").json()
    check(preview["message_count"] == 1 and preview["file_count"] == 1, "purge_scope")
    result = call("POST", root + "/purge", "purge", json_body={
        "token": preview["token"], "confirmation_name": preview["confirmation_name"],
        "password": context.admin_password,
    }).json()
    check(result["purged_message_count"] == result["purged_file_count"] == 1, "purged")
    call("GET", root, "room_gone", 404)
    call("GET", report_path, "report_gone", 404)
    call("GET", file_path, "file_gone", 404, actor=member)
    return _result(action, context, evidence, [], extra={
        "organization_id": org, "moderation_verified": True,
        "purged_conversation_id": created["id"],
    })
