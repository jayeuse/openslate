import csv
import io
from datetime import date, datetime
from decimal import Decimal

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.fields.models import Field, FieldType
from app.systems.records.export import encode_csv, format_cell
from app.systems.records.models import Record
from app.systems.records.query import comparison_value
from app.systems.records.query_schemas import FieldReference, QueryDefinition, QueryFilter


def field(kind: FieldType, **kwargs: object) -> Field:
    return Field(id=uuid7(), type=kind, config={}, name="Value", **kwargs)


@pytest.mark.parametrize(
    ("kind", "value", "expected"),
    [
        (
            FieldType.DECIMAL,
            "9007199254740993.123456789012345678",
            Decimal("9007199254740993.123456789012345678"),
        ),
        (FieldType.INTEGER, 10, Decimal(10)),
        (FieldType.NUMBER, 1.5, Decimal("1.5")),
        (FieldType.DATE, "2026-09-09", date(2026, 9, 9)),
        (
            FieldType.DATETIME,
            "2026-09-09T12:00:00+08:00",
            datetime.fromisoformat("2026-09-09T12:00:00+08:00"),
        ),
    ],
)
def test_comparison_preserves_types_and_precision(kind, value, expected):
    item = field(kind)
    predicate = QueryFilter(field_id=item.id, expected_type=kind, operator="eq", value=value)
    assert comparison_value(item, predicate) == expected


@pytest.mark.parametrize(
    ("kind", "value"),
    [
        (FieldType.INTEGER, True),
        (FieldType.DATETIME, "2026-09-09T12:00:00"),
        (FieldType.DECIMAL, 1.5),
        (FieldType.DATE, "2026-02-30"),
    ],
)
def test_comparison_rejects_wrong_literal_type(kind, value):
    item = field(kind)
    with pytest.raises(HTTPException) as error:
        comparison_value(
            item, QueryFilter(field_id=item.id, expected_type=kind, operator="eq", value=value)
        )
    assert error.value.status_code == 422


def test_removed_select_option_requires_explicit_repair():
    item = field(FieldType.SELECT)
    item.config = {"options": ["new"]}
    with pytest.raises(HTTPException) as error:
        comparison_value(
            item,
            QueryFilter(field_id=item.id, expected_type="select", operator="in", value=["old"]),
        )
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "view_invalid"


def test_query_bounds_and_operator_allowlist():
    reference = {"field_id": uuid7(), "expected_type": "text"}
    predicate = {**reference, "operator": "eq", "value": "test"}
    with pytest.raises(ValidationError):
        QueryDefinition(filters=[predicate] * 11)
    with pytest.raises(ValidationError):
        QueryFilter(**reference, operator="gt", value="test")
    with pytest.raises(ValidationError):
        FieldReference(field_id=uuid7(), expected_type="relationship")
    with pytest.raises(ValidationError):
        QueryDefinition(columns=[reference, reference])


def test_csv_escapes_formulas_quotes_and_preserves_decimal():
    text = field(FieldType.TEXT)
    number = field(FieldType.DECIMAL)
    row = Record(
        id=uuid7(),
        data={str(text.id): '=HYPERLINK("x")\n,', str(number.id): "-123456789.000000000000001"},
    )
    content, count = encode_csv([row], [text, number], "UTC", "en-US")
    parsed = list(csv.reader(io.StringIO(content.decode())))
    assert count == 1
    assert parsed[1] == [str(row.id), '\'=HYPERLINK("x")\n,', "-123456789.000000000000001"]


def test_csv_rejects_row_10001_without_returning_partial_file():
    row = Record(id=uuid7(), data={})
    assert encode_csv((row for _ in range(10_000)), [], "UTC", "en-US")[1] == 10_000
    with pytest.raises(HTTPException) as error:
        encode_csv((row for _ in range(10_001)), [], "UTC", "en-US")
    assert error.value.detail["code"] == "export_limit_exceeded"


def test_csv_rejects_encoded_byte_overflow():
    item = field(FieldType.TEXT)
    row = Record(id=uuid7(), data={str(item.id): "é" * (4 * 1024 * 1024)})
    with pytest.raises(HTTPException) as error:
        encode_csv([row], [item], "UTC", "en-US")
    assert error.value.detail["code"] == "export_limit_exceeded"


def test_export_regional_date_preserves_calendar_day_and_instant_offset():
    date_field = field(FieldType.DATE)
    instant_field = field(FieldType.DATETIME)
    assert "Sep 9" in format_cell("2026-09-09", date_field, "America/Los_Angeles", "en-US")
    rendered = format_cell("2026-09-09T00:00:00Z", instant_field, "America/Los_Angeles", "en-US")
    assert "Sep 8" in rendered
    assert rendered.endswith("UTC-07:00")


def test_csv_exact_byte_limit_includes_header_and_utf8():
    from app.systems.records.export import MAX_BYTES

    item = field(FieldType.TEXT)
    row = Record(id=uuid7(), data={str(item.id): "x"})
    baseline, _ = encode_csv([row], [item], "UTC", "en-US")
    row.data = {str(item.id): "x" * (MAX_BYTES - len(baseline) + 1)}
    exact, _ = encode_csv([row], [item], "UTC", "en-US")
    assert len(exact) == MAX_BYTES
    row.data = {str(item.id): row.data[str(item.id)] + "é"}
    with pytest.raises(HTTPException) as error:
        encode_csv([row], [item], "UTC", "en-US")
    assert error.value.detail["code"] == "export_limit_exceeded"


def test_export_event_failure_rolls_back_and_fails_closed(monkeypatch):
    from sqlalchemy.exc import OperationalError

    from app.systems.records.export import commit_export_event

    class UnavailableSession:
        rolled_back = False

        def add(self, event):
            pass

        def commit(self):
            raise OperationalError("failure", {}, None)

        def rollback(self):
            self.rolled_back = True

    session = UnavailableSession()
    with pytest.raises(HTTPException) as error:
        commit_export_event(session, uuid7(), uuid7(), 1)
    assert error.value.status_code == 503
    assert session.rolled_back
