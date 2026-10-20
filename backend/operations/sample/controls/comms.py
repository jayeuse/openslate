"""Message-family sample operations over an explicitly mapped, owned conversation."""

from collections.abc import Mapping
from typing import Any, TypedDict
from uuid import uuid4

import httpx
from pydantic import TypeAdapter, ValidationError

from app.systems.comms.messages.schemas import (
    BootstrapResponse,
    HistoryResponse,
    LiveMessage,
    MessageResponse,
    ReadResponse,
    Tombstone,
)
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _id,
    _mapped_id,
    _record_mapping,
    _request,
    _result,
)

MESSAGE: TypeAdapter[LiveMessage | Tombstone] = TypeAdapter(MessageResponse)
TARGET = "primary:comms:message-roundtrip"
CONVERSATION = "primary:comms:messages"


class _MessageBinding(TypedDict):
    org: str
    conversation: str
    actor: str
    client_key: str


def plan_comms_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    return (
        PhaseAction(
            key="control:comms:message-roundtrip",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=TARGET,
            values={
                "operation": "message_roundtrip",
                "organization": "primary",
                "conversation_key": CONVERSATION,
                "body": f"{dataset.organization.identity.workspace_name}: message delivery check.",
                "edited_body": (
                    f"{dataset.organization.identity.workspace_name}: delivery check completed."
                ),
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "message_edited": True,
                "message_deleted": True,
                "read_marked": True,
            },
        ),
    )


def _message(
    response: httpx.Response,
    *,
    org: str,
    conversation: str,
    actor: str,
    client_key: str,
    step: str,
    versioned: bool = False,
) -> LiveMessage | Tombstone:
    try:
        message = MESSAGE.validate_json(response.content)
    except ValidationError as exc:
        raise SamplePhaseActionError("Invalid message response", step=step) from exc
    tag = response.headers.get("ETag", "")
    if (
        (
            str(message.org_id),
            str(message.conversation_id),
            str(message.author_id),
            str(message.client_key),
        )
        != (org, conversation, actor, client_key)
        or versioned
        and not (len(tag) > 2 and tag.startswith('"') and tag.endswith('"'))
    ):
        raise SamplePhaseActionError("Message identity or validator differs", step=step)
    return message


