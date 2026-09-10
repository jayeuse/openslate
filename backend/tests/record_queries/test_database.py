"""SQL behavior tests; run only on the guarded disposable full-stack database."""

import os
import re
from urllib.parse import urlsplit

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.departments.models import Department
from app.systems.fields.models import Field
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.records.query import query_records
from app.systems.records.query_schemas import RecordQuery

pytestmark = pytest.mark.integration


@pytest.fixture
def query_db(request):
    value = os.getenv("TEST_DATABASE_URL")
    if not value:
        pytest.skip("Disposable PostgreSQL not configured")
    target = urlsplit(value)
    if not (
        os.getenv("E2E_ALLOW_MUTATIONS") == "true"
        and re.fullmatch(r"[a-f0-9]{32}", os.getenv("OPENSLATE_FULLSTACK_RUN_ID", ""))
        and target.hostname == "127.0.0.1"
        and target.port == 55322
        and target.path == "/postgres"
        and target.username
        and target.password
    ):
        raise RuntimeError("Query tests require explicitly authorized disposable full-stack DB")
    return request.getfixturevalue("integration_owner_db")


def setup_rows(db: Session, kind: str, values: list[object]):
    department = Department(department_name=f"query-{uuid7()}")
    db.add(department)
    db.flush()
    module = Module(department_id=department.id, module_name="Records")
    db.add(module)
    db.flush()
    field = Field(
        module_id=module.id,
        name="Value",
        type=kind,
        position=0,
        required=False,
        config={"options": ["a", "b"]} if kind == "select" else {},
    )
    db.add(field)
    db.flush()
    rows = [
        Record(module_id=module.id, data={} if value is ... else {str(field.id): value})
        for value in values
    ]
    db.add_all(rows)
    db.flush()
    return module, field, rows


def request_for(module, field, **definition):
    reference = {"field_id": field.id, "expected_type": field.type}
    return RecordQuery(module_id=module.id, definition={"columns": [reference], **definition})


@pytest.mark.parametrize(
    ("kind", "values", "threshold", "expected"),
    [
        ("decimal", ["2", "10", "9007199254740993.123456789012345678", None], "2", [1, 2]),
        ("int", [2, 10, 11, None], 2, [1, 2]),
        ("number", [2.5, 10.5, 11, None], 2.5, [1, 2]),
        ("date", ["2026-09-08", "2026-09-09", "2026-09-10", None], "2026-09-08", [1, 2]),
        (
            "datetime",
            ["2026-09-09T08:00:00+08:00", "2026-09-09T01:00:00Z", None],
            "2026-09-09T00:00:00Z",
            [1],
        ),
    ],
)
def test_typed_filter_and_sort(query_db, kind, values, threshold, expected):
    module, field, rows = setup_rows(query_db, kind, values)
    reference = {"field_id": field.id, "expected_type": kind}
    payload = request_for(
        module,
        field,
        filters=[{**reference, "operator": "gt", "value": threshold}],
        sort=[{**reference, "direction": "asc"}],
    )
    result = query_records(query_db, payload)
    assert [item.id for item in result.items] == [rows[index].id for index in expected]


def test_empty_missing_null_and_string_are_distinct(query_db):
    module, field, rows = setup_rows(query_db, "text", [..., None, "", "x"])
    reference = {"field_id": field.id, "expected_type": "text"}
    empty = request_for(module, field, filters=[{**reference, "operator": "empty"}])
    assert {item.id for item in query_records(query_db, empty).items} == {rows[0].id, rows[1].id}
    nonempty = request_for(module, field, filters=[{**reference, "operator": "not_empty"}])
    assert {item.id for item in query_records(query_db, nonempty).items} == {rows[2].id, rows[3].id}


def test_contains_is_literal_case_insensitive_and_uuid_search_is_server_side(query_db):
    module, field, rows = setup_rows(query_db, "text", ["A%_\\z", "anything"])
    reference = {"field_id": field.id, "expected_type": "text"}
    payload = request_for(
        module, field, filters=[{**reference, "operator": "contains", "value": "%_"}]
    )
    assert [item.id for item in query_records(query_db, payload).items] == [rows[0].id]
    payload = request_for(module, field, search=str(rows[1].id))
    assert [item.id for item in query_records(query_db, payload).items] == [rows[1].id]
    assert not query_records(query_db, request_for(module, field, search="%")).items


def test_pagination_ties_nulls_last_and_projection(query_db):
    module, field, rows = setup_rows(query_db, "int", [1] * 101 + [None])
    reference = {"field_id": field.id, "expected_type": "int"}
    payload = request_for(module, field, sort=[reference])
    payload.offset = 100
    payload.limit = 1
    result = query_records(query_db, payload)
    assert result.pagination.total == 102 and result.pagination.has_more
    assert result.items[0].id == sorted(row.id for row in rows[:101])[100]
    payload.offset = 101
    assert query_records(query_db, payload).items[0].id == rows[-1].id
    payload.definition.columns = []
    assert query_records(query_db, payload).items[0].data == {}


def test_archived_field_renames_work_and_changed_type_fails(query_db):
    module, field, _ = setup_rows(query_db, "text", ["kept"])
    payload = request_for(module, field)
    field.is_deleted = True
    field.name = "Renamed"
    query_db.flush()
    assert query_records(query_db, payload).items[0].data == {str(field.id): "kept"}
    field.type = "boolean"
    query_db.flush()
    with pytest.raises(HTTPException) as error:
        query_records(query_db, payload)
    assert error.value.status_code == 409


def test_cross_module_reference_fails_without_broadening(query_db):
    module, field, _ = setup_rows(query_db, "text", ["secret"])
    other, _, _ = setup_rows(query_db, "text", ["other"])
    with pytest.raises(HTTPException) as error:
        query_records(query_db, request_for(other, field))
    assert error.value.status_code == 409


@pytest.mark.parametrize(
    ("kind", "values", "operator", "value", "expected"),
    [
        ("text", ["Abc", "bcd", "abc"], "prefix", "a", [0, 2]),
        ("text", ["Abc", "bcd", "abc"], "eq", "abc", [2]),
        ("select", ["a", "b", None], "in", ["b"], [1]),
        ("boolean", [True, False, None], "eq", False, [1]),
        ("int", [1, 2, 3], "lt", 2, [0]),
        ("int", [1, 2, 3], "lte", 2, [0, 1]),
        ("int", [1, 2, 3], "gte", 2, [1, 2]),
    ],
)
def test_allowed_predicates_execute_in_postgres(query_db, kind, values, operator, value, expected):
    module, field, rows = setup_rows(query_db, kind, values)
    payload = request_for(
        module,
        field,
        filters=[
            {"field_id": field.id, "expected_type": kind, "operator": operator, "value": value}
        ],
    )
    assert [item.id for item in query_records(query_db, payload).items] == [
        rows[i].id for i in expected
    ]
