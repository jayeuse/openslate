"""Bounded export readback against the independently confirmed import receipts."""

import csv
import io
import re
import unicodedata
from collections.abc import Mapping
from datetime import date, datetime
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile
from zlib import error as ZlibError
from zoneinfo import ZoneInfo

import httpx
from defusedxml.common import DefusedXmlException
from defusedxml.ElementTree import fromstring

from operations.sample.phases.actions import SamplePhaseActionError

MAX_BYTES = 8 * 1024 * 1024
MAX_ROWS = 10_000
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def workspace_date(timezone: str) -> date:
    return datetime.now(ZoneInfo(timezone)).date()


def _xlsx_rows(content: bytes) -> list[list[str]]:
    with ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if (
            len(entries) > 64
            or len(names) != len(set(names))
            or any(entry.flag_bits & 1 for entry in entries)
            or sum(entry.file_size for entry in entries) > 4 * MAX_BYTES
        ):
            raise ValueError("Workbook archive exceeds the sample readback bound")
        worksheet = archive.getinfo("xl/worksheets/sheet1.xml")
        if worksheet.file_size > MAX_BYTES:
            raise ValueError("Workbook worksheet exceeds the sample readback bound")
        with archive.open(worksheet) as source:
            payload = source.read(MAX_BYTES + 1)
        if len(payload) > MAX_BYTES:
            raise ValueError("Workbook worksheet exceeds the sample readback bound")
    root = fromstring(payload, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    rows = root.findall(f"{_NS}sheetData/{_NS}row")
    if root.tag != f"{_NS}worksheet" or not rows or len(rows) > MAX_ROWS + 1:
        raise ValueError("Workbook table is missing or exceeds the row bound")
    table: list[list[str]] = []
    for row_index, row in enumerate(rows, 1):
        if row.get("r") != str(row_index):
            raise ValueError("Workbook table has unexpected row positions")
        values: list[str] = []
        for column, cell in enumerate(row.findall(f"{_NS}c")):
            if (
                column >= 3
                or cell.get("r") != f"{chr(65 + column)}{row_index}"
                or cell.get("t") != "inlineStr"
                or cell.find(f"{_NS}f") is not None
            ):
                raise ValueError("Workbook table has unexpected cell positions or types")
            text = cell.findall(f"{_NS}is/{_NS}t")
            if len(text) != 1:
                raise ValueError("Workbook text cell is malformed")
            values.append(text[0].text or "")
        table.append(values)
    return table


def verify_export_response(
    response: httpx.Response,
    *,
    format: str,
    module_name: str,
    dates: set[date],
    headers: list[str],
    expected: Mapping[str, list[str]],
) -> None:
    step = f"export_{format}"
    media_type = "text/csv;charset=utf-8" if format == "csv" else XLSX_MEDIA_TYPE
    ascii_name = unicodedata.normalize("NFKD", module_name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:80] or "module"
    filenames = {
        f'attachment; filename="{slug}-records-{day.isoformat()}.{format}"' for day in dates
    }
    cache_controls = {
        value.strip().lower() for value in response.headers.get("Cache-Control", "").split(",")
    }
    if (
        response.status_code != 200
        or response.headers.get("Content-Type", "").lower().replace(" ", "") != media_type
        or response.headers.get("Content-Disposition") not in filenames
        or "no-store" not in cache_controls
        or response.headers.get("X-Content-Type-Options", "").lower().strip() != "nosniff"
        or len(response.content) > MAX_BYTES
    ):
        raise SamplePhaseActionError("Record export headers or completed size differ", step=step)
    try:
        if format == "csv":
            cells = []
            reader = csv.reader(
                io.StringIO(response.content.decode("utf-8"), newline=""), strict=True
            )
            for index, row in enumerate(reader):
                if index > MAX_ROWS:
                    raise ValueError("CSV exceeds the row bound")
                cells.append(row)
        else:
            cells = _xlsx_rows(response.content)
    except (
        csv.Error,
        UnicodeError,
        BadZipFile,
        ParseError,
        DefusedXmlException,
        KeyError,
        ValueError,
        RuntimeError,
        NotImplementedError,
        OSError,
        ZlibError,
    ):
        raise SamplePhaseActionError("Record export content is malformed", step=step) from None
    if (
        not cells
        or cells[0] != ["Record ID", *headers]
        or len(cells) != len(expected) + 1
        or len(cells) > MAX_ROWS + 1
        or any(len(row) != len(headers) + 1 for row in cells[1:])
        or {row[0]: row[1:] for row in cells[1:]} != expected
    ):
        raise SamplePhaseActionError(
            "Record export IDs, column order, count or values differ", step=step
        )
