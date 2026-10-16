from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import (
    CurrentIdentity,
    get_current_identity,
    get_current_user,
)
from app.common.listing.schemas import StandardListResponse
from app.core.database import get_db
from app.core.database.organization_scope import session_organization
from app.systems.access.policy.checks import require_fresh_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.sandbox.records.aggregation import (
    aggregate_records,
    aggregate_snapshot,
    aggregate_snapshots,
)
from app.systems.sandbox.records.export import commit_export_event, export_snapshot
from app.systems.sandbox.records.grouping import query_grouped_records
from app.systems.sandbox.records.query import query_records
from app.systems.sandbox.records.query_schemas import (
    AggregateQuery,
    AggregateResponse,
    AggregateSnapshotQuery,
    AggregateSnapshotResponse,
    AggregateSnapshotsRequest,
    AggregateSnapshotsResponse,
    ExportRequest,
    GroupedRecordQuery,
    GroupedRecordResponse,
    RecordQuery,
    WindowRecordQuery,
    WindowRecordResponse,
)
from app.systems.sandbox.records.schemas import RecordResponse
from app.systems.sandbox.records.windowing import query_window_records

router = APIRouter(prefix="/records", tags=["records"])
Database = Annotated[Session, Depends(get_db)]
# Each query checks the module in the payload through validate_definition.
Reader = Annotated[User, Depends(get_current_user)]
Identity = Annotated[CurrentIdentity, Depends(get_current_identity)]


@router.post("/query", response_model=StandardListResponse[RecordResponse])
def query(
    payload: RecordQuery, reader: Reader, db: Database
) -> StandardListResponse[RecordResponse]:
    return query_records(db, payload, reader=reader)


@router.post("/grouped-query", response_model=GroupedRecordResponse)
def grouped_query(
    payload: GroupedRecordQuery, reader: Reader, db: Database
) -> GroupedRecordResponse:
    return query_grouped_records(db, payload, reader=reader)


@router.post("/window-query", response_model=WindowRecordResponse)
def window_query(payload: WindowRecordQuery, reader: Reader, db: Database) -> WindowRecordResponse:
    return query_window_records(db, payload, reader=reader)


@router.post("/aggregate-query", response_model=AggregateResponse)
def aggregate_query(payload: AggregateQuery, reader: Reader, db: Database) -> AggregateResponse:
    return aggregate_records(db, payload, reader=reader)


@router.post("/aggregate-snapshot", response_model=AggregateSnapshotResponse)
def aggregate_snapshot_route(
    payload: AggregateSnapshotQuery,
    actor: Reader,
    identity: Identity,
    db: Database,
) -> Response:
    actor_id = actor.id
    bind = db.get_bind()
    engine = bind if isinstance(bind, Engine) else bind.engine
    # The aggregate uses an independent REPEATABLE READ transaction that checks the
    # module read level inside it. Recheck the exact session and the level after it.
    db.rollback()
    try:
        content, bucket_count = aggregate_snapshot(
            engine, payload, reader_id=actor_id, org_id=session_organization(db)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, detail="Unable to create aggregate snapshot") from error

    require_fresh_module_access(
        db,
        actor_id=actor_id,
        session_id=identity.session_id,
        module_id=payload.module_id,
        level=AccessLevel.READ,
    )
    try:
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="records.aggregate_snapshot.authorized",
                source="records",
                operation_id=uuid7(),
                actor_id=actor_id,
                subject_id=payload.module_id,
                outcome=SecurityEventOutcome.SUCCESS,
                metadata={"bucket_count": bucket_count},
            ),
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            503, detail="Unable to record aggregate snapshot authorization"
        ) from error

    return Response(
        content,
        media_type="application/json",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.post("/aggregate-snapshots", response_model=AggregateSnapshotsResponse)
def aggregate_snapshots_route(
    payload: AggregateSnapshotsRequest,
    actor: Reader,
    identity: Identity,
    db: Database,
) -> Response:
    actor_id = actor.id
    bind = db.get_bind()
    engine = bind if isinstance(bind, Engine) else bind.engine
    db.rollback()
    try:
        content, bucket_count = aggregate_snapshots(
            engine, payload, reader_id=actor_id, org_id=session_organization(db)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, detail="Unable to create aggregate snapshots") from error

    module_ids = sorted({query.module_id for query in payload.queries})
    for module_id in module_ids:
        require_fresh_module_access(
            db,
            actor_id=actor_id,
            session_id=identity.session_id,
            module_id=module_id,
            level=AccessLevel.READ,
        )
    try:
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="records.aggregate_snapshots.authorized",
                source="records",
                operation_id=uuid7(),
                actor_id=actor_id,
                subject_id=module_ids[0] if len(module_ids) == 1 else None,
                outcome=SecurityEventOutcome.SUCCESS,
                metadata={
                    "query_count": len(payload.queries),
                    "bucket_count": bucket_count,
                    "module_ids": [str(module_id) for module_id in module_ids],
                },
            ),
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            503, detail="Unable to record aggregate snapshots authorization"
        ) from error
    return Response(
        content,
        media_type="application/json",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.post(
    "/export",
    response_class=Response,
    responses={
        200: {
            "content": {
                "text/csv": {"schema": {"type": "string", "format": "binary"}},
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                    "schema": {"type": "string", "format": "binary"}
                },
            }
        },
        403: {"description": "Current module access or session ended"},
        404: {"description": "Module or saved view is absent or hidden"},
        503: {"description": "Export generation or authorization persistence is unavailable"},
    },
)
def export(payload: ExportRequest, actor: Reader, identity: Identity, db: Database) -> Response:
    actor_id = actor.id
    # Release the authentication read transaction before opening the independent snapshot.
    bind = db.get_bind()
    engine = bind if isinstance(bind, Engine) else bind.engine
    db.rollback()
    try:
        content, count, filename = export_snapshot(
            engine, payload, reader_id=actor_id, org_id=session_organization(db)
        )
    except (SQLAlchemyError, OSError) as error:
        db.rollback()
        raise HTTPException(503, detail="Unable to create export") from error
    require_fresh_module_access(
        db,
        actor_id=actor_id,
        session_id=identity.session_id,
        module_id=payload.module_id,
        level=AccessLevel.READ,
    )
    commit_export_event(db, actor_id, payload, count)
    return Response(
        content,
        media_type=(
            "text/csv"
            if payload.format == "csv"
            else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
