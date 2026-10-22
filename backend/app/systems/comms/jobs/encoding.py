"""Actual bounded CSV/XLSX encoding; never publish truncated or partially encoded output."""

import csv
import io
import tempfile
from collections.abc import Iterable, Mapping
from datetime import datetime
from pathlib import Path

from xlsxwriter import Workbook

from app.core.base_model import utc_now
from app.systems.sandbox.records.export import safe_text

MAX_BYTES = 8 * 1024 * 1024
# Same finite raw-content budget as the existing record XLSX encoder, not a row entitlement.
MAX_RAW_BYTES = 16 * MAX_BYTES
HEADERS = (
    "conversation_id",
    "conversation",
    "message_id",
    "sequence",
    "author_id",
    "author",
    "created_at",
    "parent_id",
    "body",
)
MIME = {
    "csv": "text/csv; charset=utf-8",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class ExportTooLarge(ValueError):
    pass


def bounded_bytes(content: bytes) -> bytes:
    if len(content) > MAX_BYTES:
        raise ExportTooLarge("Export exceeds the inclusive 8 MiB artifact bound")
    return content


def _rows(rows: Iterable[Mapping[str, str]], deadline: datetime | None) -> Iterable[list[str]]:
    total = 0
    yield list(HEADERS)
    for item in rows:
        if deadline is not None and utc_now() >= deadline:
            raise ExportTooLarge("Export generation lease expired")
        values = [item.get(key, "") for key in HEADERS]
        total += sum(len(value.encode("utf-8")) for value in values)
        if total > MAX_RAW_BYTES:
            raise ExportTooLarge("Export generation resource bound exceeded")
        yield values


def encode(
    format: str, rows: Iterable[Mapping[str, str]], *, deadline: datetime | None = None
) -> bytes:
    if format == "csv":
        output = io.BytesIO()
        for row in _rows(rows, deadline):
            cell = io.StringIO(newline="")
            csv.writer(cell, lineterminator="\r\n").writerow([safe_text(value) for value in row])
            content = cell.getvalue().encode("utf-8")
            if output.tell() + len(content) > MAX_BYTES:
                raise ExportTooLarge("Export exceeds the inclusive 8 MiB artifact bound")
            output.write(content)
        return bounded_bytes(output.getvalue())
    if format != "xlsx":
        raise ValueError("Unknown export format")
    with tempfile.TemporaryDirectory(prefix="openslate-comms-export-") as directory:
        path = Path(directory) / "export.xlsx"
        with Workbook(
            str(path),
            {
                "constant_memory": True,
                "tmpdir": directory,
                "strings_to_formulas": False,
                "strings_to_urls": False,
            },
        ) as book:
            sheet = book.add_worksheet("Messages")
            for row_index, row in enumerate(_rows(rows, deadline)):
                for column, value in enumerate(row):
                    if sheet.write_string(row_index, column, value) != 0:
                        raise ValueError("Export cell cannot be represented without truncation")
        if path.stat().st_size > MAX_BYTES:
            raise ExportTooLarge("Export exceeds the inclusive 8 MiB artifact bound")
        return bounded_bytes(path.read_bytes())
