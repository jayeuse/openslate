"""Export options and complete files through the real authenticated API boundary."""

import csv
import io
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID
from zipfile import ZipFile
from zoneinfo import ZoneInfo

import pytest
from defusedxml import ElementTree
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import GroupAccess
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.openview.views.models import SavedView
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records import export as exporter
from app.systems.sandbox.records import query_router
from app.systems.sandbox.records.models import Record
from tests.record_queries.export_http_support import (
    ExportWorld,
)
from tests.record_queries.export_http_support import (
    export_world as export_world,
)
from tests.record_queries.export_http_support import (
    provider_account as provider_account,
)

pytestmark = pytest.mark.integration
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def test_reader_exports_filtered_csv_with_default_columns_and_private_receipt(
    export_world: ExportWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        exporter, "utc_now", lambda: datetime(2026, 10, 8, 16, 30, tzinfo=UTC), raising=False
    )
    response = export_world.client.post("/api/records/export", json=export_world.payload())
    assert response.status_code == 200
    assert list(csv.reader(io.StringIO(response.text))) == [
        ["Label", "Amount"],
        ["Gamma", "3"],
        ["Beta", "10"],
    ]
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == (
        'attachment; filename="sales-ledger-records-2026-10-08.csv"'
    )
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    events = export_world.events()
    assert len(events) == 1
    assert events[0].event_metadata == {
        "format": "csv",
        "row_count": 2,
        "column_count": 2,
        "filter_count": 1,
        "view_id": None,
        "filters": [{"field_id": str(export_world.amount_id), "operator": "gt"}],
    }


def test_export_with_no_columns_requires_optional_record_id(export_world: ExportWorld) -> None:
    export_world.role("admin")
    payload = export_world.payload()
    payload["definition"]["columns"] = []
    rejected = export_world.client.post("/api/records/export", json=payload)
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "export_no_columns"
    assert export_world.events() == []
    accepted = export_world.client.post(
        "/api/records/export", json={**payload, "include_record_id": True}
    )
    assert accepted.status_code == 200
    assert list(csv.reader(io.StringIO(accepted.text))) == [
        ["Record ID"],
        [str(export_world.record_ids[2])],
        [str(export_world.record_ids[1])],
    ]


