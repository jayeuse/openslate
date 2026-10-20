"""S18 thread state and replies; all shared writes retain current capability checks."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import StandardListResponse
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import current_membership
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.messages import thread_state
from app.systems.comms.messages.admission import posting_context
from app.systems.comms.messages.commands import send
from app.systems.comms.messages.interaction_models import CommsThread
from app.systems.comms.messages.interaction_schemas import FollowRequest, ThreadList, ThreadPatch
from app.systems.comms.messages.reads import history
from app.systems.comms.messages.schemas import (
    HistoryRequest,
    HistoryResponse,
    MessageResponse,
    ReplyRequest,
    ThreadResponse,
)
from app.systems.comms.realtime.events import message_event

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
router = APIRouter(prefix="/comms", tags=["comms"], dependencies=[Depends(get_current_membership)])
VERSIONED: dict[int | str, dict[str, Any]] = {
    200: {"headers": {"ETag": {"schema": {"type": "string"}}}}
}
T = "/conversations/{conversation_id}/threads/{root_message_id}"


@router.get(T, response_model=ThreadResponse, responses=VERSIONED)
def get_thread(
    conversation_id: UUID, root_message_id: UUID, db: DB, actor: Actor, response: Response
) -> ThreadResponse:
    root = thread_state.root(db, actor, conversation_id, root_message_id, lock=True, shared=True)
    return thread_state.response(db, actor, root, response)


@router.post(
    T,
    response_model=ThreadResponse,
    status_code=201,
    responses={
        **VERSIONED,
        201: {
            "headers": {
                "ETag": {"schema": {"type": "string"}},
                "Location": {"schema": {"type": "string"}},
            }
        },
    },
)
def create_thread(
    conversation_id: UUID, root_message_id: UUID, db: DB, actor: Actor, response: Response
) -> ThreadResponse:
    with transaction(db):
        root = thread_state.root(db, actor, conversation_id, root_message_id, lock=True)
        _, _, settings = posting_context(db, actor, conversation_id)
        if not capability_check(db, actor, conversation_id)["capabilities"]["createThread"][
            "allowed"
        ]:
            raise error("comms_capability_denied", "Capability required", 403)
        existing = thread_state.get(db, root)
        if existing is None:
            db.add(
                CommsThread(
                    org_id=root.org_id, conversation_id=conversation_id, root_message_id=root.id
                )
            )
            if settings["default_thread_subscription"]:
                thread_state.follow(db, actor, root, True)
            response.headers["Location"] = (
                f"/api/comms/conversations/{conversation_id}/threads/{root.id}"
            )
            message_event(db, conversation_id, root.seq, "thread")
        else:
            response.status_code = 200
        value = thread_state.response(db, actor, root, response)
    return value


@router.patch(
    T,
    response_model=ThreadResponse,
    responses={
        **VERSIONED,
        428: {"description": "If-Match required"},
        412: {"description": "Thread changed"},
    },
)
def update_thread(
    conversation_id: UUID,
    root_message_id: UUID,
    payload: ThreadPatch,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> ThreadResponse:
    with transaction(db):
        root = thread_state.root(db, actor, conversation_id, root_message_id, lock=True)
        row = thread_state.get(db, root)
        if row is None:
            raise error("comms_not_found", "Thread not found")
        own_resolve = root.author_id == actor.id and payload.model_fields_set <= {"resolved"}
        membership = current_membership(db, actor)
        if own_resolve:
            allowed = membership is not None and membership.role != "guest"
        else:
            allowed = capability_check(db, actor, conversation_id)["capabilities"]["manageThreads"][
                "allowed"
            ]
        if not allowed:
            raise error("comms_capability_denied", "Capability required", 403)
        if if_match is None:
            raise error("comms_precondition_required", "If-Match is required", 428)
        if if_match != thread_state.version(row, root):
            raise error("comms_precondition_failed", "Thread changed", 412)
        values = payload.model_dump(exclude_unset=True)
        changed = any(getattr(row, key) != value for key, value in values.items())
        for key, value in values.items():
            setattr(row, key, value)
        if changed:
            message_event(db, conversation_id, root.seq, "thread")
        result = thread_state.response(db, actor, root, response)
    return result


@router.get(T + "/replies", response_model=HistoryResponse)
def get_replies(
    conversation_id: UUID,
    root_message_id: UUID,
    db: DB,
    actor: Actor,
    response: Response,
    request: Annotated[HistoryRequest, Query()],
) -> HistoryResponse:
    thread_state.root(db, actor, conversation_id, root_message_id)
    private(response)
    return history(db, actor.id, conversation_id, request, root_message_id=root_message_id)


@router.post(
    T + "/replies",
    response_model=MessageResponse,
    status_code=201,
    responses={
        200: {"description": "Current replay"},
        201: {"headers": {"Location": {"schema": {"type": "string"}}}},
    },
)
def send_reply(
    conversation_id: UUID,
    root_message_id: UUID,
    payload: ReplyRequest,
    db: DB,
    actor: Actor,
    response: Response,
) -> Any:
    message, replayed = send(db, actor, conversation_id, payload, parent_id=root_message_id)
    private(response)
    response.status_code = 200 if replayed else 201
    if not replayed:
        response.headers["Location"] = (
            f"/api/comms/conversations/{conversation_id}/messages/{message.id}"
        )
    return message


@router.put(T + "/follow", response_model=ThreadResponse)
def follow_thread(
    conversation_id: UUID,
    root_message_id: UUID,
    payload: FollowRequest,
    db: DB,
    actor: Actor,
    response: Response,
) -> ThreadResponse:
    with transaction(db):
        root = thread_state.root(db, actor, conversation_id, root_message_id, lock=True)
        if thread_state.get(db, root) is None:
            raise error("comms_not_found", "Thread not found")
        if thread_state.follow(db, actor, root, payload.followed):
            message_event(db, conversation_id, root.seq, "thread")
        value = thread_state.response(db, actor, root, response)
    return value


@router.get("/threads", response_model=StandardListResponse[ThreadResponse])
def list_threads(
    db: DB, actor: Actor, response: Response, request: Annotated[ThreadList, Query()]
) -> Any:
    private(response)
    return thread_state.listing(db, actor, request)
