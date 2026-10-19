"""Exact S01 event payloads, with server-bound topic and identity checks."""

from typing import Any, Literal
from uuid import UUID

from app.systems.comms.messages.schemas import Sequence, Watermark, WireModel


class MessagePayload(WireModel):
    conversation_id: UUID
    seq: Sequence
    kind: Literal["created", "edited", "deleted", "reaction", "pin", "thread"]


class TypingPayload(WireModel):
    conversation_id: UUID
    user_id: UUID


class ReadPayload(WireModel):
    conversation_id: UUID
    last_read_seq: Watermark


class NotificationPayload(WireModel):
    id: UUID


class MembershipPayload(WireModel):
    conversation_id: UUID


class PresencePayload(WireModel):
    user_id: UUID
    state: Literal["online", "away", "offline"]


class EmptyPayload(WireModel):
    pass


PAYLOADS: dict[str, type[WireModel]] = {
    "message": MessagePayload,
    "typing": TypingPayload,
    "read": ReadPayload,
    "notification": NotificationPayload,
    "membership": MembershipPayload,
    "grants": EmptyPayload,
    "structure": EmptyPayload,
    "presence": PresencePayload,
}


def validated_envelope(
    envelope: dict[str, Any], *, org_id: UUID, actor_id: UUID, recipient_id: UUID | None = None
) -> dict[str, Any]:
    if set(envelope) != {"topic", "event", "private", "payload"} or envelope["private"] is not True:
        raise ValueError("Invalid private event")
    kind = envelope["event"]
    if not isinstance(kind, str) or kind not in PAYLOADS:
        raise ValueError("Invalid event kind")
    payload = PAYLOADS[kind].model_validate(envelope["payload"]).model_dump(mode="json")
    prefix = f"org:{org_id}:"
    if kind in ("message", "typing"):
        expected = prefix + "conversation:" + payload["conversation_id"]
    elif kind == "presence":
        expected = prefix + "presence"
    else:
        expected = prefix + "user:" + str(recipient_id or actor_id)
    if envelope["topic"] != expected or (
        kind in ("typing", "presence") and payload["user_id"] != str(actor_id)
    ):
        raise ValueError("Event context differs")
    return {"topic": expected, "event": kind, "private": True, "payload": payload}
