"""Independent CSV and constant-memory-shaped OOXML fixtures for sample exports."""

import csv
import io
import json
import re
import unicodedata
import warnings
from datetime import datetime, timedelta
from xml.etree.ElementTree import Element, SubElement, tostring
from zipfile import ZIP_DEFLATED, ZipFile
from zoneinfo import ZoneInfo

import httpx

from app.systems.sandbox.records.query_schemas import ExportRequest

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def workbook_bytes(rows, *, fault="none"):
    """Write fixture cell values directly, without a product encoder or its helpers."""
    worksheet = Element("worksheet", xmlns=SHEET_NS)
    data = SubElement(worksheet, "sheetData")
    for row_index, values in enumerate(rows, 1):
        row = SubElement(data, "row", r=str(row_index))
        for column, value in enumerate(values):
            cell = SubElement(row, "c", r=f"{chr(65 + column)}{row_index}", t="inlineStr")
            if fault == "xlsx_formula" and row_index == 2 and column == 1:
                SubElement(cell, "f").text = "1+1"
            SubElement(SubElement(cell, "is"), "t").text = value
    payload = tostring(worksheet, encoding="utf-8", xml_declaration=True)
    if fault == "xlsx_large_xml":
        payload += b" " * (8 * 1024 * 1024 + 1)
    elif fault == "xlsx_entities":
        payload = payload.replace(
            b"<worksheet", b"<!DOCTYPE worksheet [<!ENTITY attack 'private-canary'>]><worksheet", 1
        )
    elif fault == "xlsx_malformed_xml":
        payload = b"<worksheet><unclosed>"
    parts = {
        "[Content_Types].xml": (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" '
            'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-'
            'officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" '
            'Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            f'<workbook xmlns="{SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Records" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/>'
            "</Relationships>"
        ),
        "xl/worksheets/sheet1.xml": payload,
    }
    output = io.BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for path, content in parts.items():
            archive.writestr(path, content)
        if fault == "xlsx_duplicate_member":
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="Duplicate name:.*", category=UserWarning)
                archive.writestr("xl/worksheets/sheet1.xml", payload)
    return output.getvalue()


def export_response(wire, request):
    body = json.loads(request.content)
    parsed = ExportRequest.model_validate(body)
    fields = wire.fields()
    assert str(parsed.module_id) == next(
        row["id"] for row in wire.lifecycle.live.values() if "department_id" in row
    )
    assert [reference.field_id for reference in parsed.definition.columns] == [
        field.id for field in fields
    ]
    format = parsed.format
    fault = wire.fault if wire.fault.startswith(format + "_") else "none"
    columns = [field.name for field in fields]
    rows = [
        [
            *([key] if parsed.include_record_id else []),
            *[row["data"][str(field.id)] for field in fields],
        ]
        for key, row in wire.records.items()
        if not row["is_deleted"]
    ]
    headers = [*(["Record ID"] if parsed.include_record_id else []), *columns]
    if fault.endswith("_count"):
        rows.append(["extra", "wrong", "wrong"])
    elif fault.endswith("_content"):
        rows[0][1] = "Wrong imported value"
    elif fault.endswith("_ids"):
        rows[0][0] = "7193f7eb-4f53-4f9a-a928-59387341b871"
    elif fault.endswith("_columns"):
        headers[1:] = reversed(headers[1:])
    if format == "csv":
        output = io.StringIO(newline="")
        csv.writer(output).writerows([headers, *rows])
        content = output.getvalue().encode()
    else:
        content = workbook_bytes([headers, *rows], fault=fault)
        if fault == "xlsx_malformed_zip":
            content = b"invalid workbook"
    if fault.endswith("_too_large"):
        content = b"x" * (8 * 1024 * 1024 + 1)
    local_date = datetime.now(ZoneInfo(wire.dataset.organization.identity.timezone)).date()
    if fault.endswith("_wrong_date"):
        local_date += timedelta(days=10)
    module = next(row for row in wire.lifecycle.live.values() if "department_id" in row)
    ascii_name = unicodedata.normalize("NFKD", module["name"]).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:80] or "module"
    filename = f"{slug}-records-{local_date.isoformat()}.{format}"
    if fault.endswith("_unsafe_filename"):
        filename = f"../{filename}"
    response_headers = {
        "Content-Type": "text/csv; charset=utf-8" if format == "csv" else XLSX_MEDIA_TYPE,
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "public" if fault.endswith("_cache") else "no-store",
        "X-Content-Type-Options": "missing" if fault.endswith("_nosniff") else "nosniff",
    }
    if fault.endswith("_mime"):
        response_headers["Content-Type"] = "application/json"
    status = 403 if fault.endswith("_denied") else 503 if fault.endswith("_unavailable") else 200
    return httpx.Response(status, content=content, headers=response_headers)
