"""Canonical relationship dependency locking and validation."""

from collections.abc import Sequence
from typing import Any, cast
from uuid import UUID

from sqlalchemy import Select, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.errors import (
    RelationshipConflict,
    RelationshipUnavailable,
)

# Concurrent link and record writes lock the same module and record rows for a few
# tens of milliseconds (p95 58 ms, max 331 ms at School Standard size). Waiting up to
# 2 s absorbs that without a 503, and still fails fast enough behind a long holder
# such as a publication. A timeout raises the same LockNotAvailable as NOWAIT did,
# so callers keep mapping it to 503 "temporarily unavailable".
LOCK_WAIT = "2s"
_LOCK_WAIT_TRANSACTION = "relationship_lock_wait_transaction"


def wait_briefly_for_locks(db: Session) -> None:
    """Bound every row-lock wait for the rest of this transaction, once per transaction."""

    connection = db.connection()
    # Key on the innermost transaction: rolling back a savepoint reverts SET LOCAL,
    # and the next call must then set it again instead of waiting without a limit.
    transaction = db.get_nested_transaction() or db.get_transaction()
    if db.info.get(_LOCK_WAIT_TRANSACTION) is transaction:
        return
    # A transaction setting, not a data change: run it on the connection, outside
    # the audited session's guard against raw ORM mutations.
    connection.exec_driver_sql(f"SET LOCAL lock_timeout = '{LOCK_WAIT}'")
    db.info[_LOCK_WAIT_TRANSACTION] = transaction


def _for_update(statement: Select[Any]) -> Select[Any]:
    return statement.execution_options(populate_existing=True).with_for_update()


def lock_row[ModelT](db: Session, model: type[ModelT], object_id: UUID) -> ModelT | None:
    """Lock one lifecycle row, waiting at most LOCK_WAIT behind another mutation."""

    try:
        wait_briefly_for_locks(db)
        return cast(
            ModelT | None,
            db.get(
                model,
                object_id,
                populate_existing=True,
                with_for_update=True,
            ),
        )
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error


def lock_modules(db: Session, module_ids: Sequence[UUID]) -> dict[UUID, Module]:
    unique_ids = sorted(set(module_ids))
    if not unique_ids or not isinstance(db, AuditSession):
        return {}
    try:
        wait_briefly_for_locks(db)
        locked = list(
            db.scalars(
                _for_update(select(Module).where(Module.id.in_(unique_ids)).order_by(Module.id))
            ).all()
        )
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error
    if len(locked) != len(unique_ids):
        raise RelationshipConflict("A relationship module is unavailable")
    return {module.id: module for module in locked}


def _validate_locked_modules(
    field: Field,
    source: Record,
    target: Record | None,
    modules: dict[UUID, Module],
    *,
    active_source_module: bool,
    active_target_module: bool,
) -> None:
    source_module = modules.get(field.module_id)
    target_module = (
        modules.get(field.relationship_target_module_id)
        if field.relationship_target_module_id is not None
        else None
    )
    if source_module is None or target_module is None:
        raise RelationshipConflict("Relationship module is unavailable")
    if active_source_module:
        _active_entity(source_module, "Source module")
    if active_target_module:
        _active_entity(target_module, "Target module")
    if target is not None and target.module_id != target_module.id:
        raise RelationshipConflict("Target record module does not match field")
    if source.module_id != source_module.id:
        raise RelationshipConflict("Source record module does not match field")
    if source_module.department_id != target_module.department_id:
        raise RelationshipConflict("Relationship records must be in the same department")


def _lock_relationship_rows(
    db: Session,
    field: Field,
    source: Record,
    target: Record | None,
    extra_records: Sequence[Record] = (),
    *,
    active_source_module: bool = True,
    active_target_module: bool = True,
) -> tuple[Field, Record, Record | None]:
    module_ids = [field.module_id]
    if field.relationship_target_module_id is not None:
        module_ids.append(field.relationship_target_module_id)
    module_ids.append(source.module_id)
    if target is not None:
        module_ids.append(target.module_id)
    module_ids.extend(record.module_id for record in extra_records)
    locked_modules = lock_modules(db, module_ids)

    if not isinstance(db, AuditSession):
        relationship_modules = {
            module.id: module
            for module in (
                getattr(field, "module", None),
                getattr(source, "module", None),
                getattr(target, "module", None) if target is not None else None,
            )
            if module is not None
        }
        _validate_locked_modules(
            field,
            source,
            target,
            relationship_modules,
            active_source_module=active_source_module,
            active_target_module=active_target_module,
        )
        return field, source, target

    try:
        wait_briefly_for_locks(db)
        locked_field = db.scalar(_for_update(select(Field).where(Field.id == field.id)))
        records = [source, *extra_records]
        if target is not None:
            records.append(target)
        record_ids = sorted({record.id for record in records})
        locked_records = list(
            db.scalars(
                _for_update(select(Record).where(Record.id.in_(record_ids)).order_by(Record.id))
            ).all()
        )
        records_by_id = {record.id: record for record in locked_records}
        locked_source = records_by_id.get(source.id)
        locked_target = records_by_id.get(target.id) if target is not None else None
    except OperationalError as error:
        db.rollback()
        raise RelationshipUnavailable(
            "Relationship operation is temporarily unavailable"
        ) from error
    if (
        locked_field is None
        or locked_source is None
        or (target is not None and locked_target is None)
    ):
        raise RelationshipConflict("Relationship dependency is unavailable")
    _validate_locked_modules(
        locked_field,
        locked_source,
        locked_target,
        locked_modules,
        active_source_module=active_source_module,
        active_target_module=active_target_module,
    )
    return locked_field, locked_source, locked_target


def _active_entity(entity: Any, label: str) -> None:
    if entity is None or getattr(entity, "is_deleted", True):
        raise RelationshipConflict(f"{label} is not active")


def validate_relationship_modules(source_module: Module, target_module: Module) -> None:
    _active_entity(source_module, "Source module")
    _active_entity(target_module, "Target module")
    if source_module.department_id != target_module.department_id:
        raise RelationshipConflict("Relationship target must be in the same department")


def _load_create_dependencies(
    db: Session, field_id: UUID, source_id: UUID, target_id: UUID
) -> tuple[Field, Record, Record]:
    field = db.scalar(select(Field).where(Field.id == field_id))
    source = db.scalar(select(Record).where(Record.id == source_id))
    target = db.scalar(select(Record).where(Record.id == target_id))
    if field is None:
        raise RelationshipConflict("Relationship field is unavailable")
    if source is None or target is None:
        raise RelationshipConflict("Relationship record is unavailable")
    locked_field, locked_source, locked_target = _lock_relationship_rows(db, field, source, target)
    if locked_target is None:
        raise RelationshipConflict("Target record is unavailable")
    return locked_field, locked_source, locked_target


__all__ = [
    "lock_modules",
    "lock_row",
    "validate_relationship_modules",
]
