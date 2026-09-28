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
    require_admin,
    require_fresh_exact_admin,
)
from app.common.listing.schemas import StandardListResponse
from app.core.database import get_db
from app.systems.access.policy.checks import require_fresh_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.sandbox.records.aggregation import aggregate_records, aggregate_snapshot
from app.systems.sandbox.records.export import commit_export_event, export_snapshot
from app.systems.sandbox.records.grouping import query_grouped_records
from app.systems.sandbox.records.query import query_records
from app.systems.sandbox.records.query_schemas import (
    AggregateQuery,
    AggregateResponse,
    AggregateSnapshotQuery,
    AggregateSnapshotResponse,
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
# CSV export is administrator-only.
Admin = Annotated[User, Depends(require_admin)]


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
        content, bucket_count = aggregate_snapshot(engine, payload, reader_id=actor_id)
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


@router.post("/export")
def export(payload: RecordQuery, actor: Admin, db: Database) -> Response:
    actor_id = actor.id
    # Release the authentication read transaction before opening the independent snapshot.
    bind = db.get_bind()
    engine = bind if isinstance(bind, Engine) else bind.engine
    db.rollback()
    content, count = export_snapshot(engine, payload, reader_id=actor_id)
    # Recheck current exact-admin membership after generation and fence its event commit.
    require_fresh_exact_admin(db, actor_id)
    commit_export_event(db, actor_id, payload.module_id, count)
    return Response(
        content,
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="records.csv"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
