"""CSV cell conversion and the import and batch request shapes, without PostgreSQL.

The route tests keep one request per shape for the 422 status and the absence of writes:
``test_record_import_integration.py``, ``test_record_batch_integration.py`` and
``test_record_batch_atomic_integration.py``.
"""

from typing import Any

import pytest
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.import_router import RecordImportRequest
from app.systems.sandbox.records.importing import _converted_cell
from app.systems.sandbox.records.schemas import RecordBatchUpdate

_OPTION = "0190f2c4-0000-7000-8000-000000000001"
_USER = "0190F2C4-0000-7000-8000-0000000000AB"


def _field(kind: FieldType, config: dict[str, Any] | None = None) -> Field:
    return Field(
        id=uuid7(), module_id=uuid7(), name=kind.value, type=kind, position=0, config=config or {}
    )


_SELECT = {"options": [{"id": _OPTION, "label": "Open"}]}


@pytest.mark.parametrize(
    ("kind", "config", "cell", "expected"),
    [
        (FieldType.TEXT, None, "' =formula", "' =formula"),
        (FieldType.TEXT, None, "", ""),
        (FieldType.LONG_TEXT, None, "  long\ntext  ", "  long\ntext  "),
        (FieldType.EMAIL, None, "name@example.test", "name@example.test"),
        (FieldType.URL, None, "https://example.test/path", "https://example.test/path"),
        (FieldType.INTEGER, None, "-21", -21),
        (FieldType.INTEGER, None, "", None),
        (FieldType.USER, None, _USER, _USER.lower()),
        (FieldType.USER, None, "", None),
        (FieldType.BOOLEAN, None, " FaLsE ", False),
        (FieldType.BOOLEAN, None, "true", True),
        (FieldType.NUMBER, None, "1e2", 100.0),
        (FieldType.NUMBER, None, "", None),
        (FieldType.DECIMAL, None, "1.2300", "1.2300"),
        (FieldType.DATE, None, "2026-10-03", "2026-10-03"),
        (FieldType.DATETIME, None, "2026-10-03T12:30:00+08:00", "2026-10-03T12:30:00+08:00"),
        (FieldType.SELECT, _SELECT, "Open", _OPTION),
        (FieldType.SELECT, _SELECT, _OPTION, _OPTION),
        (FieldType.SELECT, _SELECT, "", None),
    ],
)
def test_import_cells_convert_to_the_field_type(kind, config, cell, expected) -> None:
    converted = _converted_cell(_field(kind, config), cell)

    assert converted == expected and type(converted) is type(expected)


@pytest.mark.parametrize(
    ("kind", "config", "cell", "message"),
    [
        (FieldType.INTEGER, None, "2.1", "Integer must be a whole base-10 number"),
        (FieldType.USER, None, "Alex Reader", "User must be a UUID"),
        (FieldType.BOOLEAN, None, "yes", "Boolean must be true or false"),
        (FieldType.NUMBER, None, "NaN", "Number must be finite"),
        (FieldType.NUMBER, None, "Infinity", "Number must be finite"),
        (FieldType.SELECT, _SELECT, "Unknown", "Select must match an option ID or label"),
        (
            FieldType.SELECT,
            {"options": [{"id": "a", "label": "Open"}, {"id": "b", "label": "Open"}]},
            "Open",
            "Select label is ambiguous",
        ),
    ],
)
def test_malformed_import_cells_are_refused_with_their_reason(kind, config, cell, message) -> None:
    with pytest.raises(ValueError, match=message):
        _converted_cell(_field(kind, config), cell)


def _import_payload() -> dict[str, Any]:
    title, quantity, owner, default = (str(uuid7()) for _ in range(4))
    return {
        "mode": "preview",
        "module_id": str(uuid7()),
        "headers": ["Title", "Quantity", "Owner"],
        "mapping": [
            {"column_index": index, "field_id": field_id}
            for index, field_id in enumerate((title, quantity, owner))
        ],
        "rows": [
            {"row_number": 2, "cells": ["  retained title  ", "12", str(uuid7())]},
            {"row_number": 8, "cells": ["invalid", "1.5", str(uuid7())]},
            {"row_number": 3, "cells": ["", "2", ""]},
        ],
        "defaults": {default: "request default"},
    }


def test_a_well_formed_import_preview_is_accepted() -> None:
    request = RecordImportRequest.model_validate(_import_payload())

    assert [row.row_number for row in request.rows] == [2, 8, 3]


