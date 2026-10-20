"""Report-scoped authority never changes ordinary conversation readability."""

import hashlib
import json
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import (
    error,
    fresh_membership,
    readable_conversation_ids,
    require_conversation_access,
)
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.messages.mutations import (
    advance_generation,
    lock_counter,
    message_capacity_error,
)
from app.systems.comms.messages.reads import get_message
from app.systems.comms.moderation.models import CommsReport
from app.systems.comms.moderation.schemas import CommsReportResponse
from app.systems.comms.realtime.events import message_event, user_event


def exact_admin(db: Session, actor: User) -> bool:
    membership = fresh_membership(db, actor)
    return membership is not None and membership.role == "admin"


def require_capability(db: Session, actor: User, identity: UUID, capability: str) -> None:
    require_conversation_access(db, actor, identity, "read")
    if not capability_check(db, actor, identity)["capabilities"][capability]["allowed"]:
        raise error("comms_capability_denied", "Capability required", 403)


def queue_conversations(db: Session, actor: User) -> set[UUID] | None:
    if exact_admin(db, actor):
        return None
    return {identity for identity in readable_conversation_ids(db, actor)
            if capability_check(db, actor, identity)["capabilities"]["moderate"]["allowed"]}


def report_query() -> Select[tuple[CommsReport]]:
    return select(CommsReport).join(CommsMessage, (
        (CommsMessage.org_id == CommsReport.org_id)
        & (CommsMessage.id == CommsReport.message_id)
        & (CommsMessage.conversation_id == CommsReport.conversation_id)
    )).join(CommsConversation, (
        (CommsConversation.org_id == CommsReport.org_id)
        & (CommsConversation.id == CommsReport.conversation_id)
    )).where(
        CommsReport.org_id == bound_organization_column(), CommsReport.is_deleted.is_(False),
        CommsReport.deleted_at.is_(None), CommsConversation.is_deleted.is_(False),
        CommsConversation.deleted_at.is_(None),
    ).execution_options(populate_existing=True)


def load_report(
    db: Session, actor: User, identity: UUID, *, lock: bool = False, action: bool = False,
) -> tuple[CommsReport, CommsMessage]:
    report = db.scalar(report_query().where(CommsReport.id == identity))
    if report is None:
        raise error("comms_not_found", "Report not found")
    binding = report.conversation_id, report.message_id
    if lock:
        lock_counter(db, binding[0])
        db.scalar(select(CommsConversation).where(
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.id == binding[0],
        ).with_for_update().execution_options(populate_existing=True))
    message = get_message(db, binding[0], message_id=binding[1], lock=lock)
    query = report_query().where(CommsReport.id == identity)
    report = db.scalar(query.with_for_update(of=CommsReport) if lock else query)
    if report is None or (report.conversation_id, report.message_id) != binding:
        raise error("comms_not_found", "Report not found")
    if exact_admin(db, actor):
        if lock:
            require_fresh_exact_admin(db, actor.id)
    else:
        require_capability(db, actor, binding[0], "moderate")
        if action:
            require_capability(db, actor, binding[0], "deleteOthersMessages")
    return report, message


def report_version(report: CommsReport, message: CommsMessage) -> str:
    payload = {"namespace": "comms-report-source-v1",
               "report": CommsReportResponse.model_validate(report).model_dump(mode="json"),
               "generation": message.mutation_generation, "deleted": message.is_deleted,
               "deleted_at": message.deleted_at}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    return f'"{digest}"'


def match(value: str | None, expected: str) -> None:
    if value is None:
        raise error("comms_precondition_required", "If-Match is required", 428)
    if value != expected:
        raise error("comms_precondition_failed", "Resource changed", 412)


def tombstone(db: Session, message: CommsMessage, actor: User, *, restore: bool) -> None:
    if message.is_deleted == (not restore):
        return
    if restore:
        counts = [db.scalar(select(func.count()).select_from(model).where(
            model.org_id == bound_organization_column(), model.message_id == message.id,
            model.is_deleted.is_(False), model.deleted_at.is_(None),
        )) or 0 for model in (CommsMessageAttachment, CommsMessageRecordLink)]
        reason = message_capacity_error(message.body, counts[0], counts[1])
        if reason is not None:
            raise error("comms_invalid_input", reason, 422)
    advance_generation(message)
    message.is_deleted, message.deleted_at = not restore, None if restore else utc_now()
    message.deleted_by = None if restore else actor.id
    message_event(db, message.conversation_id, message.seq, "edited" if restore else "deleted")


def queue_event(db: Session, conversation_id: UUID) -> None:
    candidates = db.scalars(select(User).join(Membership, bound_membership_join())).all()
    for actor in candidates:
        try:
            if not exact_admin(db, actor):
                require_capability(db, actor, conversation_id, "moderate")
        except HTTPException:
            continue
        user_event(db, actor.id, "structure", {})
