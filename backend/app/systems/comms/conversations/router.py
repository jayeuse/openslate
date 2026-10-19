"""S17 structure REST surface; preferences/settings and moderation stay separate."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import StandardListResponse
from app.core.base_model import utc_now
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.models import User
from app.systems.comms.access import error, require_conversation_access
from app.systems.comms.conversations import directs, mutations, reads, service
from app.systems.comms.conversations.schemas import (
    AccessRequest,
    BlockQuery,
    BlockRequest,
    CategoryQuery,
    CategoryRequest,
    ChannelPatch,
    ChannelRequest,
    ConversationQuery,
    DirectBlockResponse,
    DirectRequest,
    DuplicateRequest,
    GroupRequest,
    MemberQuery,
    MemberResponse,
    MemberRoleRequest,
)
from app.systems.comms.messages.schemas import Category, Conversation
from app.systems.comms.realtime.grants import revoke_stale

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
VERSION_HEADERS = {
    "ETag": {"description": "Opaque shared configuration token", "schema": {"type": "string"}}
}
VERSIONED: dict[int | str, dict[str, Any]] = {200: {"headers": VERSION_HEADERS}}
CREATED: dict[int | str, dict[str, Any]] = {
    201: {
        "headers": {
            **VERSION_HEADERS,
            "Location": {"schema": {"type": "string"}},
        }
    }
}
router = APIRouter(
    prefix="/comms",
    tags=["comms"],
    dependencies=[Depends(get_current_membership)],
    responses={
        403: {"description": "Current operation is not permitted"},
        404: {"description": "Absent or unreadable resource"},
        409: {"description": "Structure conflict; no changes saved"},
        412: {"description": "Shared configuration changed"},
        428: {"description": "If-Match is required for shared configuration"},
        503: {"description": "Structure operation unavailable"},
    },
)


@router.get("/conversations", response_model=StandardListResponse[Conversation])
def list_conversations(
    db: DB, actor: Actor, response: Response, query: Annotated[ConversationQuery, Query()]
) -> Any:
    service.private(response)
    return reads.conversation_page(db, actor, query)


@router.get("/conversations/{conversation_id}", response_model=Conversation, responses=VERSIONED)
def get_conversation(conversation_id: UUID, db: DB, actor: Actor, response: Response) -> Any:
    row = require_conversation_access(db, actor, conversation_id, "read")
    result = reads.conversation(db, actor, row)
    service.headers(db, response, row)
    return result


@router.get("/categories", response_model=StandardListResponse[Category])
def list_categories(
    db: DB, actor: Actor, response: Response, query: Annotated[CategoryQuery, Query()]
) -> Any:
    service.private(response)
    return reads.category_page(db, query)


@router.get("/categories/{category_id}", response_model=Category, responses=VERSIONED)
def get_category(category_id: UUID, db: DB, actor: Actor, response: Response) -> Category:
    row = service.category(db, category_id)
    result = reads.categories(db, [row])[0]
    service.headers(db, response, row)
    return result


@router.post("/categories", response_model=Category, status_code=201, responses=CREATED)
def create_category(payload: CategoryRequest, db: DB, actor: Actor, response: Response) -> Category:
    with service.transaction(db):
        row = mutations.create_category(db, actor, payload)
        result = reads.categories(db, [row])[0]
        service.headers(db, response, row)
        response.headers["Location"] = f"/api/comms/categories/{row.id}"
    return result


@router.put("/categories/{category_id}", response_model=Category, responses=VERSIONED)
def update_category(
    category_id: UUID,
    payload: CategoryRequest,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Category:
    with service.transaction(db):
        row = service.category(db, category_id, lock=True)
        service.require_management(db, actor, {"kind": "category", "id": category_id})
        service.match(db, row, if_match)
        mutations.update_category(db, row, payload)
        db.flush()
        result = reads.categories(db, [row])[0]
        service.headers(db, response, row)
    return result


@router.post("/conversations", response_model=Conversation, status_code=201, responses=CREATED)
def create_channel(payload: ChannelRequest, db: DB, actor: Actor, response: Response) -> Any:
    with service.transaction(db):
        row = mutations.create_channel(db, actor, payload)
        db.flush()
        result = reads.conversation(db, actor, row)
        service.headers(db, response, row)
        response.headers["Location"] = f"/api/comms/conversations/{row.id}"
    return result


@router.patch("/conversations/{conversation_id}", response_model=Conversation, responses=VERSIONED)
def update_channel(
    conversation_id: UUID,
    payload: ChannelPatch,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Any:
    with service.transaction(db):
        row = service.manage_conversation(db, actor, conversation_id)
        service.match(db, row, if_match)
        mutations.update_channel(db, row, payload)
        mutations.retain_read(db, actor, row)
        revoke_stale(db)
        result = reads.conversation(db, actor, row)
        service.headers(db, response, row)
    return result


def _archive(
    identity: UUID,
    db: AuditSession,
    actor: User,
    response: Response,
    if_match: str | None,
    enabled: bool,
) -> Any:
    with service.transaction(db):
        row = service.manage_conversation(db, actor, identity)
        service.match(db, row, if_match)
        row.archived_at, row.updated_at = utc_now() if enabled else None, utc_now()
        mutations.retain_read(db, actor, row)
        revoke_stale(db)
        result = reads.conversation(db, actor, row)
        service.headers(db, response, row)
    return result


@router.post(
    "/conversations/{conversation_id}/archive", response_model=Conversation, responses=VERSIONED
)
def archive(
    conversation_id: UUID, db: DB, actor: Actor, response: Response, if_match: Match = None
) -> Any:
    return _archive(conversation_id, db, actor, response, if_match, True)


@router.post(
    "/conversations/{conversation_id}/restore", response_model=Conversation, responses=VERSIONED
)
def restore(
    conversation_id: UUID, db: DB, actor: Actor, response: Response, if_match: Match = None
) -> Any:
    return _archive(conversation_id, db, actor, response, if_match, False)


@router.post(
    "/directs", response_model=Conversation, status_code=201, responses={**CREATED, **VERSIONED}
)
def direct(payload: DirectRequest, db: DB, actor: Actor, response: Response) -> Any:
    with service.transaction(db):
        row, created = directs.find_or_create(db, actor, payload.recipient_id)
        result = reads.conversation(db, actor, row)
        service.headers(db, response, row)
        response.status_code = 201 if created else 200
        if created:
            response.headers["Location"] = f"/api/comms/conversations/{row.id}"
    return result


@router.post("/groups", response_model=Conversation, status_code=201, responses=CREATED)
def group(payload: GroupRequest, db: DB, actor: Actor, response: Response) -> Any:
    with service.transaction(db):
        row = directs.create_group(db, actor, payload.name, payload.participant_ids)
        result = reads.conversation(db, actor, row)
        service.headers(db, response, row)
        response.headers["Location"] = f"/api/comms/conversations/{row.id}"
    return result


@router.get(
    "/conversations/{conversation_id}/members", response_model=StandardListResponse[MemberResponse]
)
def list_members(
    conversation_id: UUID,
    db: DB,
    actor: Actor,
    response: Response,
    query: Annotated[MemberQuery, Query()],
) -> Any:
    require_conversation_access(db, actor, conversation_id, "read")
    service.private(response)
    return reads.member_page(db, conversation_id, query)


@router.put(
    "/conversations/{conversation_id}/access", response_model=Conversation, responses=VERSIONED
)
def set_access(
    conversation_id: UUID,
    payload: AccessRequest,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Any:
    with service.transaction(db):
        row = service.manage_conversation(db, actor, conversation_id)
        service.require_channel(row)
        if row.scope != "groups":
            raise error("comms_invalid", "Group-scoped channel required", 422)
        service.match(db, row, if_match)
        service.replace_access(db, row, payload.access)
        row.updated_at = utc_now()
        mutations.retain_read(db, actor, row)
        revoke_stale(db)
        result = reads.conversation(db, actor, row)
        service.headers(db, response, row)
    return result


@router.put("/conversations/{conversation_id}/members/{user_id}", response_model=MemberResponse)
def set_member_role(
    conversation_id: UUID,
    user_id: UUID,
    payload: MemberRoleRequest,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> MemberResponse:
    with service.transaction(db):
        row = service.manage_conversation(db, actor, conversation_id)
        service.match(db, row, if_match)
        member = mutations.set_member_role(db, row, user_id, payload.role)
        revoke_stale(db)
        result = reads.member_rows(db, [member])[0]
        service.private(response)
    return result


@router.delete("/conversations/{conversation_id}/members/{user_id}", status_code=204)
def remove_member(
    conversation_id: UUID,
    user_id: UUID,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> None:
    with service.transaction(db):
        row = service.manage_conversation(db, actor, conversation_id)
        service.match(db, row, if_match)
        mutations.remove_member(db, row, user_id)
        revoke_stale(db)
        service.private(response)


@router.post(
    "/conversations/{conversation_id}/duplicates",
    response_model=Conversation,
    status_code=201,
    responses=CREATED,
)
def duplicate(
    conversation_id: UUID,
    payload: DuplicateRequest,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Any:
    with service.transaction(db):
        source = service.manage_conversation(db, actor, conversation_id)
        service.match(db, source, if_match)
        row = mutations.duplicate(db, actor, source, payload)
        db.flush()
        result = reads.conversation(db, actor, row)
        service.headers(db, response, row)
        response.headers["Location"] = f"/api/comms/conversations/{row.id}"
    return result


@router.get("/direct-blocks", response_model=StandardListResponse[DirectBlockResponse])
def list_blocks(
    db: DB, actor: Actor, response: Response, query: Annotated[BlockQuery, Query()]
) -> Any:
    service.private(response)
    return reads.block_page(db, actor, query)


@router.post("/direct-blocks", status_code=204)
def block(payload: BlockRequest, db: DB, actor: Actor, response: Response) -> None:
    with service.transaction(db):
        directs.toggle_block(db, actor, payload.blocked_user_id, enabled=True)
        service.private(response)


@router.delete("/direct-blocks/{user_id}", status_code=204)
def unblock(user_id: UUID, db: DB, actor: Actor, response: Response) -> None:
    with service.transaction(db):
        directs.toggle_block(db, actor, user_id, enabled=False)
        service.private(response)
