"""Reopen preflight validation for lifecycle plans."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.planning_scope import LifecycleScope
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleTargetType,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def reopen_blockers(
    db: Session,
    scope: LifecycleScope,
    _target_type: LifecycleTargetType,
    transition_ids: dict[str, set[UUID]],
) -> tuple[LifecycleBlocker, ...]:
    """Return deterministic preflight blockers without changing ORM state."""

    blockers: list[LifecycleBlocker] = []
    department_ids = [department.id for department in scope.departments]
    all_department_modules = (
        list(
            db.scalars(
                select(Module).where(Module.department_id.in_(department_ids)).order_by(Module.id)
            ).all()
        )
        if department_ids
        else []
    )
    active_modules = [module for module in all_department_modules if not module.is_deleted]
    reopening_modules = [
        module for module in all_department_modules if module.id in transition_ids["modules"]
    ]
    module_keys: dict[tuple[UUID, str], UUID] = {}
    for module in reopening_modules:
        conflicts = [
            other
            for other in active_modules
            if other.id not in transition_ids["modules"]
            and other.department_id == module.department_id
            and other.module_name == module.module_name
        ]
        if conflicts:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.MODULE_NAME_CONFLICT,
                    entity_type="modules",
                    entity_id=module.id,
                    detail=f"Module name is already active: {module.module_name}",
                    conflicting_entity_type="modules",
                    conflicting_entity_id=conflicts[0].id,
                )
            )
        key = (module.department_id, module.module_name)
        if key in module_keys:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.MODULE_NAME_CONFLICT,
                    entity_type="modules",
                    entity_id=module.id,
                    detail=f"Reopened modules share an active name: {module.module_name}",
                    conflicting_entity_type="modules",
                    conflicting_entity_id=module_keys[key],
                )
            )
        module_keys[key] = module.id

    module_ids = [module.id for module in scope.modules]
    all_module_fields = (
        list(
            db.scalars(
                select(Field).where(Field.module_id.in_(module_ids)).order_by(Field.id)
            ).all()
        )
        if module_ids
        else []
    )
    all_module_records = (
        list(
            db.scalars(
                select(Record).where(Record.module_id.in_(module_ids)).order_by(Record.id)
            ).all()
        )
        if module_ids
        else []
    )
    active_fields = [field for field in all_module_fields if not field.is_deleted]
    reopening_fields = [
        field for field in all_module_fields if field.id in transition_ids["fields"]
    ]
    field_name_keys: dict[tuple[UUID, str], UUID] = {}
    field_position_keys: dict[tuple[UUID, int], UUID] = {}
    for field in reopening_fields:
        name_conflict = any(
            other.id not in transition_ids["fields"]
            and other.module_id == field.module_id
            and other.name == field.name
            for other in active_fields
        )
        position_conflict = any(
            other.id not in transition_ids["fields"]
            and other.module_id == field.module_id
            and other.position == field.position
            for other in active_fields
        )
        if name_conflict:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_NAME_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Field name is already active: {field.name}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=next(
                        other.id
                        for other in active_fields
                        if other.id not in transition_ids["fields"]
                        and other.module_id == field.module_id
                        and other.name == field.name
                    ),
                )
            )
        if position_conflict:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_POSITION_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Field position is already active: {field.position}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=next(
                        other.id
                        for other in active_fields
                        if other.id not in transition_ids["fields"]
                        and other.module_id == field.module_id
                        and other.position == field.position
                    ),
                )
            )
        name_key = (field.module_id, field.name)
        if name_key in field_name_keys:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_NAME_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Reopened fields share an active name: {field.name}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=field_name_keys[name_key],
                )
            )
        field_name_keys[name_key] = field.id
        position_key = (field.module_id, field.position)
        if position_key in field_position_keys:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_POSITION_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Reopened fields share an active position: {field.position}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=field_position_keys[position_key],
                )
            )
        field_position_keys[position_key] = field.id

    effective_fields_by_module: dict[UUID, list[Field]] = {}
    for field in all_module_fields:
        if not field.is_deleted or field.id in transition_ids["fields"]:
            effective_fields_by_module.setdefault(field.module_id, []).append(field)
    for module in scope.modules:
        fields = effective_fields_by_module.get(module.id, [])
        module_records = [
            record
            for record in all_module_records
            if record.module_id == module.id
            and (not record.is_deleted or record.id in transition_ids["records"])
        ]
        reopening_records = any(record.id in transition_ids["records"] for record in module_records)
        if (
            module.id in transition_ids["modules"]
            or any(field.id in transition_ids["fields"] for field in fields)
            or reopening_records
        ):
            try:
                from app.systems.sandbox.fields.validation import validate_module_schema

                validate_module_schema(fields)
            except ValueError as error:
                blockers.append(
                    LifecycleBlocker(
                        code=LifecycleBlockerCode.SCHEMA_INVALID,
                        entity_type="modules",
                        entity_id=module.id,
                        detail=f"Module schema is invalid: {error}",
                    )
                )
        if module.id in transition_ids["modules"] or module_records:
            for record in module_records:
                try:
                    from app.systems.sandbox.fields.validation import validate_record_data

                    validate_record_data(record.data, fields)
                except ValueError as error:
                    blockers.append(
                        LifecycleBlocker(
                            code=LifecycleBlockerCode.RECORD_DATA_INVALID,
                            entity_type="records",
                            entity_id=record.id,
                            detail=f"Record data is incompatible with the module schema: {error}",
                        )
                    )

    return tuple(
        sorted(
            blockers,
            key=lambda blocker: (blocker.entity_type, str(blocker.entity_id), blocker.code),
        )
    )
