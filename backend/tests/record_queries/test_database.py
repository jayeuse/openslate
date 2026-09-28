"""SQL behavior tests; run only on the guarded disposable full-stack database."""

import os
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query import query_records
from app.systems.sandbox.records.query_schemas import RecordQuery
from tests.conftest import _guard_integration_database

pytestmark = pytest.mark.integration


@pytest.fixture
def query_db(request):
    value = os.getenv("TEST_DATABASE_URL")
    if not value:
        pytest.skip("Disposable PostgreSQL not configured")
    try:
        _guard_integration_database(value)
    except RuntimeError:
        raise RuntimeError(
            "Query tests require explicitly authorized disposable full-stack DB"
        ) from None
    return request.getfixturevalue("integration_owner_db")


# An administrator reads every module, so direct query calls need no group.
READER = User(id=uuid7(), status="active", role="admin", is_deleted=False)


def _option_id(label: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"record-query:{label}"))


def route_actor(db: Session, *, records_read: bool = True) -> User:
    """Give HTTP query tests a persisted actor for Access policy evaluation."""

    actor_id = uuid7()
    if records_read:
        role = "admin"
        assert role is not None
    else:
        role = "member"
        db.flush()
    actor = User(
        id=actor_id,
        email=f"query-{actor_id.hex}@example.test",
        username=f"query_{actor_id.hex[:16]}",
        status="active",
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


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
        config=(
            {
                "options": [
                    {"id": _option_id(value), "label": value}
                    for value in dict.fromkeys(value for value in values if isinstance(value, str))
                ]
            }
            if kind == "select"
            else {}
        ),
    )
    db.add(field)
    db.flush()
    rows = [
        Record(
            module_id=module.id,
            data=(
                {}
                if value is ...
                else {
                    str(field.id): (
                        _option_id(value) if kind == "select" and isinstance(value, str) else value
                    )
                }
            ),
        )
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
    result = query_records(query_db, payload, reader=READER)
    assert [item.id for item in result.items] == [rows[index].id for index in expected]


def test_decimal_equality_preserves_exact_filter_text(query_db) -> None:
    module, field, rows = setup_rows(
        query_db,
        "decimal",
        ["1.25", "9007199254740992", "9007199254740993", None],
    )
    reference = {"field_id": field.id, "expected_type": "decimal"}
    for value, expected in (("1.25", rows[0]), ("9007199254740993", rows[2])):
        request = request_for(
            module,
            field,
            filters=[{**reference, "operator": "eq", "value": value}],
        )
        result = query_records(query_db, request, reader=READER)
        assert [item.id for item in result.items] == [expected.id]


def test_local_datetime_filter_and_sort_are_independent_of_session_timezone(query_db) -> None:
    module, field, rows = setup_rows(
        query_db,
        "datetime",
        [
            "2026-09-09T12:00",
            "2026-09-09T13:00:00+01:00",
            "2026-09-09T13:00:00Z",
        ],
    )
    query_db.connection().exec_driver_sql("SET LOCAL TIME ZONE 'Asia/Manila'")
    reference = {"field_id": field.id, "expected_type": "datetime"}

    equal = request_for(
        module,
        field,
        filters=[{**reference, "operator": "eq", "value": "2026-09-09T12:00"}],
    )
    assert {item.id for item in query_records(query_db, equal, reader=READER).items} == {
        rows[0].id,
        rows[1].id,
    }

    ordered = request_for(module, field, sort=[{**reference, "direction": "asc"}])
    result = query_records(query_db, ordered, reader=READER)
    assert [item.id for item in result.items] == [
        *sorted((rows[0].id, rows[1].id)),
        rows[2].id,
    ]


def test_empty_missing_null_and_string_are_distinct(query_db):
    module, field, rows = setup_rows(query_db, "text", [..., None, "", "x"])
    reference = {"field_id": field.id, "expected_type": "text"}
    empty = request_for(module, field, filters=[{**reference, "operator": "empty"}])
    assert {item.id for item in query_records(query_db, empty, reader=READER).items} == {
        rows[0].id,
        rows[1].id,
    }
    nonempty = request_for(module, field, filters=[{**reference, "operator": "not_empty"}])
    assert {item.id for item in query_records(query_db, nonempty, reader=READER).items} == {
        rows[2].id,
        rows[3].id,
    }


def test_blank_not_blank_suffix_and_neq_preserve_legacy_empty_semantics(query_db):
    module, field, rows = setup_rows(
        query_db, "text", [..., None, "", "  ", "AlphaSuffix", "match"]
    )
    reference = {"field_id": field.id, "expected_type": "text"}

    empty = request_for(module, field, filters=[{**reference, "operator": "empty"}])
    assert {item.id for item in query_records(query_db, empty, reader=READER).items} == {
        rows[0].id,
        rows[1].id,
    }

    blank = request_for(module, field, filters=[{**reference, "operator": "blank"}])
    assert {item.id for item in query_records(query_db, blank, reader=READER).items} == {
        rows[0].id,
        rows[1].id,
        rows[2].id,
        rows[3].id,
    }

    not_blank = request_for(module, field, filters=[{**reference, "operator": "not_blank"}])
    assert {item.id for item in query_records(query_db, not_blank, reader=READER).items} == {
        rows[4].id,
        rows[5].id,
    }

    suffix = request_for(
        module, field, filters=[{**reference, "operator": "suffix", "value": "suffix"}]
    )
    assert [item.id for item in query_records(query_db, suffix, reader=READER).items] == [
        rows[4].id
    ]

    neq = request_for(module, field, filters=[{**reference, "operator": "neq", "value": "match"}])
    assert {item.id for item in query_records(query_db, neq, reader=READER).items} == {
        rows[2].id,
        rows[3].id,
        rows[4].id,
    }


def test_select_contains_and_or_logic_and_allowlisted_search(query_db):
    module, select_field, rows = setup_rows(query_db, "select", ["Pending", "Completed", "Blocked"])
    select_field.config = {
        "options": [*select_field.config["options"], {"id": _option_id("end"), "label": "end"}]
    }
    text_field = Field(
        module_id=module.id,
        name="Summary",
        type="text",
        position=1,
        required=False,
        config={},
    )
    query_db.add(text_field)
    query_db.flush()
    rows[0].data[str(text_field.id)] = "Build dashboard"
    rows[1].data[str(text_field.id)] = "Review report"
    rows[2].data[str(text_field.id)] = "Build report"
    query_db.flush()
    select_reference = {"field_id": select_field.id, "expected_type": "select"}
    text_reference = {"field_id": text_field.id, "expected_type": "text"}

    contains = request_for(
        module,
        select_field,
        filters=[{**select_reference, "operator": "contains", "value": _option_id("end")}],
    )
    assert [item.id for item in query_records(query_db, contains, reader=READER).items] == [
        rows[0].id
    ]

    either = request_for(
        module,
        select_field,
        logic="or",
        filters=[
            {**select_reference, "operator": "eq", "value": _option_id("Pending")},
            {**text_reference, "operator": "contains", "value": "report"},
        ],
    )
    assert {item.id for item in query_records(query_db, either, reader=READER).items} == {
        rows[0].id,
        rows[1].id,
        rows[2].id,
    }

    search = request_for(
        module,
        select_field,
        search="dashboard",
        search_fields=[text_reference],
    )
    assert [item.id for item in query_records(query_db, search, reader=READER).items] == [
        rows[0].id
    ]
    assert not query_records(
        query_db, request_for(module, select_field, search="dashboard"), reader=READER
    ).items
    select_search = request_for(
        module, select_field, search="pend", search_fields=[select_reference]
    )
    assert [item.id for item in query_records(query_db, select_search, reader=READER).items] == [
        rows[0].id
    ]
    raw_id_search = request_for(
        module, select_field, search=_option_id("Pending"), search_fields=[select_reference]
    )
    assert not query_records(query_db, raw_id_search, reader=READER).items
    assert [
        item.id
        for item in query_records(
            query_db, request_for(module, select_field, search=str(rows[2].id)), reader=READER
        ).items
    ] == [rows[2].id]


def test_search_fields_must_be_active_and_searchable(query_db):
    module, field, _ = setup_rows(query_db, "text", ["searchable"])
    reference = {"field_id": field.id, "expected_type": "text"}
    field.is_deleted = True
    query_db.flush()

    with pytest.raises(HTTPException) as error:
        query_records(
            query_db,
            request_for(module, field, search="searchable", search_fields=[reference]),
            reader=READER,
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "view_invalid"


def test_contains_is_literal_case_insensitive_and_uuid_search_is_server_side(query_db):
    module, field, rows = setup_rows(query_db, "text", ["A%_\\z", "anything"])
    reference = {"field_id": field.id, "expected_type": "text"}
    payload = request_for(
        module, field, filters=[{**reference, "operator": "contains", "value": "%_"}]
    )
    assert [item.id for item in query_records(query_db, payload, reader=READER).items] == [
        rows[0].id
    ]
    payload = request_for(module, field, search=str(rows[1].id))
    assert [item.id for item in query_records(query_db, payload, reader=READER).items] == [
        rows[1].id
    ]
    assert not query_records(query_db, request_for(module, field, search="%"), reader=READER).items


def test_pagination_ties_nulls_last_and_projection(query_db):
    module, field, rows = setup_rows(query_db, "int", [1] * 101 + [None])
    reference = {"field_id": field.id, "expected_type": "int"}
    payload = request_for(module, field, sort=[reference])
    payload.offset = 100
    payload.limit = 1
    result = query_records(query_db, payload, reader=READER)
    assert result.pagination.total == 102 and result.pagination.has_more
    assert result.items[0].id == sorted(row.id for row in rows[:101])[100]
    payload.offset = 101
    assert query_records(query_db, payload, reader=READER).items[0].id == rows[-1].id
    payload.definition.columns = []
    assert query_records(query_db, payload, reader=READER).items[0].data == {}


def test_projection_preserves_record_metadata_json_values_and_unselected_sort_fields(
    query_db: Session,
) -> None:
    module, selected_field, _ = setup_rows(query_db, "text", [])
    filter_field = Field(
        module_id=module.id,
        name="Filter value",
        type="text",
        position=1,
        required=False,
        config={},
    )
    sort_field = Field(
        module_id=module.id,
        name="Sort value",
        type="text",
        position=2,
        required=False,
        config={},
    )
    hidden_field = Field(
        module_id=module.id,
        name="Unselected value",
        type="text",
        position=3,
        required=False,
        config={},
    )
    query_db.add_all([filter_field, sort_field, hidden_field])
    query_db.flush()

    selected_key = str(selected_field.id)
    filter_key = str(filter_field.id)
    sort_key = str(sort_field.id)
    hidden_key = str(hidden_field.id)
    explicit_null = Record(
        module_id=module.id,
        data={
            selected_key: None,
            filter_key: "include",
            sort_key: "b",
            hidden_key: "private",
        },
        performed_by=None,
    )
    missing_key = Record(
        module_id=module.id,
        data={filter_key: "include", sort_key: "a", hidden_key: "private"},
        is_deleted=True,
        deleted_at=datetime(2026, 1, 2, tzinfo=UTC),
    )
    nested_value = {"items": [1, {"value": None}]}
    nested_record = Record(
        module_id=module.id,
        data={
            selected_key: nested_value,
            filter_key: "include",
            sort_key: "c",
            hidden_key: "private",
        },
    )
    excluded = Record(
        module_id=module.id,
        data={selected_key: "excluded", filter_key: "exclude", sort_key: "0"},
    )
    query_db.add_all([explicit_null, missing_key, nested_record, excluded])
    query_db.flush()
    original_data = dict(explicit_null.data)

    payload = request_for(
        module,
        selected_field,
        filters=[
            {
                "field_id": filter_field.id,
                "expected_type": filter_field.type,
                "operator": "eq",
                "value": "include",
            }
        ],
        sort=[
            {
                "field_id": sort_field.id,
                "expected_type": sort_field.type,
                "direction": "asc",
            }
        ],
        deleted="include",
    )

    result = query_records(query_db, payload, reader=READER)

    assert [item.id for item in result.items] == [
        missing_key.id,
        explicit_null.id,
        nested_record.id,
    ]
    by_id = {item.id: item for item in result.items}
    assert by_id[missing_key.id].data == {}
    assert by_id[explicit_null.id].data == {selected_key: None}
    assert by_id[nested_record.id].data == {selected_key: nested_value}
    assert hidden_key not in by_id[explicit_null.id].data
    assert result.pagination.total == 3

    response = by_id[missing_key.id]
    assert response.module_id == missing_key.module_id
    assert response.created_at == missing_key.created_at
    assert response.updated_at == missing_key.updated_at
    assert response.deleted_at == missing_key.deleted_at
    assert response.is_deleted is True
    assert response.performed_by == missing_key.performed_by
    assert query_db.get(Record, explicit_null.id) is explicit_null
    assert explicit_null.data == original_data


def test_archived_field_renames_work_and_changed_type_fails(query_db):
    module, field, _ = setup_rows(query_db, "text", ["kept"])
    payload = request_for(module, field)
    field.is_deleted = True
    field.name = "Renamed"
    query_db.flush()
    assert query_records(query_db, payload, reader=READER).items[0].data == {str(field.id): "kept"}
    field.type = "boolean"
    query_db.flush()
    with pytest.raises(HTTPException) as error:
        query_records(query_db, payload, reader=READER)
    assert error.value.status_code == 409


def test_cross_module_reference_fails_without_broadening(query_db):
    module, field, _ = setup_rows(query_db, "text", ["secret"])
    other, _, _ = setup_rows(query_db, "text", ["other"])
    with pytest.raises(HTTPException) as error:
        query_records(query_db, request_for(other, field), reader=READER)
    assert error.value.status_code == 409


@pytest.mark.parametrize(("value", "total"), [("a", 1), ("missing", 0)])
def test_filtered_empty_page_preserves_exact_total(query_db, value, total):
    module, field, _ = setup_rows(query_db, "text", ["a", "b"])
    payload = request_for(
        module,
        field,
        filters=[{"field_id": field.id, "expected_type": "text", "operator": "eq", "value": value}],
    ).model_copy(update={"offset": 25})
    result = query_records(query_db, payload, reader=READER)
    assert result.items == []
    assert result.pagination.total == total
    assert result.pagination.count == 0
    assert result.pagination.has_more is False


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
    if kind == "select" and isinstance(value, list):
        value = [_option_id(item) for item in value]
    payload = request_for(
        module,
        field,
        filters=[
            {"field_id": field.id, "expected_type": kind, "operator": operator, "value": value}
        ],
    )
    assert [item.id for item in query_records(query_db, payload, reader=READER).items] == [
        rows[i].id for i in expected
    ]
