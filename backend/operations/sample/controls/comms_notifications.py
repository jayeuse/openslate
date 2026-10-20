"""Primary/partner send-to-inbox receipts through the existing notification API."""

from typing import Any
from uuid import uuid4

import httpx

from app.systems.comms.messages.schemas import LiveMessage
from app.systems.comms.notifications import CommsNotificationResponse
from app.systems.platform.scheduling.notification_router import (
    NotificationListResponse,
    UnreadCountResponse,
)
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _request,
    _result,
)


def plan_comms_notification_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    recipient = next(person.key for person in dataset.organization.actors.people
                     if person.role == "member" and person.status == "active")
    return tuple(PhaseAction(
        key=f"control:comms:{org}-notifications", phase="reorganization", kind="comms_controls",
        actor_key="admin", target_key=f"{org}:comms:messages",
        values={"operation": "notification_roundtrip" if org == "primary"
                else "partner_notification_roundtrip", "organization": org,
                "recipient_key": recipient},
        expected_status=200, expected_detail=None,
        expected_end_state={"notifications_verified": True},
    ) for org in ("primary", "partner"))


def execute_comms_notification_control(
    action: PhaseAction, dataset: SampleDataset, context: PhaseExecutionContext,
    *, on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_comms_notification_controls(dataset):
        raise SamplePhaseActionError("Unsupported Comms notification operation", step=action.key)
    recipient = str(action.values["recipient_key"])
    if action.values["organization"] == "partner":
        admin_factory = context.private_values.get("partner_admin")
        actor_factory = context.private_values.get("partner_actor")
        if not callable(admin_factory) or not callable(actor_factory):
            raise SamplePhaseActionError("Partner clients are unavailable", step=action.key)
        admin, peer = admin_factory(), actor_factory(recipient)
        check(
            admin.organization_id == peer.organization_id
            and admin.organization_id != context.clients["admin"].organization_id,
            "partner_binding",
        )
        context = bound_context(context, {**context.clients, "admin": admin, recipient: peer})
    org = _id({"org": context.clients["admin"].organization_id}, "org",
              label="organization", step=action.key)
    check(context.clients[recipient].organization_id == org, "recipient_binding")
    person = _id(context.user_ids, recipient, label="recipient", step=action.key)
    author = _id(context.user_ids, "admin", label="author", step=action.key)
    check(person != author, "different_recipient")
    conversation = _mapped_id(context, "comms_conversations", action.target_key, step=action.key)
    evidence: list[dict[str, object]] = []

    def call(method: str, path: str, step: str, expected: int = 200,
             actor: str = recipient, **kwargs: Any) -> httpx.Response:
        return _request(action, context, evidence, actor_key=actor, method=method, path=path,
                        step=step, expected=expected, on_substep=on_substep, **kwargs)

    def count(step: str) -> int:
        return UnreadCountResponse.model_validate_json(
            call("GET", "/api/notifications/unread-count", step).content,
        ).unread_count

    def source_rows(
        message: str, step: str, actor: str = recipient,
    ) -> list[CommsNotificationResponse]:
        offset, matches = 0, []
        while True:
            response = call("GET", "/api/notifications", f"{step}:{offset}", actor=actor,
                            params={"limit": 100, "offset": offset})
            check(response.headers.get("Cache-Control") == "private, no-store", "inbox_cache")
            page = NotificationListResponse.model_validate_json(response.content)
            for row in page.items:
                if isinstance(row, CommsNotificationResponse):
                    check(str(row.org_id) == org, "inbox_organization")
                    if str(row.message_id) == message:
                        matches.append(row)
            if not page.pagination.has_more:
                return matches
            check(bool(page.items), "inbox_pagination")
            offset += len(page.items)

    before = count("before_count")
    path = f"/api/comms/conversations/{conversation}/messages"
    payload = {"client_key": str(uuid4()), "body": "Owned notification delivery check",
               "mention_user_ids": [person]}
    sent = LiveMessage.model_validate_json(call(
        "POST", path, "send", 201, actor="admin", json_body=payload,
        primary_entity_type="comms_messages", primary_action="create", expected_audit_rows=1,
        related_entity_types=("comms_mentions", "in_app_notifications"),
    ).content)
    check(str(sent.org_id) == org and str(sent.conversation_id) == conversation
          and str(sent.author_id) == author, "sent_source")
    replay = LiveMessage.model_validate_json(call(
        "POST", path, "replay", actor="admin", json_body=payload, expected_audit_rows=0,
    ).content)
    check(replay.id == sent.id and replay.seq == sent.seq, "replay_source")
    rows = source_rows(str(sent.id), "recipient_inbox")
    check(len(rows) == 1, "one_recipient_notice")
    notice = rows[0]
    check(notice.kind == "comms-mention" and notice.subject_id == sent.id
          and str(notice.conversation_id) == conversation and notice.read_at is None,
          "notification_reference")
    check(count("after_send_count") == before + 1, "one_unread_increment")
    check(source_rows(str(sent.id), "author_inbox", actor="admin") == [], "no_author_notice")
    read_path = f"/api/notifications/{notice.id}/read"
    marked = CommsNotificationResponse.model_validate_json(
        call("POST", read_path, "mark_read").content,
    )
    repeated = CommsNotificationResponse.model_validate_json(call(
        "POST", read_path, "repeat_read", expected_audit_rows=0,
    ).content)
    check(marked.id == notice.id and marked.status == "read" and marked.read_at is not None
          and marked == repeated, "read_idempotence")
    check(source_rows(str(sent.id), "current_readback") == [marked], "independent_readback")
    check(count("after_read_count") == before, "read_count_restored")
    return _result(action, context, evidence, [], extra={
        "organization_id": org, "notifications_verified": True,
        "notification_id": str(notice.id), "message_id": str(sent.id), "message_seq": sent.seq,
    })
