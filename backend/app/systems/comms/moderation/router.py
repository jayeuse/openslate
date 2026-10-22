"""Moderation resources; report-bound actions return references, never private message content."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import select

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error, explain_conversation_access, require_conversation_access
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.messages.interaction_schemas import TimeList, TimeSort
from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision
from app.systems.comms.messages.mutations import lock_counter, message_version
from app.systems.comms.messages.reads import get_message, project_messages
from app.systems.comms.messages.schemas import LiveMessage, Tombstone
from app.systems.comms.moderation import service
from app.systems.comms.moderation.models import CommsReport
from app.systems.comms.moderation.schemas import (
    CommsReportResponse,
    ReportRequest,
    RestrictionRequest,
    RevisionResponse,
)
from app.systems.comms.realtime.events import organization_event
from app.systems.comms.settings import service as settings
from app.systems.comms.settings.resolution import Scope
from app.systems.comms.settings.schemas import SettingsResponse

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
router = APIRouter(prefix="/comms", tags=["comms"], dependencies=[Depends(get_current_membership)])
VERSIONED: dict[int | str, dict[str, Any]] = {
    200: {"headers": {"ETag": {"schema": {"type": "string"}}}},
    428: {"description": "If-Match is required"},
    412: {"description": "Resource changed"},
}


async def no_body(request: Request) -> None:
    if await request.body():
        raise error("comms_invalid_input", "This command has no request body", 422)


def _report_response(
    response: Response, report: CommsReport, message: CommsMessage,
) -> CommsReportResponse:
    private(response)
    response.headers["ETag"] = service.report_version(report, message)
    return CommsReportResponse.model_validate(report)


@router.post("/conversations/{conversation_id}/messages/{message_id}/reports", status_code=204)
def report_message(
    conversation_id: UUID, message_id: UUID, payload: ReportRequest, db: DB, actor: Actor,
) -> Response:
    with transaction(db):
        require_conversation_access(db, actor, conversation_id, "read")
        message = get_message(db, conversation_id, message_id=message_id)
        db.add(CommsReport(
            org_id=bound_organization(db), conversation_id=conversation_id, message_id=message.id,
            reporter_id=actor.id, reason=payload.reason,
        ))
        service.queue_event(db, conversation_id)
    return Response(status_code=204, headers={"Cache-Control": "private, no-store"})


@router.get("/reports", response_model=StandardListResponse[CommsReportResponse])
def list_reports(db: DB, actor: Actor, response: Response,
                 params: Annotated[TimeList, Query()]) -> Any:
    conversations = service.queue_conversations(db, actor)
    if conversations == set():
        raise error("comms_capability_denied", "Capability required", 403)
    query = service.report_query()
    if conversations is not None:
        query = query.where(CommsReport.conversation_id.in_(conversations))
    result = execute_standard_list(db, query, StandardListRequest[TimeSort](**params.model_dump()),
        ListQuerySpec(sort_fields={TimeSort.CREATED: CommsReport.created_at.expression,
                                   TimeSort.UPDATED: CommsReport.updated_at.expression},
                      default_sort=TimeSort.CREATED, tie_breaker=CommsReport.id.expression))
    private(response)
    return StandardListResponse(
        items=[CommsReportResponse.model_validate(row) for row in result.items],
        pagination=result.pagination,
    )


@router.get("/reports/{report_id}", response_model=CommsReportResponse, responses=VERSIONED)
def get_report(report_id: UUID, db: DB, actor: Actor, response: Response) -> CommsReportResponse:
    return _report_response(response, *service.load_report(db, actor, report_id))


@router.post("/reports/{report_id}/resolution", response_model=CommsReportResponse,
             responses=VERSIONED)
def resolve_report(report_id: UUID, db: DB, actor: Actor, response: Response,
                   if_match: Match = None) -> CommsReportResponse:
    with transaction(db):
        report, message = service.load_report(db, actor, report_id, lock=True)
        service.match(if_match, service.report_version(report, message))
        if report.status != "resolved":
            report.status = "resolved"
            service.queue_event(db, report.conversation_id)
        db.flush()
        value = _report_response(response, report, message)
    return value


def _report_action(report_id: UUID, db: AuditSession, actor: User, response: Response,
                   if_match: str | None, *, restore: bool) -> CommsReportResponse:
    with transaction(db):
        report, message = service.load_report(db, actor, report_id, lock=True, action=True)
        service.match(if_match, service.report_version(report, message))
        if report.status != "open":
            raise error("comms_conflict", "The report is resolved", 409)
        service.tombstone(db, message, actor, restore=restore)
        db.flush()
        value = _report_response(response, report, message)
    return value


@router.post("/reports/{report_id}/message-removal", response_model=CommsReportResponse,
             responses=VERSIONED, dependencies=[Depends(no_body)])
def remove_reported_message(report_id: UUID, db: DB, actor: Actor, response: Response,
                            if_match: Match = None) -> CommsReportResponse:
    return _report_action(report_id, db, actor, response, if_match, restore=False)


@router.post("/reports/{report_id}/message-restoration", response_model=CommsReportResponse,
             responses=VERSIONED, dependencies=[Depends(no_body)])
def restore_reported_message(report_id: UUID, db: DB, actor: Actor, response: Response,
                             if_match: Match = None) -> CommsReportResponse:
    return _report_action(report_id, db, actor, response, if_match, restore=True)


def _message_action(db: AuditSession, actor: User, conversation_id: UUID, message_id: UUID,
                    if_match: str | None, response: Response, *, restore: bool) -> Any:
    with transaction(db):
        service.require_capability(db, actor, conversation_id, "deleteOthersMessages")
        lock_counter(db, conversation_id)
        db.scalar(select(CommsConversation).where(
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.id == conversation_id,
        ).with_for_update())
        service.require_capability(db, actor, conversation_id, "deleteOthersMessages")
        message = get_message(db, conversation_id, message_id=message_id, lock=True)
        current = project_messages(db, actor.id, [message])[0]
        service.match(if_match, message_version(current))
        service.tombstone(db, message, actor, restore=restore)
        db.flush()
        value = project_messages(db, actor.id, [message])[0]
        private(response)
        response.headers["ETag"] = message_version(value)
    return value


@router.post("/conversations/{conversation_id}/messages/{message_id}/removal",
             response_model=Tombstone, responses=VERSIONED, dependencies=[Depends(no_body)])
def remove_message(conversation_id: UUID, message_id: UUID, db: DB, actor: Actor,
                   response: Response, if_match: Match = None) -> Any:
    return _message_action(
        db, actor, conversation_id, message_id, if_match, response, restore=False,
    )


@router.post("/conversations/{conversation_id}/messages/{message_id}/restoration",
             response_model=LiveMessage, responses=VERSIONED, dependencies=[Depends(no_body)])
def restore_message(conversation_id: UUID, message_id: UUID, db: DB, actor: Actor,
                    response: Response, if_match: Match = None) -> Any:
    return _message_action(db, actor, conversation_id, message_id, if_match, response, restore=True)


@router.get("/conversations/{conversation_id}/removed-messages",
            response_model=StandardListResponse[Tombstone])
def removed_messages(conversation_id: UUID, db: DB, actor: Actor, response: Response,
                     params: Annotated[TimeList, Query()]) -> Any:
    service.require_capability(db, actor, conversation_id, "deleteOthersMessages")
    m = CommsMessage
    result = execute_standard_list(db, select(m).where(
        m.org_id == bound_organization_column(), m.conversation_id == conversation_id,
        m.is_deleted.is_(True), m.deleted_at.is_not(None),
    ), StandardListRequest[TimeSort](**params.model_dump()), ListQuerySpec(
        sort_fields={TimeSort.CREATED: m.created_at.expression,
                     TimeSort.UPDATED: m.deleted_at.expression},
        default_sort=TimeSort.CREATED, tie_breaker=m.id.expression,
    ))
    private(response)
    return StandardListResponse(items=project_messages(db, actor.id, result.items),
                                pagination=result.pagination)


@router.get("/conversations/{conversation_id}/messages/{message_id}/revisions",
            response_model=StandardListResponse[RevisionResponse])
def revisions(conversation_id: UUID, message_id: UUID, db: DB, actor: Actor, response: Response,
              params: Annotated[TimeList, Query()]) -> Any:
    require_conversation_access(db, actor, conversation_id, "read")
    source = get_message(db, conversation_id, message_id=message_id)
    if source.is_deleted or source.deleted_at is not None:
        raise error("comms_not_found", "Message not found")
    if (source.author_id != actor.id
            and explain_conversation_access(db, actor, conversation_id).level != "manage"):
        raise error("comms_capability_denied", "Capability required", 403)
    r = CommsMessageRevision
    result = execute_standard_list(db, select(r).where(
        r.org_id == bound_organization_column(), r.message_id == message_id,
        r.is_deleted.is_(False), r.deleted_at.is_(None),
    ), StandardListRequest[TimeSort](**params.model_dump()), ListQuerySpec(
        sort_fields={TimeSort.CREATED: r.created_at.expression,
                     TimeSort.UPDATED: r.created_at.expression},
        default_sort=TimeSort.CREATED, tie_breaker=r.id.expression,
    ))
    private(response)
    return StandardListResponse(
        items=[RevisionResponse.model_validate(row) for row in result.items],
        pagination=result.pagination,
    )


@router.put("/conversations/{conversation_id}/restrictions", response_model=SettingsResponse,
            responses=VERSIONED)
def restrictions(conversation_id: UUID, payload: RestrictionRequest, db: DB, actor: Actor,
                 response: Response, if_match: Match = None) -> Any:
    scope: Scope = {"kind": "channel", "id": conversation_id}
    with transaction(db):
        settings.lock_scope(db, actor, scope, allow_moderation=True)
        service.require_capability(db, actor, conversation_id, "moderate")
        settings.match(db, scope, if_match)
        settings.patch_settings(db, scope, {
            "restricted_person_ids": [str(identity) for identity in payload.user_ids],
            "restriction_until": payload.until.isoformat() if payload.until else None,
        })
        db.flush()
        value = settings.settings(db, scope)
        settings.headers(db, scope, response)
        organization_event(db, "grants")
    return value
