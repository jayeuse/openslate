"""S18 API-only thread/file journeys over mapped owned conversations, with current readback."""

from typing import Any
from uuid import UUID, uuid4

import httpx

from app.common.listing import StandardListResponse
from app.systems.comms.files.router import CommsFile
from app.systems.comms.messages.schemas import (
    AvailableRecord,
    HistoryResponse,
    MessageResponse,
    ThreadResponse,
    UnavailableRecord,
)
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.comms_content_verification import REFERENCE
from operations.sample.controls.comms_content_verification import message_response as _message
from operations.sample.controls.comms_content_verification import (
    verify_content_control as verify_content_control,
)
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.controls.files_verification import check_download
from operations.sample.dummy_files import dummy_file
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _record_mapping,
    _request,
    _result,
)


def plan_content_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-content",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:messages",
            values={
                "operation": "s18_content" if org == "primary" else "partner_s18_content",
                "organization": org,
                "filename": f"{org}-weekly-briefing.pdf",
                "record_key": dataset.records[0].logical_id if org == "primary" else None,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"content_verified": True},
        )
        for org in ("primary", "partner")
    )


def execute_content_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_content_controls(dataset):
        raise SamplePhaseActionError("Unsupported S18 sample operation", step=action.key)
    organization = str(action.values["organization"])
    if organization == "partner":
        factory = context.private_values.get("partner_admin")
        if not callable(factory):
            raise SamplePhaseActionError("Partner client is unavailable", step=action.key)
        client = factory()
        check(client.organization_id != context.clients["admin"].organization_id, "partner_binding")
        context = bound_context(context, {**context.clients, "admin": client})
    client = context.clients["admin"]
    org = _id({"org": client.organization_id}, "org", label="organization", step=action.key)
    actor = _id(context.user_ids, "admin", label="actor", step=action.key)
    conversation = _mapped_id(context, "comms_conversations", action.target_key, step=action.key)
    records = []
    if organization == "primary":
        records.append(
            _mapped_id(context, "records", str(action.values["record_key"]), step=action.key)
        )
    path = f"/api/comms/conversations/{conversation}"
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []

    def call(
        method: str, url: str, step: str, expected: int = 200, **kwargs: Any
    ) -> httpx.Response:
        return _request(
            action,
            context,
            evidence,
            actor_key="admin",
            method=method,
            path=url,
            step=step,
            expected=expected,
            on_substep=on_substep,
            **kwargs,
        )

    filename = str(action.values["filename"])
    content = dummy_file(filename)
    reserved_response = call(
        "POST",
        path + "/files",
        "reserve",
        201,
        json_body={"filename": filename, "expected_size": len(content)},
    )
    reserved = CommsFile.model_validate_json(reserved_response.content)
    check(
        (str(reserved.org_id), str(reserved.conversation_id), str(reserved.creator_id))
        == (org, conversation, actor),
        "file_context",
    )
    check(
        reserved.state == "awaiting_upload"
        and reserved.actual_size is None
        and reserved.filename == filename,
        "file_reservation",
    )
    check(
        reserved_response.headers.get("Location") == path + f"/files/{reserved.id}", "file_location"
    )
    file_path = path + f"/files/{reserved.id}/content"
    ready = CommsFile.model_validate_json(
        call(
            "PUT",
            file_path,
            "upload",
            content=content,
            headers={"Content-Type": "application/octet-stream"},
        ).content
    )
    check(
        (ready.id, ready.org_id, ready.conversation_id, ready.creator_id)
        == (reserved.id, reserved.org_id, reserved.conversation_id, reserved.creator_id)
        and ready.state == "ready"
        and ready.actual_size == len(content),
        "file_ready",
    )
    _record_mapping(
        context,
        client,
        "comms_files",
        f"{organization}:comms:content-file",
        str(ready.id),
        mappings,
    )
    root_response = call(
        "POST",
        path + "/messages",
        "root",
        201,
        json_body={
            "client_key": str(uuid4()),
            "body": "",
            "attachment_ids": [str(ready.id)],
            "record_ids": records,
        },
    )
    root = _message(root_response, org, conversation)
    check(
        str(root.author_id) == actor
        and len(root.attachments) == 1
        and root.attachments[0].id == ready.id,
        "file_association",
    )
    check(
        root_response.headers.get("Location") == path + f"/messages/{root.id}", "message_location"
    )
    _record_mapping(
        context,
        client,
        "comms_messages",
        f"{organization}:comms:content-root",
        str(root.id),
        mappings,
    )
    thread_path = path + f"/threads/{root.id}"
    created = call("POST", thread_path, "create_thread", 201)
    thread = ThreadResponse.model_validate_json(created.content)
    check(
        thread.root_message_id == root.id
        and str(thread.conversation_id) == conversation
        and str(thread.org_id) == org
        and created.headers.get("Location") == thread_path,
        "thread_context",
    )
    _record_mapping(
        context,
        client,
        "comms_threads",
        f"{organization}:comms:content-thread",
        str(thread.id),
        mappings,
    )
    for value, step in ((False, "unfollow"), (True, "follow")):
        followed = ThreadResponse.model_validate_json(
            call("PUT", thread_path + "/follow", step, json_body={"followed": value}).content
        )
        check(followed.id == thread.id and followed.followed is value, "follow_readback")
    reply_body = {
        "client_key": str(uuid4()),
        "body": f"{dataset.organization.identity.workspace_name}: follow-up",
        "reply_to_id": str(root.id),
        "also_send_to_channel": True,
    }
    reply = _message(
        call("POST", thread_path + "/replies", "reply", 201, json_body=reply_body),
        org,
        conversation,
    )
    check(
        reply.parent_id == root.id and reply.reply_to_id == root.id and reply.also_send_to_channel,
        "reply_parent",
    )
    replay = _message(
        call("POST", thread_path + "/replies", "replay_reply", json_body=reply_body),
        org,
        conversation,
    )
    check(replay.id == reply.id and replay.seq == reply.seq, "reply_replay")
    replies = HistoryResponse.model_validate_json(
        call(
            "GET", thread_path + "/replies", "reply_history", params={"after_seq": root.seq}
        ).content
    )
    check(
        replies.thread_root_id == root.id and [row.id for row in replies.items] == [reply.id],
        "reply_history",
    )
    current = call("GET", thread_path, "thread_before_edit")
    tag = current.headers.get("ETag", "")
    check(len(tag) > 2 and tag.startswith('"') and tag.endswith('"'), "thread_validator")
    edited = ThreadResponse.model_validate_json(
        call(
            "PATCH",
            thread_path,
            "edit_thread",
            headers={"If-Match": tag},
            json_body={"name": "Follow-up", "resolved": True},
        ).content
    )
    check(edited.name == "Follow-up" and edited.resolved and edited.reply_count == 1, "thread_edit")
    threads = StandardListResponse[ThreadResponse].model_validate_json(
        call(
            "GET",
            "/api/comms/threads",
            "followed_threads",
            params={"followed": True, "resolved": True, "sort_order": "desc", "limit": 100},
        ).content
    )
    check(any(row.id == thread.id for row in threads.items), "thread_list")
    item = path + f"/messages/{root.id}"
    for method, step, present in (
        ("POST", "reaction_on", True),
        ("DELETE", "reaction_off", False),
        ("POST", "reaction_again", True),
    ):
        changed = _message(
            call(method, item + "/reactions", step, json_body={"emoji": "👍"}), org, conversation
        )
        check(
            any(row.emoji == "👍" and UUID(actor) in row.user_ids for row in changed.reactions)
            is present,
            "reaction_readback",
        )
    pinned = _message(
        call("PUT", item + "/pin", "pin", json_body={"pinned": True}), org, conversation
    )
    check(pinned.pinned_by == UUID(actor) and pinned.pinned_at is not None, "pin_readback")
    pins = StandardListResponse[MessageResponse].model_validate_json(
        call("GET", path + "/pins", "pins").content
    )
    check(any(row.id == root.id for row in pins.items), "pin_list")
    digest = check_download(
        call("GET", file_path, "download"),
        ready.model_dump(mode="json"),
        filename=filename,
        purpose="comms_attachment",
        step="download",
    )
    references = StandardListResponse[AvailableRecord | UnavailableRecord].model_validate_json(
        call(
            "GET",
            "/api/comms/record-references",
            "linked_records",
            params={"limit": 100, "sort_order": "desc"},
        ).content
    )
    reference_id = None
    if records:
        check(len(root.record_references) == 1, "record_association")
        reference_id = str(root.record_references[0].id)
        reference = REFERENCE.validate_json(
            call("GET", path + "/record-references/" + reference_id, "record_reference").content
        )
        check(
            isinstance(reference, AvailableRecord)
            and str(reference.record_id) == records[0]
            and any(row.id == reference.id for row in references.items),
            "record_readback",
        )
    else:
        check(root.record_references == [], "partner_catalog_isolation")
    result = _result(
        action,
        context,
        evidence,
        mappings,
        extra={
            "organization_id": org,
            "conversation_id": conversation,
            "root_message_id": str(root.id),
            "reply_message_id": str(reply.id),
            "thread_id": str(thread.id),
            "file": ready.model_dump(mode="json"),
            "digest": digest,
            "reference_id": reference_id,
            "record_id": records[0] if records else None,
            "content_verified": True,
            "record_reference_verified": bool(records),
        },
    )
    if verify_content_control(client, action, result, actor):
        raise SamplePhaseActionError("Content final readback differs", step=action.key)
    return result
