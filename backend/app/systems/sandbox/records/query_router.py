from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import (
    require_capability,
    require_fresh_capabilities,
    require_fresh_exact_admin,
    require_roles,
)
from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.common.listing.schemas import StandardListResponse
from app.core.database import get_db
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.permissions import Capability
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
Reader = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
Identity = Annotated[CurrentIdentity, Depends(get_current_identity)]
Admin = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


@router.post("/query", response_model=StandardListResponse[RecordResponse])
def query(payload: RecordQuery, _: Reader, db: Database) -> StandardListResponse[RecordResponse]:
    return query_records(db, payload)


@router.post("/grouped-query", response_model=GroupedRecordResponse)
def grouped_query(
    payload: GroupedRecordQuery, _: Reader, db: Database
) -> GroupedRecordResponse:
    return query_grouped_records(db, payload)


@router.post("/window-query", response_model=WindowRecordResponse)
def window_query(
    payload: WindowRecordQuery, _: Reader, db: Database
) -> WindowRecordResponse:
    return query_window_records(db, payload)


@router.post("/aggregate-query", response_model=AggregateResponse)
def aggregate_query(
    payload: AggregateQuery, _: Reader, db: Database
) -> AggregateResponse:
    return aggregate_records(db, payload)


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
    # The aggregate uses an independent REPEATABLE READ transaction. Recheck
    # the exact authenticated session and its current records.read grant after it.
    db.rollback()
    try:
        content, bucket_count = aggregate_snapshot(engine, payload)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, detail="Unable to create aggregate snapshot") from error

    require_fresh_capabilities(
        db,
        actor_id=actor_id,
        session_id=identity.session_id,
        capabilities=(Capability.RECORDS_READ,),
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
    content, count = export_snapshot(engine, payload)
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
