"""S4: record history for a reader of the record who is not an admin or its manager.

Only fields the reader can read are kept: live fields of the record's module that are not
audit-redacted, plus ``is_deleted``. Entries with no readable change are removed in SQL, so
the page total stays right. Request method, path and note are never shown to a reader.
"""

from dataclasses import replace
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Text, false, or_, select
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.schemas import AuditLogResponse
from app.systems.manage.audit.service import AUDIT_LOG_LIST_SPEC, AuditLogSortField
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records.models import Record

_KEPT_KEYS = ("is_deleted",)
# The admin search reads the raw snapshots and paths, and a request-path sort orders by a
# hidden value; either would let a reader probe what the page leaves out.
READER_LIST_SPEC = replace(
    AUDIT_LOG_LIST_SPEC,
    search_fields=(),
    sort_fields={
        field: column
        for field, column in AUDIT_LOG_LIST_SPEC.sort_fields.items()
        if field is not AuditLogSortField.REQUEST_PATH
    },
)


def require_reader_sort(sort_by: AuditLogSortField | None) -> None:
    if sort_by is AuditLogSortField.REQUEST_PATH:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=[{
                "loc": ["query", "sort_by"],
                "msg": "Record history cannot be sorted by request path",
                "type": "value_error",
            }],
        )


def readable_field_ids(db: Session, record: Record) -> frozenset[str]:
    return frozenset(
        str(field_id)
        for field_id in db.scalars(
            select(Field.id).where(
                Field.module_id == record.module_id,
                Field.is_deleted.is_(False),
                Field.audit_redacted.is_(False),
            )
        )
    )


def record_history_conditions(
    record: Record, field_ids: frozenset[str]
) -> list[ColumnElement[bool]]:
    """This record's own entries that create, delete or restore it or change a readable field."""

    changes: list[ColumnElement[bool]] = [
        AuditLog.action.in_((AuditAction.CREATE, AuditAction.DELETE)),
        *(AuditLog.before.has_key(key) for key in _KEPT_KEYS),
        *(AuditLog.after.has_key(key) for key in _KEPT_KEYS),
    ]
    if field_ids:
        keys = array(sorted(field_ids), type_=Text)
        changes += [AuditLog.before["data"].has_any(keys), AuditLog.after["data"].has_any(keys)]
    else:
        changes.append(false())
    return [AuditLog.entity_type == Record.__tablename__, AuditLog.entity_id == record.id,
            or_(*changes)]


def _readable(snapshot: dict[str, Any] | None, field_ids: frozenset[str]) -> dict[str, Any] | None:
    if snapshot is None:
        return None
    readable = {key: snapshot[key] for key in _KEPT_KEYS if key in snapshot}
    data = snapshot.get("data")
    if isinstance(data, dict):
        readable["data"] = {key: value for key, value in data.items() if key in field_ids}
    return readable


def readable_entry(entry: AuditLogResponse, field_ids: frozenset[str]) -> AuditLogResponse:
    return entry.model_copy(update={
        "before": _readable(entry.before, field_ids),
        "after": _readable(entry.after, field_ids),
        "request_method": None,
        "request_path": None,
        "note": None,
    })
