"""Tier2-D2 conversation purge with the existing password challenge and Storage guards."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from uuid6 import uuid7

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.messages.schemas import Watermark, WireModel
from app.systems.comms.moderation import purge
from app.systems.manage.audit.context import get_audit_context
from app.systems.platform.files.providers import StorageBackend, hold_file_worker
from app.systems.platform.files.storage import get_storage
from app.systems.sandbox.lifecycle.exceptions import LifecycleError
from app.systems.sandbox.lifecycle.purge_support import last_successful_backup_at
from app.systems.sandbox.lifecycle.schemas import LifecyclePurgeRequest
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
router = APIRouter(prefix="/comms/conversations", tags=["comms"],
                   dependencies=[Depends(get_current_membership)])


class PurgePreview(WireModel):
    org_id: UUID
    conversation_id: UUID
    message_count: Watermark
    file_count: Watermark
    max_seq: Watermark
    impact_digest: str
    token: str
    expires_at: datetime
    confirmation_name: str
    last_successful_backup_at: datetime | None


class PurgeResult(WireModel):
    org_id: UUID
    conversation_id: UUID
    operation_id: UUID
    purged_message_count: Watermark
    purged_file_count: Watermark


@router.post("/{conversation_id}/purge/preview", response_model=PurgePreview)
def preview(conversation_id: UUID, db: DB, actor: Actor, response: Response) -> PurgePreview:
    private(response)
    try:
        current = purge.impact(db, actor, conversation_id)
        issued = issue_challenge(db, actor.id, "purge", "comms_conversation", conversation_id,
                                 current.digest)
        return PurgePreview(
            org_id=current.conversation.org_id, conversation_id=conversation_id,
            message_count=current.message_count, file_count=current.file_count,
            max_seq=current.max_seq, impact_digest=current.digest,
            token=issued.token, expires_at=issued.expires_at, confirmation_name=current.name,
            last_successful_backup_at=last_successful_backup_at(db),
        )
    except LifecycleError as exc:
        raise error(str(exc.code), exc.detail, exc.status_code) from exc


@router.post("/{conversation_id}/purge", response_model=PurgeResult)
def execute(conversation_id: UUID, payload: LifecyclePurgeRequest, request: Request,
            db: DB, actor: Actor, response: Response,
            storage: Annotated[StorageBackend, Depends(get_storage)]) -> PurgeResult:
    private(response)
    with transaction(db):
        current = purge.impact(db, actor, conversation_id)
        if payload.confirmation_name != current.name:
            raise error(
                "confirmation_name_mismatch", "Confirmation must match the conversation name", 422,
            )
        try:
            expected = challenge_impact_digest(db, payload.token, actor.id, "purge",
                                               "comms_conversation", conversation_id)
            verify_challenge(db, payload.token, actor.id, "purge", "comms_conversation",
                             conversation_id, expected, actor.email, payload.password)
        except LifecycleError as exc:
            raise error(str(exc.code), exc.detail, exc.status_code) from exc
        if current.file_count or current.export_count:
            with hold_file_worker(request):
                purge.delete_files(
                    db, actor, conversation_id, expected, payload.confirmation_name, storage,
                )
        current = purge.delete_graph(
            db, actor, conversation_id, expected, payload.confirmation_name,
        )
        result = PurgeResult(
            org_id=current.conversation.org_id, conversation_id=conversation_id,
            operation_id=get_audit_context(db).request_id or uuid7(),
            purged_message_count=current.message_count, purged_file_count=current.file_count,
        )
    return result
