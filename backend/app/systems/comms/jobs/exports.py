"""Admin-only real export jobs and bounded API-mediated artifact downloads."""

import hashlib
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import select
from uuid6 import uuid7

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.jobs import export_service as service
from app.systems.comms.jobs.encoding import MAX_BYTES, MIME
from app.systems.comms.jobs.models import CommsExport, CommsExportSource
from app.systems.comms.jobs.protected import admin, password_admin
from app.systems.comms.jobs.schemas import (
    CommsExportCreate,
    CommsExportRequest,
    CommsExportResponse,
)
from app.systems.comms.messages.interaction_schemas import TimeList, TimeSort
from app.systems.comms.moderation.router import no_body
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.platform.files.providers import (
    ProviderUnavailable,
    StorageBackend,
    hold_file_worker,
)
from app.systems.platform.files.storage import get_storage
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
router = APIRouter(
    prefix="/comms/exports", tags=["comms"], dependencies=[Depends(get_current_membership)]
)


@router.get(
    "", response_model=StandardListResponse[CommsExportResponse], response_model_exclude_unset=True
)
def list_exports(db: DB, actor: Actor, http: Response, params: Annotated[TimeList, Query()]) -> Any:
    admin(db, actor)
    query = (
        select(CommsExport)
        .join(ScheduledWork, ScheduledWork.comms_export_id == CommsExport.id)
        .where(
            CommsExport.org_id == bound_organization_column(),
            CommsExport.is_deleted.is_(False),
            ScheduledWork.kind == WorkKind.COMMS_EXPORT,
        )
    )
    page = execute_standard_list(
        db,
        query,
        StandardListRequest[TimeSort](**params.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: CommsExport.created_at.expression,
                TimeSort.UPDATED: CommsExport.updated_at.expression,
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=CommsExport.id.expression,
        ),
    )
    works = {
        work.comms_export_id: work
        for work in db.scalars(
            select(ScheduledWork).where(
                ScheduledWork.org_id == bound_organization_column(),
                ScheduledWork.comms_export_id.in_([row.id for row in page.items]),
            )
        )
    }
    private(http)
    return StandardListResponse(
        items=[service.response(row, works[row.id]) for row in page.items],
        pagination=page.pagination,
    )


@router.get("/{export_id}", response_model=CommsExportResponse, response_model_exclude_unset=True)
def get_export(export_id: UUID, db: DB, actor: Actor, http: Response) -> CommsExportResponse:
    admin(db, actor)
    private(http)
    return service.response(*service.load(db, export_id))


@router.post(
    "", response_model=CommsExportResponse, response_model_exclude_unset=True, status_code=201
)
def create(payload: CommsExportCreate, db: DB, actor: Actor, http: Response) -> CommsExportResponse:
    request = CommsExportRequest.model_validate(
        payload.model_dump(exclude={"password"}, exclude_none=True)
    )
    with transaction(db):
        rooms = service.selected_sources(db, actor, request.conversation_ids, lock=True)
        need_private = any(service.private_source(room) for room in rooms.values())
        if need_private and not request.reason:
            raise error("comms_invalid_input", "Private export requires a recorded reason", 422)
        if need_private:
            actor = password_admin(db, actor, payload.password)
            rooms = service.selected_sources(db, actor, request.conversation_ids, lock=True)
        private_ids = [room.id for room in rooms.values() if service.private_source(room)]
        if private_ids and (not need_private or not request.reason):
            raise error(
                "comms_fresh_admin_required", "The source now requires fresh confirmation", 403
            )
        identity, org = uuid7(), bound_organization(db)
        values = request.model_dump(mode="json", exclude_none=True)
        job = CommsExport(
            id=identity,
            org_id=org,
            requested_by=actor.id,
            request=values,
            private_verified=need_private,
            authorization_digest=service.authorization_digest(
                org, identity, actor.id, values, private_ids
            ),
        )
        db.add(job)
        db.flush()
        for room in rooms.values():
            db.add(
                CommsExportSource(
                    org_id=org,
                    export_id=job.id,
                    conversation_id=room.id,
                    private_at_capture=room.id in private_ids,
                )
            )
        work = ScheduledWork(
            org_id=org,
            kind=WorkKind.COMMS_EXPORT,
            comms_export_id=job.id,
            scheduling_actor_id=actor.id,
            scheduled_for=utc_now(),
            next_attempt_at=utc_now(),
        )
        db.add(work)
        db.flush()
        private(http)
        http.headers["Location"] = f"/api/comms/exports/{job.id}"
        result = service.response(job, work)
    return result


def _ready(job: CommsExport, work: ScheduledWork) -> tuple[str, int, str, str]:
    if work.failure_code == "access_lost":
        raise error("comms_not_found", "Captured export source is unavailable")
    if (
        work.state != WorkState.SUCCEEDED
        or job.cleanup_pending
        or not job.artifact_upload_confirmed
        or job.artifact_key is None
        or job.artifact_size is None
        or job.artifact_sha256 is None
        or not 0 <= job.artifact_size <= MAX_BYTES
    ):
        raise error("comms_unavailable", "Export bytes are not available", 503)
    format = CommsExportRequest.model_validate(job.request).format
    return job.artifact_key, job.artifact_size, job.artifact_sha256, format


@router.get(
    "/{export_id}/content",
    response_class=Response,
    dependencies=[Depends(no_body)],
    responses={
        200: {
            "content": {
                "text/csv": {"schema": {"type": "string", "format": "binary"}},
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                    "schema": {"type": "string", "format": "binary"}
                },
            }
        }
    },
)
def download(
    export_id: UUID,
    request: Request,
    db: DB,
    actor: Actor,
    storage: Annotated[StorageBackend, Depends(get_storage)],
) -> Response:
    admin(db, actor)
    actor_id = actor.id
    job, work = service.load(db, export_id)
    service.current_sources(db, actor, job)
    signature = _ready(job, work)
    key, size, digest, format = signature
    db.rollback()
    try:
        with hold_file_worker(request):
            content = storage.download(key)
    except ProviderUnavailable as exc:
        raise error("comms_unavailable", "Export storage is unavailable", 503) from exc
    if (
        content is None
        or len(content) != size
        or len(content) > MAX_BYTES
        or hashlib.sha256(content).hexdigest() != digest
    ):
        raise error("comms_unavailable", "Export bytes could not be verified", 503)
    with transaction(db):
        current = db.get(User, actor_id, populate_existing=True)
        if current is None:
            raise error("comms_admin_required", "Administrator unavailable", 403)
        job, _ = service.load(db, export_id)
        service.current_sources(db, current, job, lock=True)
        job, work = service.load(db, export_id, lock=True)
        if _ready(job, work) != signature:
            raise error("comms_unavailable", "Export changed during delivery", 503)
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="comms.export.downloaded",
                source="comms",
                operation_id=uuid7(),
                actor_id=actor_id,
                subject_id=job.id,
                outcome=SecurityEventOutcome.SUCCESS,
                metadata={"format": format, "byte_count": size},
            ),
        )
    return Response(
        content=content,
        media_type=MIME[format],
        headers={
            "Content-Disposition": f'attachment; filename="opencomms-{export_id.hex}.{format}"',
            "Content-Length": str(size),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
