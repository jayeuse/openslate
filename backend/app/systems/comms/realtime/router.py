"""S20's three HTTP operations; browser writes to provider topics remain refused."""

from math import ceil
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select, text

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core import base_model
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error, require_conversation_access
from app.systems.comms.conversations.service import transaction
from app.systems.comms.messages.admission import posting_context
from app.systems.comms.realtime import presence
from app.systems.comms.realtime.models import CommsTyping
from app.systems.comms.realtime.publication import stage_comms_event
from app.systems.comms.realtime.schemas import (
    HeartbeatRequest,
    HeartbeatResponse,
    PresenceQuery,
    PresenceSnapshot,
)

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
router = APIRouter(prefix="/comms", tags=["comms"], dependencies=[Depends(get_current_membership)])


@router.get("/presence", response_model=PresenceSnapshot)
def get_presence(
    query: Annotated[PresenceQuery, Query()], db: DB, actor: Actor, response: Response
) -> PresenceSnapshot:
    response.headers["Cache-Control"] = "no-store"
    return presence.snapshot(db, actor, query.user_ids)


@router.post("/presence", response_model=HeartbeatResponse)
def post_presence(
    request: HeartbeatRequest, db: DB, actor: Actor, response: Response
) -> HeartbeatResponse:
    with transaction(db):
        presence.heartbeat(db, actor, request.state)
        result = presence.watermarks(db, actor, request.known_sequences)
        response.headers["Cache-Control"] = "no-store"
    return result


@router.post(
    "/conversations/{conversation_id}/typing",
    status_code=204,
    responses={
        429: {
            "description": "One typing admission per actor/conversation every two seconds",
            "headers": {"Retry-After": {"schema": {"type": "integer", "minimum": 1}}},
        },
    },
)
def post_typing(conversation_id: UUID, db: DB, actor: Actor, response: Response) -> None:
    with transaction(db):
        org = bound_organization(db)
        db.connection().execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"comms:typing:{org}:{actor.id}:{conversation_id}"},
        )
        require_conversation_access(db, actor, conversation_id, "post")
        posting_context(db, actor, conversation_id)
        row = db.scalar(
            select(CommsTyping)
            .where(
                CommsTyping.org_id == org,
                CommsTyping.user_id == actor.id,
                CommsTyping.conversation_id == conversation_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        now = base_model.utc_now()
        if row is not None and (elapsed := (now - row.last_sent_at).total_seconds()) < 2:
            refused = error("comms_rate_limited", "Wait before typing again", 429)
            refused.headers = {
                "Retry-After": str(max(1, ceil(2 - elapsed))),
                "Cache-Control": "no-store",
            }
            raise refused
        if row is None:
            row = CommsTyping(org_id=org, user_id=actor.id, conversation_id=conversation_id)
            db.add(row)
        row.last_sent_at = now
        stage_comms_event(
            db,
            org_id=org,
            actor_id=actor.id,
            envelope={
                "topic": f"org:{org}:conversation:{conversation_id}",
                "private": True,
                "event": "typing",
                "payload": {"conversation_id": str(conversation_id), "user_id": str(actor.id)},
            },
        )
        response.headers["Cache-Control"] = "no-store"
