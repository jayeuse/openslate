"""Complete, bounded Report output captured from one PostgreSQL read snapshot."""

import csv
import io
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Engine, literal, select
from sqlalchemy.orm import Session

from app.systems.access.policy.authorization import authorize_workspace_capabilities
from app.systems.access.users.permissions import Capability
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.openview.reports.models import Report, ReportRun
from app.systems.openview.reports.schemas import ReportRecipe
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.export import (
    MAX_BYTES,
    MAX_ROWS,
    format_cell,
    limit_exceeded,
    safe_text,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query import (
    compile_query,
    field_expression,
    validate_definition,
)
from app.systems.sandbox.records.query_schemas import QueryDefinition


@dataclass(frozen=True)
class ReportSnapshot:
    report_id: UUID
    module_id: UUID
    recipe_revision: int
    recipe: dict[str, object]
    headings: list[str]
    rows: list[tuple[UUID, list[str]]]
    csv_bytes: bytes


REPORT_RUN_METADATA_COLUMNS = (
    ReportRun.report_id,
    ReportRun.recipe_revision,
    ReportRun.row_count,
    ReportRun.headings,
    ReportRun.created_at,
)


def _invalid_report() -> HTTPException:
    return HTTPException(
        409,
        detail={
            "code": "report_invalid",
            "message": "The Report source or selected fields are unavailable",
        },
    )


def _active_report(db: Session, report_id: UUID, owner_id: UUID) -> Report:
    report = db.scalar(select(Report).where(Report.id == report_id, Report.owner_id == owner_id))
    if report is None:
        raise HTTPException(404, detail="Report not found")
    if report.is_deleted:
        raise HTTPException(
            409,
            detail={"code": "report_archived", "message": "Restore the Report before running it"},
        )
    module = db.get(Module, report.module_id)
    if (
        module is None
        or module.is_deleted
        or module.deleted_at is not None
        or not module.is_schema_accepted
    ):
        raise _invalid_report()
    return report


def _definition(recipe: ReportRecipe) -> QueryDefinition:
    return QueryDefinition(
        columns=recipe.fields,
        filters=recipe.filters,
        logic=recipe.logic,
        sort=recipe.sorts,
    )


def validate_report_recipe(db: Session, module_id: UUID, recipe: ReportRecipe) -> None:
    """Reject unavailable source fields before persisting a recipe or run."""
    module = db.scalar(
        select(Module)
        .where(
            Module.id == module_id,
            Module.is_deleted.is_(False),
            Module.is_schema_accepted.is_(True),
        )
        .with_for_update()
    )
    if module is None:
        raise _invalid_report()
    definition = _definition(recipe)
    try:
        fields = validate_definition(
            db,
            module_id,
            definition,
            extra_references=(recipe.group_by,) if recipe.group_by is not None else (),
        )
    except HTTPException as error:
        if error.status_code == 409:
            raise _invalid_report() from error
        raise
    references = [*recipe.fields, *recipe.filters, *recipe.sorts]
    if recipe.group_by is not None:
        references.append(recipe.group_by)
    if any(fields[reference.field_id].is_deleted for reference in references):
        raise _invalid_report()


def capture_report_snapshot(engine: Engine, report_id: UUID, owner_id: UUID) -> ReportSnapshot:
    """Freeze source values, formatting, ordering and CSV before any write."""

    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with Session(bind=connection) as db:
            authorize_workspace_capabilities(
                db,
                actor_id=owner_id,
                expected_role_id=None,
                capabilities=(Capability.RECORDS_READ, Capability.RECORDS_WRITE),
            )
            report = _active_report(db, report_id, owner_id)
            recipe = ReportRecipe.model_validate(report.recipe)
            definition = _definition(recipe)
            fields_by_id = validate_definition(
                db,
                report.module_id,
                definition,
                extra_references=(recipe.group_by,) if recipe.group_by else (),
            )
            references = [*recipe.fields, *recipe.filters, *recipe.sorts]
            if recipe.group_by is not None:
                references.append(recipe.group_by)
            if any(fields_by_id[reference.field_id].is_deleted for reference in references):
                raise _invalid_report()
            fields = [fields_by_id[reference.field_id] for reference in recipe.fields]
            group_field = (
                fields_by_id[recipe.group_by.field_id] if recipe.group_by is not None else None
            )
            profile = db.scalar(
                select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True))
            )
            if profile is None:
                raise HTTPException(503, detail="Workspace configuration is unavailable")

            statement = compile_query(report.module_id, definition, fields_by_id)
            if group_field is not None:
                group_expression = field_expression(group_field)
                ordering = [group_expression.asc().nulls_last()]
                ordering.extend(
                    (
                        field_expression(fields_by_id[sort.field_id]).desc()
                        if sort.direction == "desc"
                        else field_expression(fields_by_id[sort.field_id]).asc()
                    ).nulls_last()
                    for sort in recipe.sorts
                )
                statement = statement.order_by(None).order_by(*ordering, Record.id.asc())
                statement = statement.add_columns(group_expression.label("group_value"))
            else:
                statement = statement.add_columns(literal(None).label("group_value"))
            results = db.execute(statement.limit(MAX_ROWS + 1).execution_options(yield_per=100))

            headings = [safe_text(field.name) for field in fields]
            output = bytearray()
            row_buffer = io.StringIO(newline="")
            writer = csv.writer(row_buffer)

            def append_row(cells: list[str]) -> None:
                row_buffer.seek(0)
                row_buffer.truncate()
                writer.writerow(cells)
                encoded = row_buffer.getvalue().encode("utf-8")
                if len(output) + len(encoded) > MAX_BYTES:
                    raise limit_exceeded()
                output.extend(encoded)

            def summary_row(label: str) -> list[str]:
                return [label, *([""] * (len(fields) - 1))]

            append_row(headings)
            frozen_rows: list[tuple[UUID, list[str]]] = []
            previous_group: Any = None
            has_group = False
            group_count = 0
            for record, group_value in results:
                if len(frozen_rows) >= MAX_ROWS:
                    raise limit_exceeded()
                if group_field is not None and (not has_group or group_value != previous_group):
                    if has_group and recipe.include_row_count:
                        append_row(summary_row(f"Group total: {group_count}"))
                    group_label = (
                        "Unspecified"
                        if group_value is None
                        else format_cell(
                            record.data.get(str(group_field.id)),
                            group_field,
                            profile.timezone,
                            profile.locale,
                        )
                    )
                    append_row(summary_row(f"Group: {group_label}"))
                    previous_group = group_value
                    has_group = True
                    group_count = 0
                try:
                    cells = [
                        format_cell(
                            record.data.get(str(field.id)),
                            field,
                            profile.timezone,
                            profile.locale,
                        )
                        for field in fields
                    ]
                except (TypeError, ValueError) as error:
                    raise _invalid_report() from error
                frozen_rows.append((record.id, cells))
                append_row(cells)
                group_count += 1
            if has_group and recipe.include_row_count:
                append_row(summary_row(f"Group total: {group_count}"))
            if recipe.include_row_count:
                append_row(summary_row(f"Grand total: {len(frozen_rows)}"))

            return ReportSnapshot(
                report_id=report.id,
                module_id=report.module_id,
                recipe_revision=report.revision,
                recipe=dict(report.recipe),
                headings=headings,
                rows=frozen_rows,
                csv_bytes=bytes(output),
            )