def test_reader_exports_styled_xlsx_and_complete_reordered_data(export_world: ExportWorld) -> None:
    payload = export_world.payload(
        format="xlsx",
        view_id=str(export_world.view_id),
        title="=A1+1",
        include_record_id=True,
        banded=True,
        totals=True,
        limit=1,
        offset=100,
    )
    payload["definition"]["columns"].reverse()
    response = export_world.client.post("/api/records/export", json=payload)
    assert response.status_code == 200
    assert response.headers["content-type"] == (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert "sales-ledger-reviewed-records-" in response.headers["content-disposition"]
    with ZipFile(io.BytesIO(response.content)) as archive:
        worksheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        cells = {cell.attrib["r"]: cell for cell in worksheet.findall(".//s:c", NS)}

        def text(address: str) -> str:
            return "".join(cells[address].itertext())

        assert cells["A1"].attrib["t"] == "inlineStr" and text("A1") == "=A1+1"
        assert "Export reader" in text("A2") and "Reviewed records" in text("A2")
        assert [text(address) for address in ("A4", "B4", "C4")] == ["Record ID", "Amount", "Label"]
        assert [text(address) for address in ("A5", "A6")] == [
            str(export_world.record_ids[2]),
            str(export_world.record_ids[1]),
        ]
        assert [text(address) for address in ("B5", "B6")] == ["3", "10"]
        assert [text(address) for address in ("C5", "C6")] == ["Gamma", "Beta"]
        assert cells["B5"].get("t") in (None, "n")
        assert cells["B7"].find("s:f", NS).text == "SUBTOTAL(109,B5:B6)"
        assert float(cells["B7"].find("s:v", NS).text) == 13
        assert worksheet.find("s:autoFilter", NS).attrib["ref"] == "A4:C6"
        assert worksheet.find(".//s:pane", NS).attrib["ySplit"] == "4"
        assert cells["C5"].get("s") != cells["C6"].get("s")
        assert not worksheet.findall(".//s:hyperlink", NS)
    assert export_world.events()[0].event_metadata["column_count"] == 3


@pytest.mark.parametrize("lost", ["module_access", "session", "account"])
def test_export_rechecks_exact_authority_after_generation(
    export_world: ExportWorld, monkeypatch: pytest.MonkeyPatch, lost: str
) -> None:
    if lost != "module_access":
        export_world.role("admin")
    original = query_router.export_snapshot
    completed = []

    def revoke_after_snapshot(engine, payload, *, reader_id: UUID):
        result = original(engine, payload, reader_id=reader_id)
        with Session(export_world.owner) as db:
            if lost == "module_access":
                db.get(GroupAccess, export_world.grant_id).is_deleted = True
            elif lost == "session":
                db.get(IdentitySession, export_world.session_id).revoked_at = datetime.now(UTC)
            else:
                db.get(User, export_world.actor_id).status = "disabled"
            db.commit()
        completed.append(True)
        return result

    monkeypatch.setattr(query_router, "export_snapshot", revoke_after_snapshot)
    response = export_world.client.post("/api/records/export", json=export_world.payload())
    assert completed == [True]
    assert response.status_code == 403
    assert response.headers["content-type"].startswith("application/json")
    assert b"Gamma" not in response.content
    assert export_world.events() == []


def test_export_query_failure_releases_no_bytes(
    export_world: ExportWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    export_world.role("admin")

    def unavailable_snapshot(*_args, **_kwargs):
        raise OperationalError("unavailable snapshot", {}, RuntimeError("unavailable"))

    monkeypatch.setattr(query_router, "export_snapshot", unavailable_snapshot)
    response = export_world.client.post("/api/records/export", json=export_world.payload())
    assert response.status_code == 503
    assert response.json()["detail"] == "Unable to create export"
    assert export_world.events() == []


def test_xlsx_keeps_typed_cells_and_untrusted_text_without_precision_loss(
    export_world: ExportWorld,
    tmp_path: Path,
) -> None:
    export_world.role("admin")
    option_id = str(uuid7())
    values = [
        ("Number", "number", 1.5, {}),
        ("Integer", "int", 7, {}),
        ("Decimal", "decimal", "0.125", {}),
        ("Exact", "decimal", "1234567890123456.123456789", {}),
        ("Day", "date", "2026-10-08", {}),
        ("Timestamp", "datetime", "2026-10-08T16:30:00Z", {}),
        ("Flag", "boolean", True, {}),
        ("Status", "select", option_id, {"options": [{"id": option_id, "label": "=Confirmed"}]}),
        ("Person", "user", str(export_world.actor_id), {}),
        ("Note", "long_text", "first\n=second", {}),
        ("Email", "email", "person@example.test", {}),
        ("Website", "url", "https://example.test", {}),
        ("Roundtrip", "decimal", "1.2345678901234567", {}),
        ("Safe precision", "decimal", "1.23456789012345", {}),
    ]
    with Session(export_world.owner) as db:
        record = db.get(Record, export_world.record_ids[2])
        record.data = {**record.data, str(export_world.label_id): "=SUM(A1:A3)"}
        fields = []
        for index, (name, kind, value, config) in enumerate(values, start=2):
            field = Field(
                module_id=export_world.module_id,
                name=name,
                type=kind,
                position=index,
                config=config,
            )
            db.add(field)
            db.flush()
            record.data = {**record.data, str(field.id): value}
            fields.append({"field_id": str(field.id), "expected_type": kind})
        timezone = db.scalar(select(WorkspaceProfile.timezone))
        db.commit()
    payload = export_world.payload(format="xlsx", include_details=False)
    payload["definition"]["columns"] = [payload["definition"]["columns"][0], *fields]
    response = export_world.client.post("/api/records/export", json=payload)
    assert response.status_code == 200
    (tmp_path / "typed-workbook.xlsx").write_bytes(response.content)
    with ZipFile(io.BytesIO(response.content)) as archive:
        worksheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        styles = ElementTree.fromstring(archive.read("xl/styles.xml"))
        cells = {cell.attrib["r"]: cell for cell in worksheet.findall(".//s:c", NS)}

        def cell_text(address: str) -> str:
            return "".join(cells[address].itertext())

        assert cells["A2"].get("t") == "inlineStr" and cell_text("A2") == "=SUM(A1:A3)"
        assert [cell_text(address) for address in ("B2", "C2", "D2")] == ["1.5", "7", "0.125"]
        assert cells["E2"].get("t") == "inlineStr"
        assert cell_text("E2") == "1234567890123456.123456789"
        assert cells["N2"].get("t") == "inlineStr"
        assert cell_text("N2") == "1.2345678901234567"
        assert cells["O2"].get("t") in (None, "n")
        assert cell_text("O2") == "1.23456789012345"
        assert all(cells[address].get("t") in (None, "n") for address in ("B2", "C2", "D2"))
        assert datetime(1899, 12, 30) + timedelta(days=float(cell_text("F2"))) == datetime(
            2026, 10, 8
        )
        observed = datetime(1899, 12, 30) + timedelta(days=float(cell_text("G2")))
        expected = datetime(2026, 10, 8, 16, 30, tzinfo=UTC).astimezone(ZoneInfo(timezone))
        assert abs((observed - expected.replace(tzinfo=None)).total_seconds()) < 0.001
        assert cell_text("G1") == f"Timestamp ({timezone})"
        assert cells["H2"].get("t") == "b" and cell_text("H2") == "1"
        assert [cell_text(address) for address in ("I2", "J2", "K2", "L2", "M2")] == [
            "=Confirmed",
            "Export reader",
            "first\n=second",
            "person@example.test",
            "https://example.test",
        ]
        assert not worksheet.findall(".//s:f", NS)
        assert not worksheet.findall(".//s:hyperlink", NS)
        formats = styles.find("s:cellXfs", NS)
        assert formats[int(cells["C2"].get("s"))].get("numFmtId") == "1"  # Excel integer format 0.
        assert formats[int(cells["K2"].get("s"))].find("s:alignment", NS).get("wrapText") == "1"
        assert cells.get("B3") is None or cells["B3"].find("s:v", NS) is None


@pytest.mark.parametrize("format", ["csv", "xlsx"])
def test_export_rejects_data_row_overflow_without_partial_bytes(
    export_world: ExportWorld, monkeypatch: pytest.MonkeyPatch, format: str
) -> None:
    monkeypatch.setattr(exporter, "MAX_ROWS", 1)
    response = export_world.client.post(
        "/api/records/export", json=export_world.payload(format=format, include_details=False)
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "export_limit_exceeded"
    assert export_world.events() == []


def test_xlsx_byte_cap_includes_the_closed_archive(
    export_world: ExportWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        exporter, "utc_now", lambda: datetime(2026, 10, 8, tzinfo=UTC), raising=False
    )
    payload = export_world.payload(format="xlsx", totals=True)
    first = export_world.client.post("/api/records/export", json=payload)
    assert first.status_code == 200
    monkeypatch.setattr(exporter, "MAX_BYTES", len(first.content))
    exact = export_world.client.post("/api/records/export", json=payload)
    assert exact.status_code == 200
    monkeypatch.setattr(exporter, "MAX_BYTES", len(first.content) - 1)
    refused = export_world.client.post("/api/records/export", json=payload)
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "export_limit_exceeded"
    assert len(export_world.events()) == 2


@pytest.mark.parametrize("role", ["member", "guest"])
def test_module_reader_scope_is_required_for_export(export_world: ExportWorld, role: str) -> None:
    export_world.role(role)
    if role == "guest":
        readable = export_world.client.post("/api/records/export", json=export_world.payload())
        assert readable.status_code == 200
    with Session(export_world.owner) as db:
        db.get(GroupAccess, export_world.grant_id).is_deleted = True
        db.commit()
    denied = export_world.client.post("/api/records/export", json=export_world.payload())
    assert denied.status_code == 404
    assert b"Gamma" not in denied.content
    assert len(export_world.events()) == int(role == "guest")


@pytest.mark.parametrize("state", ["missing", "foreign", "deleted"])
def test_export_view_metadata_is_scoped_and_current(export_world: ExportWorld, state: str) -> None:
    from app.systems.sandbox.modules.models import Module

    view_id = export_world.view_id
    foreign_id = None
    with Session(export_world.owner) as db:
        view = db.get(SavedView, view_id)
        if state == "missing":
            view_id = uuid7()
        elif state == "foreign":
            foreign = Module(department_id=export_world.department_id, module_name="Private view")
            db.add(foreign)
            db.flush()
            foreign_id = foreign.id
            view.module_id = foreign_id
        else:
            view.is_deleted = True
        db.commit()
    try:
        response = export_world.client.post(
            "/api/records/export", json=export_world.payload(view_id=str(view_id))
        )
        assert response.status_code == 404
        assert (
            b"Reviewed records" not in response.content and b"Private view" not in response.content
        )
        assert export_world.events() == []
    finally:
        if foreign_id is not None:
            with Session(export_world.owner) as db:
                db.get(SavedView, export_world.view_id).module_id = export_world.module_id
                db.flush()
                db.delete(db.get(Module, foreign_id))
                db.commit()


@pytest.mark.parametrize("theme", ["slate", "whiteboard", "triplicate", "stockroom"])
def test_xlsx_theme_header_matches_the_light_css(export_world: ExportWorld, theme: str) -> None:
    css_root = Path(__file__).resolve().parents[3] / "frontend/src/app"
    css = css_root / ("globals.css" if theme == "slate" else f"themes/{theme}.css")
    action = re.search(r"--action:\s*(#[a-fA-F0-9]{6})", css.read_text())
    assert action is not None
    with Session(export_world.owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        original = profile.theme
        profile.theme = theme
        db.commit()
    try:
        response = export_world.client.post(
            "/api/records/export", json=export_world.payload(format="xlsx", include_details=False)
        )
        assert response.status_code == 200
        with ZipFile(io.BytesIO(response.content)) as archive:
            sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            styles = ElementTree.fromstring(archive.read("xl/styles.xml"))
            header = sheet.find(".//s:c[@r='A1']", NS)
            style = styles.find("s:cellXfs", NS)[int(header.get("s"))]
            fill = styles.find("s:fills", NS)[int(style.get("fillId"))]
            font = styles.find("s:fonts", NS)[int(style.get("fontId"))]
            assert fill.find("s:patternFill/s:fgColor", NS).get("rgb") == (
                "FF" + action.group(1)[1:].upper()
            )
            assert font.find("s:color", NS).get("rgb") == "FFFFFFFF"
    finally:
        with Session(export_world.owner) as db:
            db.scalar(select(WorkspaceProfile)).theme = original
            db.commit()


@pytest.mark.parametrize(
    "options",
    [
        {"format": "pdf"},
        {"title": "x" * 121},
        {"include_record_id": "yes"},
        {"accent": "red"},
        {"totals": 1},
        {"export_all": True},
    ],
)
def test_export_rejects_invalid_options(
    export_world: ExportWorld, options: dict[str, object]
) -> None:
    response = export_world.client.post("/api/records/export", json=export_world.payload(**options))
    assert response.status_code == 422
    assert export_world.events() == []
