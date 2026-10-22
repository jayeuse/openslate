"""Exact-admin template CRUD; raw bytes are bounded before JSON admission."""

import hashlib
import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.policy.models import Group
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.jobs.protected import admin
from app.systems.comms.messages.interaction_schemas import TimeList, TimeSort
from app.systems.comms.moderation.service import match
from app.systems.comms.realtime.events import organization_event
from app.systems.comms.settings.resolution import validate_settings_patch
from app.systems.comms.templates import application
from app.systems.comms.templates.models import CommsTemplate
from app.systems.comms.templates.schemas import (
    TEMPLATE_BYTES,
    TemplateApply,
    TemplateApplyPreview,
    TemplateApplyResult,
    TemplateImport,
    TemplateResponse,
)

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
router = APIRouter(
    prefix="/comms/templates", tags=["comms"], dependencies=[Depends(get_current_membership)]
)
INPUT_SCHEMA = TemplateImport.model_json_schema(ref_template="#/components/schemas/{model}")
INPUT_SCHEMA.pop("$defs", None)  # Nested models also occur in TemplateResponse components.
DOCUMENT = {
    "requestBody": {"required": True, "content": {"application/json": {"schema": INPUT_SCHEMA}}}
}


async def template_document(request: Request) -> TemplateImport:
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > TEMPLATE_BYTES:
            raise error("comms_invalid_input", "Template exceeds 64 KiB", 413)
        content.extend(chunk)
    try:
        return TemplateImport.model_validate_json(content)
    except ValidationError as exc:
        raise RequestValidationError(
            [
                {"loc": ("body", *issue["loc"]), "msg": issue["msg"], "type": issue["type"]}
                for issue in exc.errors(include_input=False, include_url=False)
            ]
        ) from exc


def validate_document(db: Session, payload: TemplateImport) -> None:
    if payload.settings:
        validate_settings_patch(db, {"kind": "workspace"}, payload.settings)
    ids = {row.group_id for row in payload.capabilities.group_grants}
    if ids != set(
        db.scalars(
            select(Group.id).where(
                Group.org_id == bound_organization_column(),
                Group.is_deleted.is_(False),
                Group.id.in_(ids),
            )
        )
    ):
        raise error("comms_capabilities_invalid", "Group is unavailable", 422)


def load(db: Session, identity: UUID, *, lock: bool = False) -> CommsTemplate:
    query = (
        select(CommsTemplate)
        .where(
            CommsTemplate.org_id == bound_organization_column(),
            CommsTemplate.id == identity,
            CommsTemplate.is_deleted.is_(False),
            CommsTemplate.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    row = db.scalar(query.with_for_update() if lock else query)
    if row is None:
        raise error("comms_not_found", "Template not found")
    return row


def response(row: CommsTemplate) -> TemplateResponse:
    return TemplateResponse.model_validate(
        {
            **row.document,
            "id": row.id,
            "org_id": row.org_id,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    )


def version(row: CommsTemplate) -> str:
    value = {
        "template": str(row.id),
        "org": str(row.org_id),
        "revision": row.revision,
        "document": row.document,
    }
    return '"' + hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest() + '"'


@router.get(
    "", response_model=StandardListResponse[TemplateResponse], response_model_exclude_unset=True
)
def list_templates(
    db: DB, actor: Actor, http: Response, params: Annotated[TimeList, Query()]
) -> Any:
    admin(db, actor)
    page = execute_standard_list(
        db,
        select(CommsTemplate).where(
            CommsTemplate.org_id == bound_organization_column(),
            CommsTemplate.is_deleted.is_(False),
        ),
        StandardListRequest[TimeSort](**params.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: CommsTemplate.created_at.expression,
                TimeSort.UPDATED: CommsTemplate.updated_at.expression,
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=CommsTemplate.id.expression,
        ),
    )
    private(http)
    return StandardListResponse(
        items=[response(row) for row in page.items], pagination=page.pagination
    )


@router.get("/{template_id}", response_model=TemplateResponse, response_model_exclude_unset=True)
def get_template(template_id: UUID, db: DB, actor: Actor, http: Response) -> TemplateResponse:
    admin(db, actor)
    row = load(db, template_id)
    private(http)
    http.headers["ETag"] = version(row)
    return response(row)


@router.post(
    "",
    response_model=TemplateResponse,
    response_model_exclude_unset=True,
    status_code=201,
    openapi_extra=DOCUMENT,
)
def create(
    db: DB,
    actor: Actor,
    http: Response,
    payload: Annotated[TemplateImport, Depends(template_document)],
) -> TemplateResponse:
    with transaction(db):
        admin(db, actor)
        validate_document(db, payload)
        row = CommsTemplate(
            org_id=bound_organization(db),
            document=payload.model_dump(mode="json", exclude_unset=True),
        )
        db.add(row)
        db.flush()
        private(http)
        http.headers.update({"Location": f"/api/comms/templates/{row.id}", "ETag": version(row)})
        value = response(row)
        organization_event(db, "structure")
    return value


@router.put(
    "/{template_id}",
    response_model=TemplateResponse,
    response_model_exclude_unset=True,
    openapi_extra=DOCUMENT,
)
def save(
    template_id: UUID,
    db: DB,
    actor: Actor,
    http: Response,
    payload: Annotated[TemplateImport, Depends(template_document)],
    if_match: Match = None,
) -> TemplateResponse:
    with transaction(db):
        admin(db, actor)
        row = load(db, template_id, lock=True)
        match(if_match, version(row))
        validate_document(db, payload)
        document = payload.model_dump(mode="json", exclude_unset=True)
        if document != row.document:
            if row.revision >= 2147483647:
                raise error("comms_conflict", "Template version exhausted", 409)
            row.document = document
            row.revision += 1
            db.flush()
            organization_event(db, "structure")
        private(http)
        http.headers["ETag"] = version(row)
        value = response(row)
    return value


@router.post(
    "/{template_id}/application-preview",
    response_model=TemplateApplyPreview,
    response_model_exclude_none=True,
)
def preview(
    template_id: UUID, payload: TemplateApply, db: DB, actor: Actor, http: Response
) -> TemplateApplyPreview:
    admin(db, actor)
    row = load(db, template_id, lock=True)
    validate_document(db, TemplateImport.model_validate(row.document))
    proposal = application.plan(db, actor, row, payload)
    private(http)
    http.headers["ETag"] = proposal.etag
    return proposal.preview


@router.post(
    "/{template_id}/applications",
    response_model=TemplateApplyResult,
    response_model_exclude_none=True,
)
def apply_template(
    template_id: UUID,
    payload: TemplateApply,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> TemplateApplyResult:
    with transaction(db):
        admin(db, actor)
        row = load(db, template_id, lock=True)
        validate_document(db, TemplateImport.model_validate(row.document))
        proposal = application.plan(db, actor, row, payload)
        match(if_match, proposal.etag)
        if application.apply(db, actor, proposal):
            organization_event(db, "grants")
        private(http)
    return proposal.result
