"""Resolve portable Board structure against live Sandbox names within one transaction."""

import json
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.portability_schemas import (
    PortableBoardBundle,
    PortableFieldReference,
    PortableQueryFilter,
)
from app.systems.boards.schemas import BoardCreate
from app.systems.boards.widget_schemas import BoardWidgetConfig, BoardWidgetSpec
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query import comparison_value
from app.systems.sandbox.records.query_schemas import FieldReference, QueryFilter

MAX_PORTABLE_BOARD_BYTES = 1024 * 1024


class PortabilityError(ValueError):
    """Safe domain rejection; the caller maps the code to its route-local HTTP shape."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ResolvedBoardConfiguration:
    board: BoardCreate
    widgets: tuple[BoardWidgetSpec, ...]


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _invalid_json_constant(value: str) -> object:
    raise ValueError("Non-finite JSON number")


def parse_portable_board(raw: bytes) -> PortableBoardBundle:
    """Accept only a bounded UTF-8 v3 bundle, with no unknown or duplicate keys."""

    if len(raw) > MAX_PORTABLE_BOARD_BYTES:
        raise PortabilityError("board_bundle_too_large")
    try:
        document: object = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_invalid_json_constant,
        )
        return PortableBoardBundle.model_validate(document)
    except (UnicodeDecodeError, ValueError, RecursionError, ValidationError) as error:
        raise PortabilityError("board_bundle_invalid") from error


def _active(row: Department | Module | Field) -> bool:
    return not row.is_deleted and row.deleted_at is None


def _departments(db: Session, names: set[str]) -> dict[str, Department]:
    if not names:
        return {}
    rows = db.scalars(
        select(Department)
        .where(
            Department.department_name.in_(sorted(names)),
            Department.is_deleted.is_(False),
            Department.deleted_at.is_(None),
        )
        .order_by(Department.id)
        .with_for_update()
    ).all()
    found: dict[str, Department] = {}
    for row in rows:
        if not _active(row) or row.department_name not in names or row.department_name in found:
            raise PortabilityError("board_source_unavailable")
        found[row.department_name] = row
    if set(found) != names:
        raise PortabilityError("board_source_unavailable")
    return found


def _modules(
    db: Session, sources: set[tuple[str, str]], departments: dict[str, Department]
) -> dict[tuple[str, str], Module]:
    if not sources:
        return {}
    department_ids = {departments[name].id for name, _ in sources}
    module_names = {name for _, name in sources}
    rows = db.scalars(
        select(Module)
        .where(
            Module.department_id.in_(sorted(department_ids)),
            Module.module_name.in_(sorted(module_names)),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
        .order_by(Module.id)
        .with_for_update()
    ).all()
    department_names = {department.id: name for name, department in departments.items()}
    found: dict[tuple[str, str], Module] = {}
    for row in rows:
        department_name = department_names.get(row.department_id)
        key = (department_name, row.module_name) if department_name is not None else None
        if not _active(row) or key not in sources or key in found:
            raise PortabilityError("board_source_unavailable")
        assert key is not None
        found[key] = row
    if set(found) != sources:
        raise PortabilityError("board_source_unavailable")
    return found


def _fields(
    db: Session,
    references: dict[UUID, set[str]],
) -> dict[tuple[UUID, str], Field]:
    if not references:
        return {}
    names = {name for requested in references.values() for name in requested}
    rows = db.scalars(
        select(Field)
        .where(
            Field.module_id.in_(sorted(references)),
            Field.name.in_(sorted(names)),
            Field.is_deleted.is_(False),
            Field.deleted_at.is_(None),
        )
        .order_by(Field.id)
        .with_for_update()
    ).all()
    found: dict[tuple[UUID, str], Field] = {}
    for row in rows:
        key = (row.module_id, row.name)
        if not _active(row) or row.name not in references.get(row.module_id, set()) or key in found:
            raise PortabilityError("board_source_unavailable")
        found[key] = row
    if {
        module_id: {name for found_module, name in found if found_module == module_id}
        for module_id in references
    } != references:
        raise PortabilityError("board_source_unavailable")
    return found


def _field_reference(
    reference: PortableFieldReference, module_id: UUID, fields: dict[tuple[UUID, str], Field]
) -> FieldReference:
    field = fields.get((module_id, reference.name))
    if field is None or field.type != reference.expected_type:
        raise PortabilityError("board_source_unavailable")
    return FieldReference(field_id=field.id, expected_type=reference.expected_type)


def _filter(
    reference: PortableQueryFilter, module_id: UUID, fields: dict[tuple[UUID, str], Field]
) -> QueryFilter:
    field = fields.get((module_id, reference.name))
    if field is None or field.type != reference.expected_type:
        raise PortabilityError("board_source_unavailable")
    try:
        predicate = QueryFilter(
            field_id=field.id,
            expected_type=reference.expected_type,
            operator=reference.operator,
            value=reference.value,
        )
        comparison_value(field, predicate)
    except (HTTPException, ValidationError, ValueError) as error:
        raise PortabilityError("board_source_unavailable") from error
    return predicate


def resolve_portable_board(db: Session, bundle: PortableBoardBundle) -> ResolvedBoardConfiguration:
    """Return validated create specs without writes; caller must commit in this transaction.

    Department, module and field rows are locked in that order. The eventual create
    route must not commit between this resolution and its Board/widget inserts.
    """

    configuration = bundle.configuration
    source_keys = {
        (widget.source.department_name, widget.source.module_name)
        for widget in configuration.widgets
    }
    department_names = {name for name, _ in source_keys}
    departments = _departments(db, department_names)
    modules = _modules(db, source_keys, departments)
    references: dict[UUID, set[str]] = {}
    for widget in configuration.widgets:
        module_id = modules[(widget.source.department_name, widget.source.module_name)].id
        requested = references.setdefault(module_id, set())
        requested.update(field.name for field in widget.config.fields)
        requested.update(field.name for field in widget.config.filters)
        if widget.config.metric is not None:
            requested.add(widget.config.metric.name)
    fields = _fields(db, {module_id: names for module_id, names in references.items() if names})

    widgets: list[BoardWidgetSpec] = []
    for widget in configuration.widgets:
        module_id = modules[(widget.source.department_name, widget.source.module_name)].id
        try:
            config = BoardWidgetConfig(
                fields=[
                    _field_reference(field, module_id, fields) for field in widget.config.fields
                ],
                filters=[_filter(item, module_id, fields) for item in widget.config.filters],
                logic=widget.config.logic,
                metric=(
                    _field_reference(widget.config.metric, module_id, fields)
                    if widget.config.metric is not None
                    else None
                ),
                visualization=widget.config.visualization,
                size=widget.config.size,
                refresh=widget.config.refresh,
                pinned=widget.config.pinned,
            )
            widgets.append(
                BoardWidgetSpec(
                    name=widget.name,
                    widget_type=widget.widget_type,
                    module_id=module_id,
                    config=config,
                )
            )
        except ValidationError as error:
            raise PortabilityError("board_source_unavailable") from error

    board = BoardCreate(name=configuration.name, description=configuration.description)
    return ResolvedBoardConfiguration(board=board, widgets=tuple(widgets))
