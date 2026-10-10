"""Resolve portable Board structure against live Sandbox names within one transaction."""

import json
from dataclasses import dataclass
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.systems.boards.portability_queries import (
    PortabilityError as PortabilityError,
)
from app.systems.boards.portability_queries import (
    inline_config,
    query_references,
)
from app.systems.boards.portability_queries import (
    reject_nonportable_person_filter as reject_nonportable_person_filter,
)
from app.systems.boards.portability_queries import (
    select_filter_labels as select_filter_labels,
)
from app.systems.boards.portability_schemas import PortableBoardBundle, PortableWidgetConfig
from app.systems.boards.schemas import BoardCreate
from app.systems.boards.widget_schemas import BoardWidgetSpec
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module

MAX_PORTABLE_BOARD_BYTES = 1024 * 1024


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
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
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
    rows = db.scalars(
        select(Module)
        .where(
            or_(
                *(
                    and_(
                        Module.department_id == departments[department].id,
                        Module.module_name == module,
                    )
                    for department, module in sorted(sources)
                )
            ),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
        .order_by(Module.id)
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    ).all()
    department_names = {department.id: name for name, department in departments.items()}
    found: dict[tuple[str, str], Module] = {}
    for row in rows:
        department_name = department_names.get(row.department_id)
        key = (department_name, row.module_name) if department_name is not None else None
        if key not in sources:
            continue
        if not _active(row) or key in found:
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
    rows = db.scalars(
        select(Field)
        .where(
            or_(
                *(
                    and_(Field.module_id == module_id, Field.name == name)
                    for module_id, names in sorted(references.items())
                    for name in sorted(names)
                )
            ),
            Field.is_deleted.is_(False),
            Field.deleted_at.is_(None),
        )
        .order_by(Field.id)
        .with_for_update(nowait=True)
        .execution_options(populate_existing=True)
    ).all()
    found: dict[tuple[UUID, str], Field] = {}
    for row in rows:
        key = (row.module_id, row.name)
        if row.name not in references.get(row.module_id, set()):
            continue
        if not _active(row) or key in found:
            raise PortabilityError("board_source_unavailable")
        found[key] = row
    if {
        module_id: {name for found_module, name in found if found_module == module_id}
        for module_id in references
    } != references:
        raise PortabilityError("board_source_unavailable")
    return found


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
        if isinstance(widget.config, PortableWidgetConfig):
            requested.update(field.name for field in widget.config.fields)
            requested.update(field.name for field in widget.config.filters)
            if widget.config.metric is not None:
                requested.add(widget.config.metric.name)
        else:
            requested.update(field.name for field in query_references(widget.config.query))
    fields = _fields(db, {module_id: names for module_id, names in references.items() if names})

    widgets: list[BoardWidgetSpec] = []
    for widget in configuration.widgets:
        module_id = modules[(widget.source.department_name, widget.source.module_name)].id
        try:
            config = inline_config(widget.config, module_id, fields)
            widgets.append(
                BoardWidgetSpec(
                    name=widget.name,
                    widget_type=widget.widget_type,
                    module_id=module_id,
                    config=config,
                    size={"half": "M", "full": "L"}.get(widget.config.size, widget.config.size),
                    pinned=widget.config.pinned,
                )
            )
        except ValidationError as error:
            raise PortabilityError("board_source_unavailable") from error

    board = BoardCreate(name=configuration.name, description=configuration.description)
    return ResolvedBoardConfiguration(board=board, widgets=tuple(widgets))
