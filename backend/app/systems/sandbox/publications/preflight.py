"""Document-only publication blockers that prevent persistence failures."""

from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import validate_module_schema
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import (
    _field_type,
    operational_config,
    relationship_metadata,
)
from app.systems.sandbox.publications.schemas import PublicationBlocker


def structure_name_blockers(document: SandboxDocument) -> list[PublicationBlocker]:
    blockers: list[PublicationBlocker] = []
    department_names: set[str] = set()
    for department in document.design.departments:
        if department.closed:
            continue
        if department.name not in department_names:
            department_names.add(department.name)
            continue
        blockers.append(
            PublicationBlocker(
                code="department_name_conflict",
                message="Active department names must be unique",
                target_id=department.id,
            )
        )
    module_names: set[tuple[str, str]] = set()
    for module in document.design.modules:
        key = (module.department_id, module.name)
        if module.closed:
            continue
        if key not in module_names:
            module_names.add(key)
            continue
        blockers.append(
            PublicationBlocker(
                code="module_name_conflict",
                message="Active module names must be unique within a department",
                target_id=module.id,
            )
        )
    return blockers


def live_name_blockers(
    db: Session,
    document: SandboxDocument,
    bindings: dict[Any, dict[str, SandboxBinding]],
) -> list[PublicationBlocker]:
    blockers: list[PublicationBlocker] = []
    bound_department_ids = {
        binding.department_id
        for binding in bindings["department"].values()
        if binding.department_id is not None
    }
    bound_module_ids = {
        binding.module_id
        for binding in bindings["module"].values()
        if binding.module_id is not None
    }
    for department in document.design.departments:
        if department.closed:
            continue
        statement = select(Department.id).where(
            Department.department_name == department.name,
            Department.is_deleted.is_(False),
        )
        if bound_department_ids:
            statement = statement.where(Department.id.not_in(bound_department_ids))
        existing = db.scalar(statement.limit(1))
        if existing is not None:
            blockers.append(
                PublicationBlocker(
                    code="department_name_conflict",
                    message="Active department name is already in use",
                    target_id=department.id,
                )
            )
    for module in document.design.modules:
        if module.closed:
            continue
        department_binding = bindings["department"].get(module.department_id)
        if department_binding is None or department_binding.department_id is None:
            continue
        statement = select(Module.id).where(
            Module.department_id == department_binding.department_id,
            Module.module_name == module.name,
            Module.is_deleted.is_(False),
        )
        if bound_module_ids:
            statement = statement.where(Module.id.not_in(bound_module_ids))
        existing = db.scalar(statement.limit(1))
        if existing is not None:
            blockers.append(
                PublicationBlocker(
                    code="module_name_conflict",
                    message="Active module name is already in use within this department",
                    target_id=module.id,
                )
            )
    return blockers


def module_schema_blockers(document: SandboxDocument) -> list[PublicationBlocker]:
    relationships_by_source: dict[str, list[Any]] = {}
    for relationship in document.design.relationships:
        relationships_by_source.setdefault(relationship.source_module_id, []).append(relationship)
    blockers: list[PublicationBlocker] = []
    for module in document.design.modules:
        if module.closed:
            continue
        try:
            fields = [
                Field(
                    module_id=uuid4(),
                    name=field.name,
                    type=FieldType(_field_type(field)),
                    position=position,
                    required=field.required,
                    config=operational_config(field),
                )
                for position, field in enumerate(item for item in module.fields if not item.closed)
            ]
            for relationship in relationships_by_source.get(module.id, []):
                multiple_targets, multiple_sources = relationship_metadata(relationship)
                fields.append(
                    Field(
                        module_id=uuid4(),
                        name=relationship.name,
                        type=FieldType.RELATIONSHIP,
                        position=len(fields),
                        required=False,
                        config={},
                        relationship_target_module_id=uuid4(),
                        relationship_multiple_targets=multiple_targets,
                        relationship_multiple_sources=multiple_sources,
                    )
                )
            validate_module_schema(fields)
        except ValueError as error:
            blockers.append(
                PublicationBlocker(
                    code="module_schema_invalid",
                    message=str(error),
                    target_id=module.id,
                )
            )
    return blockers
