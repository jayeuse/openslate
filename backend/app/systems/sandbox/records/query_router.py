from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.common.dependencies import require_capability, require_fresh_exact_admin, require_roles
from app.common.listing.schemas import StandardListResponse
from app.core.database import get_db
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.records.export import commit_export_event, export_snapshot
from app.systems.sandbox.records.query import query_records
from app.systems.sandbox.records.query_schemas import RecordQuery
from app.systems.sandbox.records.schemas import RecordResponse

router = APIRouter(prefix="/records", tags=["records"])
Database = Annotated[Session, Depends(get_db)]
Reader = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
Admin = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


@router.post("/query", response_model=StandardListResponse[RecordResponse])
def query(payload: RecordQuery, _: Reader, db: Database) -> StandardListResponse[RecordResponse]:
    return query_records(db, payload)


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