def execute_comms_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action.values.get("operation") in ("direct_candidates", "partner_direct_candidates"):
        from operations.sample.controls.comms_candidates import execute_candidate_control

        return execute_candidate_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in ("jobs_roundtrip", "partner_jobs_roundtrip"):
        from operations.sample.controls.comms_jobs import execute_comms_job_control

        return execute_comms_job_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in ("moderation_roundtrip", "partner_moderation_roundtrip"):
        from operations.sample.controls.comms_moderation import execute_moderation_control

        return execute_moderation_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in (
        "notification_roundtrip",
        "partner_notification_roundtrip",
    ):
        from operations.sample.controls.comms_notifications import (
            execute_comms_notification_control,
        )

        return execute_comms_notification_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in ("presence_roundtrip", "partner_presence_roundtrip"):
        from operations.sample.controls.comms_presence import execute_presence_control

        return execute_presence_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in ("token_roundtrip", "partner_token_roundtrip"):
        from operations.sample.controls.comms_realtime import execute_token_control

        return execute_token_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in ("search_roundtrip", "partner_search_roundtrip"):
        from operations.sample.controls.comms_search import execute_search_control

        return execute_search_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in ("s18_content", "partner_s18_content"):
        from operations.sample.controls.comms_content import execute_content_control

        return execute_content_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") in ("preferences_settings", "partner_preferences_settings"):
        from operations.sample.controls.comms_settings import execute_settings_control

        return execute_settings_control(action, dataset, context, on_substep=on_substep)
    if action.values.get("operation") != "message_roundtrip":
        from operations.sample.controls.comms_structure import execute_structure_control

        return execute_structure_control(action, dataset, context, on_substep=on_substep)
    if action not in plan_comms_controls(dataset):
        raise SamplePhaseActionError("Unsupported Comms message operation", step=action.key)
    client = _client(context, action.actor_key, step=action.key)
    org = _id({"org": client.organization_id}, "org", label="organization", step=action.key)
    actor = _id(context.user_ids, action.actor_key, label="actor", step=action.key)
    conversation = _mapped_id(context, "comms_conversations", CONVERSATION, step=action.key)
    collection = f"/api/comms/conversations/{conversation}/messages"
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []

    def call(method: str, path: str, step: str, status: int = 200, **kwargs: Any) -> httpx.Response:
        return _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method=method,
            path=path,
            step=step,
            expected=status,
            on_substep=on_substep,
            **kwargs,
        )

    try:
        snapshot = BootstrapResponse.model_validate_json(
            call("GET", "/api/comms/bootstrap", "bootstrap").content
        )
        if (str(snapshot.org_id), str(snapshot.user_id)) != (org, actor):
            raise SamplePhaseActionError("Bootstrap context differs", step="bootstrap")
        client_key = str(uuid4())
        payload = {"client_key": client_key, "body": action.values["body"]}
        binding: _MessageBinding = {
            "org": org,
            "conversation": conversation,
            "actor": actor,
            "client_key": client_key,
        }
        created = call(
            "POST",
            collection,
            "send",
            201,
            json_body=payload,
            primary_entity_type="comms_messages",
            primary_action="create",
            expected_audit_rows=1,
        )
        message = _message(created, **binding, step="send")
        if not isinstance(message, LiveMessage) or message.body != payload["body"]:
            raise SamplePhaseActionError("Created message differs", step="send")
        evidence[-1]["primary_entity_id"] = str(message.id)
        item = f"{collection}/{message.id}"
        if created.headers.get("Location") != item:
            raise SamplePhaseActionError("Message location differs", step="send")
        _record_mapping(
            context, client, "comms_messages", action.target_key, str(message.id), mappings
        )
        original = _message(
            call("GET", item, "before_edit"), **binding, step="before_edit", versioned=True
        )
        if original != message:
            raise SamplePhaseActionError("Created readback differs", step="before_edit")
        edited_body = action.values["edited_body"]
        patch = {
            "body": edited_body,
            "mention_user_ids": [],
            "mentions_channel": False,
            "mentions_here": False,
        }
        edited = _message(
            call(
                "PATCH",
                item,
                "edit",
                json_body=patch,
                primary_entity_type="comms_messages",
                primary_entity_id=str(message.id),
                primary_action="update",
                expected_audit_rows=1,
                related_entity_types=("comms_message_revisions",),
            ),
            **binding,
            step="edit",
            versioned=True,
        )
        current = _message(
            call("GET", item, "after_edit"), **binding, step="after_edit", versioned=True
        )
        if not isinstance(current, LiveMessage) or current.body != edited_body or current != edited:
            raise SamplePhaseActionError("Edited readback differs", step="after_edit")
        replay = _message(
            call("POST", collection, "replay", json_body=payload), **binding, step="replay"
        )
        if replay != current:
            raise SamplePhaseActionError("Replay is not current", step="replay")
        exact = _message(
            call("GET", f"{collection}/by-sequence/{message.seq}", "sequence"),
            **binding,
            step="sequence",
            versioned=True,
        )
        page = HistoryResponse.model_validate_json(
            call(
                "GET",
                collection,
                "history",
                params={"around_seq": message.seq, "limit": 50},
            ).content
        )
        if (
            exact != current
            or current not in page.items
            or str(page.conversation_id) != conversation
        ):
            raise SamplePhaseActionError("History readback differs", step="history")
        read = ReadResponse.model_validate_json(
            call(
                "PUT",
                f"/api/comms/conversations/{conversation}/read",
                "mark_read",
                json_body={"last_read_seq": message.seq},
            ).content
        )
        if str(read.conversation_id) != conversation or read.last_read_seq < message.seq:
            raise SamplePhaseActionError("Read watermark differs", step="mark_read")
        deleted = _message(
            call(
                "DELETE",
                item,
                "delete",
                primary_entity_type="comms_messages",
                primary_entity_id=str(message.id),
                primary_action="delete",
                expected_audit_rows=1,
            ),
            **binding,
            step="delete",
            versioned=True,
        )
        final = _message(
            call("GET", item, "after_delete"), **binding, step="after_delete", versioned=True
        )
        if not isinstance(final, Tombstone) or final != deleted:
            raise SamplePhaseActionError("Deleted readback differs", step="after_delete")
    except ValidationError as exc:
        raise SamplePhaseActionError("Invalid Comms readback", step=action.key) from exc
    return _result(
        action,
        context,
        evidence,
        mappings,
        extra={
            "organization_id": org,
            "conversation_id": conversation,
            "message_id": str(message.id),
            "message_edited": True,
            "message_deleted": True,
            "read_marked": True,
        },
    )


def verify_comms_controls(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    actions = plan_comms_controls(dataset)
    rows = manifest.get("control_results", [])
    issues = []
    for action in actions:
        matches = [
            row for row in rows if isinstance(row, Mapping) and row.get("action_key") == action.key
        ]
        if len(matches) != 1:
            issues.append("Comms execution result is missing or duplicated")
            continue
        row = matches[0]
        if any(row.get(key) is not value for key, value in action.expected_end_state.items()):
            issues.append("Comms execution state is incomplete")
            continue
        conversation, message = row.get("conversation_id"), row.get("message_id")
        collection = f"/api/comms/conversations/{conversation}/messages"
        item = f"{collection}/{message}"
        expected = [
            ("POST", collection, 201),
            ("PATCH", item, 200),
            ("POST", collection, 200),
            ("PUT", f"/api/comms/conversations/{conversation}/read", 200),
            ("DELETE", item, 200),
        ]
        receipts = row.get("request_evidence", [])
        if (
            [(r.get("method"), r.get("path"), r.get("status_code")) for r in receipts] != expected
            or row.get("organization_id") != manifest.get("organization_id")
            or row.get("actor_id") != admin_id
        ):
            issues.append("Comms request evidence differs from the message operation")
            continue
        response = client.request("GET", item)
        try:
            current = MESSAGE.validate_json(response.content)
            if (
                response.status_code != 200
                or not isinstance(current, Tombstone)
                or (str(current.id), str(current.org_id), str(current.conversation_id))
                != (message, row["organization_id"], conversation)
            ):
                issues.append("Comms final tombstone differs")
        except ValidationError:
            issues.append("Comms final readback is invalid")
    return {"comms_messages_verified": len(actions) if not issues else 0}, issues
