"""Typed, formula-safe Excel files with bounded rows and a complete-file byte cap."""

import io
import math
from collections.abc import Iterable
from datetime import date, datetime
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from xlsxwriter import Workbook
from xlsxwriter.exceptions import FileCreateError
from xlsxwriter.format import Format
from xlsxwriter.utility import xl_range
from xlsxwriter.worksheet import Worksheet

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records import export as export_rules
from app.systems.sandbox.records.display import FieldDisplayResolver
from app.systems.sandbox.records.export import ExportContext
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query import RecordProjection
from app.systems.sandbox.records.query_schemas import NUMERIC_FIELD_TYPES, ExportRequest

THEME_ACCENTS = {
    "slate": "#2563eb",
    "whiteboard": "#1d5fb8",
    "triplicate": "#1f4fbf",
    "stockroom": "#1d5ac4",
}


def unrepresentable_cell() -> HTTPException:
    return HTTPException(
        422,
        detail={
            "code": "export_cell_unrepresentable",
            "message": (
                "Excel cannot represent a cell without changing it; choose CSV or narrow the export"
            ),
        },
    )


def write_text(sheet: Worksheet, row: int, col: int, value: str, style: Format) -> None:
    if sheet.write_string(row, col, value, style) != 0:
        raise unrepresentable_cell()


def data_format(workbook: Workbook, field: Field | None, *, banded: bool = False) -> Format:
    properties: dict[str, object] = {"valign": "top"}
    if banded:
        properties["bg_color"] = "#f1f5f9"
    if field is not None:
        if field.type == FieldType.INTEGER:
            properties["num_format"] = "0"
        elif field.type == FieldType.DATE:
            properties["num_format"] = "yyyy-mm-dd"
        elif field.type == FieldType.DATETIME:
            properties["num_format"] = "yyyy-mm-dd hh:mm:ss"
        elif field.type == FieldType.LONG_TEXT:
            properties["text_wrap"] = True
    return workbook.add_format(properties)


def write_cell(
    sheet: Worksheet,
    row: int,
    col: int,
    value: str | int | float | bool | date | datetime | None,
    style: Format,
) -> None:
    if isinstance(value, str):
        write_text(sheet, row, col, value, style)
    elif isinstance(value, bool):
        sheet.write_boolean(row, col, value, style)
    elif isinstance(value, (date, datetime)):
        sheet.write_datetime(row, col, value, style)
    elif value is None:
        sheet.write_blank(row, col, None, style)
    else:
        if not math.isfinite(value):
            raise unrepresentable_cell()
        sheet.write_number(row, col, value, style)


def encode_xlsx(
    rows: Iterable[Record | RecordProjection],
    fields: list[Field],
    payload: ExportRequest,
    context: ExportContext,
    resolver: FieldDisplayResolver | None = None,
) -> tuple[bytes, int]:
    output = io.BytesIO()
    count = 0
    try:
        # The owned directory also cleans up interrupted or failed workbook assembly.
        with TemporaryDirectory(prefix="openslate-export-") as temporary:
            with Workbook(
                output,
                {
                    "constant_memory": True,
                    "tmpdir": temporary,
                    "strings_to_formulas": False,
                    "strings_to_urls": False,
                },
            ) as workbook:
                workbook.set_properties(
                    {"author": context.actor_name, "created": context.generated_at}
                )
                sheet = workbook.add_worksheet("Records")
                header_properties: dict[str, object] = {"bold": True}
                if payload.accent != "none":
                    header_properties.update(
                        bg_color=(
                            THEME_ACCENTS[context.theme] if payload.accent == "theme" else "#475569"
                        ),
                        font_color="#ffffff",
                    )
                header_style = workbook.add_format(header_properties)
                header_row = 0
                title = payload.title.strip() if payload.title is not None else None
                if title or payload.include_details:
                    write_text(
                        sheet,
                        0,
                        0,
                        title or context.view_name or context.module_name,
                        workbook.add_format({"bold": True, "font_size": 18}),
                    )
                    sheet.set_row(0, 28)
                    header_row = 2
                if payload.include_details:
                    local_time = context.generated_at.astimezone(ZoneInfo(context.timezone))
                    details = (
                        f"Exported by {context.actor_name}\n"
                        f"Generated {local_time.isoformat(timespec='seconds')} "
                        f"({context.timezone})\n"
                        f"Module: {context.module_name}"
                        + (f"; View: {context.view_name}" if context.view_name else "")
                        + f"\nFilters: {context.filter_summary}"
                    )
                    write_text(sheet, 1, 0, details, workbook.add_format({"text_wrap": True}))
                    sheet.set_row(1, 75)
                    header_row = 3

                columns: list[Field | None] = [
                    *([None] if payload.include_record_id else []),
                    *fields,
                ]
                headers = [
                    "Record ID"
                    if field is None
                    else field.name
                    + (f" ({context.timezone})" if field.type == FieldType.DATETIME else "")
                    for field in columns
                ]
                widths = [min(48, max(12, len(header) + 2)) for header in headers]
                formats = [
                    (data_format(workbook, field), data_format(workbook, field, banded=True))
                    for field in columns
                ]
                totals = {
                    col: 0.0
                    for col, field in enumerate(columns)
                    if field is not None and field.type in NUMERIC_FIELD_TYPES
                }
                for col, header in enumerate(headers):
                    write_text(sheet, header_row, col, header, header_style)
                sheet.set_row(header_row, 24)
                data_start = header_row + 1
                for record in rows:
                    count += 1
                    if count > export_rules.MAX_ROWS:
                        raise export_rules.limit_exceeded()
                    row = data_start + count - 1
                    for col, field in enumerate(columns):
                        value = (
                            str(record.id)
                            if field is None
                            else export_rules.xlsx_cell(
                                record.data.get(str(field.id)), field, context.timezone, resolver
                            )
                        )
                        style = formats[col][int(payload.banded and count % 2 == 0)]
                        write_cell(sheet, row, col, value, style)
                        if value is not None:
                            width = max((len(line) for line in str(value).splitlines()), default=0)
                            widths[col] = min(48, max(widths[col], width + 2))
                        if col in totals and isinstance(value, (int, float)):
                            totals[col] += value
                sheet.freeze_panes(data_start, 0)
                sheet.autofilter(header_row, 0, data_start + count - 1, len(columns) - 1)
                for col, width in enumerate(widths):
                    sheet.set_column(col, col, width)
                if payload.totals:
                    total_row = data_start + count
                    total_style = workbook.add_format({"bold": True, "top": 1})
                    label_col = next(
                        (col for col in range(len(columns)) if col not in totals), None
                    )
                    if label_col is not None:
                        write_text(sheet, total_row, label_col, "Total", total_style)
                    for col, cached in totals.items():
                        if not math.isfinite(cached):
                            raise unrepresentable_cell()
                        start = data_start if count else data_start + 1
                        end = data_start + count - 1 if count else start
                        sheet.write_formula(
                            total_row,
                            col,
                            f"=SUBTOTAL(109,{xl_range(start, col, end, col)})",
                            total_style,
                            cached,
                        )
    except FileCreateError as error:
        raise HTTPException(503, detail="Unable to create export") from error
    content = output.getvalue()
    if len(content) > export_rules.MAX_BYTES:
        raise export_rules.limit_exceeded()
    return content, count