@pytest.mark.parametrize(
    "defect",
    [
        "empty",
        "duplicate_column",
        "duplicate_field",
        "range",
        "cells",
        "row_number",
        "duplicate_row",
        "limit",
        "extra",
        "digest",
        "default_overlap",
    ],
)
def test_import_rejects_an_invalid_batch_shape(defect: str) -> None:
    payload = _import_payload()
    if defect == "empty":
        payload["mapping"] = []
    elif defect == "duplicate_column":
        payload["mapping"][1]["column_index"] = 0
    elif defect == "duplicate_field":
        payload["mapping"][1]["field_id"] = payload["mapping"][0]["field_id"]
    elif defect == "range":
        payload["mapping"][0]["column_index"] = 3
    elif defect == "cells":
        payload["rows"][0]["cells"].pop()
    elif defect == "row_number":
        payload["rows"][0]["row_number"] = 1
    elif defect == "duplicate_row":
        payload["rows"][1]["row_number"] = 2
    elif defect == "limit":
        payload["rows"] = [{"row_number": i + 2, "cells": ["valid", "1", ""]} for i in range(101)]
    elif defect == "extra":
        payload["owner_id"] = str(uuid7())
    elif defect == "digest":
        payload["mode"] = "import"
    else:
        payload["defaults"][payload["mapping"][0]["field_id"]] = "overlap"

    with pytest.raises(ValidationError):
        RecordImportRequest.model_validate(payload)


_REVISION = "2026-10-03T12:00:00.123456Z"


def _single() -> dict[str, Any]:
    return {
        "record_id": str(uuid7()),
        "revision": _REVISION,
        "field_id": str(uuid7()),
        "value": "Refused",
    }


def _compound(*field_ids: str) -> dict[str, Any]:
    return {
        "record_id": str(uuid7()),
        "revision": _REVISION,
        "changes": [{"field_id": field_id, "value": "Refused"} for field_id in field_ids],
    }


def test_single_and_compound_batch_items_are_accepted_together() -> None:
    batch = RecordBatchUpdate.model_validate(
        {"module_id": str(uuid7()), "items": [_single(), _compound(str(uuid7()), str(uuid7()))]}
    )

    assert len(batch.items) == 2


@pytest.mark.parametrize("invalid_input", ["too_many", "extra_field", "invalid_revision"])
def test_single_change_batch_envelope_is_refused(invalid_input: str) -> None:
    change = _single()
    changes = [change]
    if invalid_input == "too_many":
        changes *= 101
    elif invalid_input == "extra_field":
        change["data"] = {change["field_id"]: "Refused"}
    else:
        change["revision"] = 1

    with pytest.raises(ValidationError):
        RecordBatchUpdate.model_validate({"module_id": str(uuid7()), "items": changes})


@pytest.mark.parametrize(
    "bad_envelope",
    [
        "empty",
        "too_many",
        "duplicate",
        "mixed",
        "missing_value",
        "missing_field",
        "extra_change",
        "extra_item",
        "numeric_revision",
        "naive_revision",
        "date_revision",
    ],
)
def test_compound_batch_envelope_is_refused_beside_a_valid_item(bad_envelope: str) -> None:
    title = str(uuid7())
    change = _compound(title)
    if bad_envelope == "empty":
        change["changes"] = []
    elif bad_envelope == "too_many":
        change["changes"] += [{"field_id": str(uuid7()), "value": None} for _ in range(2)]
    elif bad_envelope == "duplicate":
        change["changes"].append({"field_id": title.upper(), "value": "Duplicate"})
    elif bad_envelope == "mixed":
        change.update(field_id=title, value="Mixed")
    elif bad_envelope in {"missing_value", "missing_field"}:
        change["changes"][0].pop("value" if bad_envelope == "missing_value" else "field_id")
    elif bad_envelope == "extra_change":
        change["changes"][0]["data"] = {}
    elif bad_envelope == "extra_item":
        change["data"] = {}
    else:
        change["revision"] = {
            "numeric_revision": 1,
            "naive_revision": "2026-10-03T00:00:00",
            "date_revision": "2026-10-03",
        }[bad_envelope]

    with pytest.raises(ValidationError):
        RecordBatchUpdate.model_validate({"module_id": str(uuid7()), "items": [_single(), change]})
