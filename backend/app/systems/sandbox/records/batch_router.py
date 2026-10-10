"""Explicit single/compound record updates with independent item savepoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import CurrentIdentity, get_current_identity
from app.core.database import get_db
from app.systems.access.policy.checks import require_fresh_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.record_triggers.outbox import enqueue_record_event
from app.systems.sandbox.records.assignment_notifications import notify_record_assignments
from app.systems.sandbox.records.display import FieldDisplayResolver, displayed_record
from app.systems.sandbox.records.mutation_validation import RecordValidationError
from app.systems.sandbox.records.router import (
    _lock_active_module,
    _lock_record,
    _merge_patch_data,
    _module_fields,
    _record,
    _require_current_revision,
)
from app.systems.sandbox.records.schemas import (
    RecordBatchFieldError,
    RecordBatchForbidden,
    RecordBatchInput,
    RecordBatchInvalid,
    RecordBatchItem,
    RecordBatchResponse,
    RecordBatchResult,
    RecordBatchStale,
    RecordBatchUpdate,
    RecordBatchUpdated,
)

router = APIRouter(prefix="/records", tags=["records"])


def _invalid_item(item: RecordBatchInput, code: str, message: str) -> RecordBatchInvalid:
    return RecordBatchInvalid(
        record_id=item.record_id,
        errors=[
            RecordBatchFieldError(
                code=code,
                field_id=item.field_id if isinstance(item, RecordBatchItem) else None,
                message=message,
            )
        ],
    )


def _update_item(
    db: Session,
    user: User,
    payload: RecordBatchUpdate,
    item: RecordBatchInput,
    fields: list[Field],
    resolver: FieldDisplayResolver,
) -> RecordBatchResult:
    try:
        with db.begin_nested():
            record = _record(db, user, item.record_id, AccessLevel.WRITE)
            if record.module_id != payload.module_id:
                raise HTTPException(status_code=403, detail="Forbidden")
            record = _lock_record(db, record)
            if record.is_deleted:
                raise HTTPException(status_code=409, detail="Record is deleted")
            _require_current_revision(record, item.revision.isoformat())
            previous = dict(record.data)
            changes = (
                {str(item.field_id): item.value}
                if isinstance(item, RecordBatchItem)
                else {str(change.field_id): change.value for change in item.changes}
            )
            requested = {**previous, **changes}
            record.data = _merge_patch_data(db, payload.module_id, previous, requested, fields)
            enqueue_record_event(db, record, previous=previous)
            notify_record_assignments(db, record, previous=previous, fields=fields)
            db.flush()
            return RecordBatchUpdated(
                record_id=item.record_id,
                record=displayed_record(record, resolver),
            )
    except RecordValidationError as error:
        return RecordBatchInvalid(
            record_id=item.record_id,
            errors=[
                RecordBatchFieldError(
                    code=issue.code, field_id=issue.field_id, message=issue.message
                )
                for issue in error.issues
            ],
            truncated=error.truncated,
        )
    except HTTPException as error:
        if error.status_code in {403, 404}:
            return RecordBatchForbidden(record_id=item.record_id)
        if error.status_code == 412:
            return RecordBatchStale(record_id=item.record_id)
        if error.status_code == 409:
            return _invalid_item(item, "record_unavailable", "Record is unavailable")
        raise
    except IntegrityError:
        return _invalid_item(item, "record_update_failed", "Unable to update record")


@router.post("/batch-update", response_model=RecordBatchResponse)
def batch_update_records(
    payload: RecordBatchUpdate,
    response: Response,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> RecordBatchResponse:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        user = require_fresh_module_access(
            db,
            actor_id=identity.user.id,
            session_id=identity.session_id,
            module_id=payload.module_id,
            level=AccessLevel.WRITE,
        )
        # Keep module and authority locks outside item savepoints until the final commit.
        _lock_active_module(db, payload.module_id)
        fields = _module_fields(db, payload.module_id)
        resolver = FieldDisplayResolver(db, payload.module_id, fields)
        results = [
            _update_item(db, user, payload, item, fields, resolver) for item in payload.items
        ]
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Unable to update records") from error
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=503, detail="Batch outcome could not be confirmed"
        ) from error
    return RecordBatchResponse(results=results)
