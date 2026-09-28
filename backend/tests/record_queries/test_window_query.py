"""Windowed OpenView record query contracts and PostgreSQL behavior."""

import os
from datetime import UTC, date, datetime
from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from record_queries.test_database import READER, route_actor, setup_rows
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.main import app
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records.query_schemas import WindowRecordQuery
from app.systems.sandbox.records.windowing import query_window_records
from tests.conftest import _guard_integration_database


@pytest.fixture
def window_db(request) -> Session:
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Disposable PostgreSQL not configured")
    try:
        _guard_integration_database(database_url)
    except RuntimeError:
        raise RuntimeError("Window query tests require the guarded runner database") from None
    return request.getfixturevalue("integration_owner_db")


def reference(field: Field) -> dict[str, object]:
    return {"field_id": field.id, "expected_type": field.type}


def add_values(
    db: Session,
    module,
    rows,
    name: str,
    kind: str,
    values: list[object],
    *,
    position: int = 1,
) -> Field:
    field = Field(
        module_id=module.id,
        name=name,
        type=kind,
        position=position,
        required=False,
        config={},
    )
    db.add(field)
    db.flush()
    for row, value in zip(rows, values, strict=True):
        if value is not ...:
            row.data = {**row.data, str(field.id): value}
    db.flush()
    return field


def set_workspace_timezone(db: Session, timezone_name: str) -> None:
    profile = db.scalar(select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True)))
    assert profile is not None
    profile.timezone = timezone_name
    db.flush()


def test_window_query_schema_requires_a_matching_mode_and_scope() -> None:
    common = {
        "module_id": uuid7(),
        "definition": {"columns": []},
        "mode": "calendar",
        "scope": "window",
        "date_field": {"field_id": uuid7(), "expected_type": "date"},
        "from_date": date(2026, 1, 1),
        "to_date": date(2026, 12, 31),
    }
    accepted = WindowRecordQuery(**common)
    assert (accepted.to_date - accepted.from_date).days + 1 == 365
    WindowRecordQuery(**{**common, "to_date": date(2027, 1, 1)})
    with pytest.raises(ValidationError):
        WindowRecordQuery(**{**common, "to_date": date(2027, 1, 2)})
    with pytest.raises(ValidationError):
        WindowRecordQuery(**{**common, "scope": "unscheduled"})
    with pytest.raises(ValidationError):
        WindowRecordQuery(
            **{
                **common,
                "mode": "timeline",
                "scope": "window",
                "start_field": {"field_id": uuid7(), "expected_type": "date"},
                "end_field": {"field_id": uuid7(), "expected_type": "datetime"},
            }
        )


@pytest.mark.integration
def test_window_query_hides_a_module_from_a_member_in_no_group(window_db: Session) -> None:
    actor = route_actor(window_db, records_read=False)
    module, field, _ = setup_rows(window_db, "date", ["2026-09-08"])
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = lambda: window_db
    module_id = module.id
    field_id = field.id
    payload = {
        "module_id": str(module_id),
        "definition": {"columns": []},
        "mode": "calendar",
        "scope": "window",
        "date_field": {"field_id": str(field_id), "expected_type": "date"},
        "from_date": "2026-09-08",
        "to_date": "2026-09-08",
    }
    try:
        client = TestClient(app)
        response = client.post("/api/records/window-query", json=payload)
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)

    assert response.status_code == 404


@pytest.mark.integration
def test_window_query_route_serializes_a_projected_page(window_db: Session) -> None:
    module, field, rows = setup_rows(window_db, "date", ["2026-09-08"])
    payload = WindowRecordQuery(
        module_id=module.id,
        definition={"columns": [reference(field)]},
        mode="calendar",
        scope="window",
        date_field=reference(field),
        from_date=date(2026, 9, 8),
        to_date=date(2026, 9, 8),
    )
    actor = route_actor(window_db)
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = lambda: window_db
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/records/window-query", json=payload.model_dump(mode="json")
            )
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["id"] for item in body["items"]] == [str(rows[0].id)]
    assert body["items"][0]["data"] == {str(field.id): "2026-09-08"}
    assert body["pagination"] == {
        "limit": 25,
        "offset": 0,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    assert body["timezone"] is None


@pytest.mark.integration
def test_calendar_window_wraps_saved_or_and_preserves_projection(window_db: Session) -> None:
    module, date_field, rows = setup_rows(
        window_db,
        "date",
        ["2026-09-07", "2026-09-08", "2026-09-08", "2026-09-09"],
    )
    status_field = add_values(
        window_db, module, rows, "Status", "text", ["urgent", "quiet", "normal", "urgent"]
    )
    status_ref = reference(status_field)
    payload = WindowRecordQuery(
        module_id=module.id,
        definition={
            "columns": [status_ref],
            "logic": "or",
            "filters": [
                {**status_ref, "operator": "eq", "value": "urgent"},
                {**status_ref, "operator": "eq", "value": "normal"},
            ],
        },
        mode="calendar",
        scope="window",
        date_field=reference(date_field),
        from_date=date(2026, 9, 8),
        to_date=date(2026, 9, 8),
    )

    result = query_window_records(window_db, payload, reader=READER)

    assert [item.id for item in result.items] == [rows[2].id]
    assert result.items[0].data == {str(status_field.id): "normal"}
    assert result.pagination.total == 1
    assert result.timezone is None


@pytest.mark.integration
def test_calendar_datetime_uses_workspace_day_across_dst_and_utc_naive_values(
    window_db: Session,
) -> None:
    set_workspace_timezone(window_db, "America/New_York")
    module, date_field, rows = setup_rows(
        window_db,
        "datetime",
        [
            "2026-03-08T04:59:59Z",
            "2026-03-08T05:00:00Z",
            "2026-03-09T03:59:59Z",
            "2026-03-09T04:00:00Z",
            "2026-03-08T05:00:00",
        ],
    )
    payload = WindowRecordQuery(
        module_id=module.id,
        definition={"columns": [reference(date_field)]},
        mode="calendar",
        scope="window",
        date_field=reference(date_field),
        from_date=date(2026, 3, 8),
        to_date=date(2026, 3, 8),
    )

    result = query_window_records(window_db, payload, reader=READER)

    assert {item.id for item in result.items} == {rows[1].id, rows[2].id, rows[4].id}
    assert result.timezone == "America/New_York"


@pytest.mark.integration
def test_calendar_undated_scope_has_independent_offset_pages(window_db: Session) -> None:
    module, field, rows = setup_rows(window_db, "date", [..., None, "2026-09-08"])
    payload = WindowRecordQuery(
        module_id=module.id,
        definition={"columns": [reference(field)]},
        mode="calendar",
        scope="undated",
        date_field=reference(field),
        limit=1,
    )

    first = query_window_records(window_db, payload, reader=READER)
    second = query_window_records(
        window_db, payload.model_copy(update={"offset": 1}), reader=READER
    )

    assert {item.id for item in first.items + second.items} == {rows[0].id, rows[1].id}
    assert first.pagination.total == second.pagination.total == 2
    assert first.pagination.has_more is True and second.pagination.has_more is False


@pytest.mark.integration
def test_timeline_mixed_fields_find_overlaps_and_missing_or_inverted_intervals(
    window_db: Session,
) -> None:
    set_workspace_timezone(window_db, "America/New_York")
    module, start_field, rows = setup_rows(
        window_db,
        "date",
        [
            "2026-03-07",
            "2026-03-09",
            "2026-03-08",
            None,
            "2026-03-09",
            "2026-03-06",
            "2026-03-08",
        ],
    )
    end_field = add_values(
        window_db,
        module,
        rows,
        "End",
        "datetime",
        [
            "2026-03-09T03:59:59Z",
            "2026-03-10T12:00:00Z",
            None,
            "2026-03-09T12:00:00Z",
            "2026-03-08T12:00:00Z",
            "2026-03-07T16:59:59Z",
            "2026-03-08T12:00:00Z",
        ],
    )
    definition = {"columns": [reference(start_field), reference(end_field)]}
    base = {
        "module_id": module.id,
        "definition": definition,
        "mode": "timeline",
        "start_field": reference(start_field),
        "end_field": reference(end_field),
    }

    overlapping = query_window_records(
        window_db,
        WindowRecordQuery(
            **base,
            scope="window",
            from_date=date(2026, 3, 8),
            to_date=date(2026, 3, 8),
        ),
        reader=READER,
    )
    unscheduled = query_window_records(
        window_db,
        WindowRecordQuery(**base, scope="unscheduled", limit=2),
        reader=READER,
    )
    remaining_unscheduled = query_window_records(
        window_db,
        WindowRecordQuery(**base, scope="unscheduled", limit=2, offset=2),
        reader=READER,
    )

    assert {item.id for item in overlapping.items} == {rows[0].id, rows[6].id}
    assert {item.id for item in unscheduled.items + remaining_unscheduled.items} == {
        rows[2].id,
        rows[3].id,
        rows[4].id,
    }
    assert unscheduled.pagination.total == remaining_unscheduled.pagination.total == 3
    assert unscheduled.pagination.has_more is True
    assert remaining_unscheduled.pagination.has_more is False
    assert overlapping.timezone == "America/New_York"

    broad_window = WindowRecordQuery(
        **base,
        scope="window",
        from_date=date(2026, 3, 1),
        to_date=date(2026, 3, 31),
    )
    unscheduled_scope = WindowRecordQuery(**base, scope="unscheduled")
    actor = route_actor(window_db)
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = lambda: window_db
    try:
        with TestClient(app) as client:
            scheduled_response = client.post(
                "/api/records/window-query", json=broad_window.model_dump(mode="json")
            )
            unscheduled_response = client.post(
                "/api/records/window-query", json=unscheduled_scope.model_dump(mode="json")
            )
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)

    assert scheduled_response.status_code == 200, scheduled_response.text
    assert unscheduled_response.status_code == 200, unscheduled_response.text
    scheduled_ids = {UUID(item["id"]) for item in scheduled_response.json()["items"]}
    unscheduled_ids = {UUID(item["id"]) for item in unscheduled_response.json()["items"]}
    assert rows[4].id not in scheduled_ids
    assert rows[4].id in unscheduled_ids


@pytest.mark.integration
def test_timeline_date_interval_with_datetime_deadline_reports_workspace_timezone(
    window_db: Session,
) -> None:
    set_workspace_timezone(window_db, "Asia/Manila")
    module, start_field, rows = setup_rows(window_db, "date", ["2026-09-08"])
    end_field = add_values(window_db, module, rows, "End", "date", ["2026-09-10"])
    deadline_field = add_values(
        window_db,
        module,
        rows,
        "Deadline",
        "datetime",
        ["2026-09-08T18:00:00Z"],
        position=2,
    )
    payload = WindowRecordQuery(
        module_id=module.id,
        definition={
            "columns": [reference(start_field), reference(end_field), reference(deadline_field)]
        },
        mode="timeline",
        scope="window",
        start_field=reference(start_field),
        end_field=reference(end_field),
        from_date=date(2026, 9, 8),
        to_date=date(2026, 9, 10),
    )
    actor = route_actor(window_db)
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_db] = lambda: window_db
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/records/window-query", json=payload.model_dump(mode="json")
            )
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_db, None)

    assert response.status_code == 200, response.text
    assert response.json()["timezone"] == "Asia/Manila"
    assert [item["id"] for item in response.json()["items"]] == [str(rows[0].id)]
    assert response.json()["items"][0]["data"][str(deadline_field.id)] == ("2026-09-08T18:00:00Z")


@pytest.mark.integration
def test_calendar_window_paginates_a_stable_global_order_and_handles_date_max(
    window_db: Session,
) -> None:
    module, date_field, rows = setup_rows(window_db, "date", ["2026-09-08"] * 31)
    stamp = datetime(2026, 9, 8, tzinfo=UTC)
    for row in rows:
        row.created_at = stamp
        row.updated_at = stamp
    window_db.flush()
    base = {
        "module_id": module.id,
        "definition": {
            "columns": [reference(date_field)],
            "sort": [{**reference(date_field), "direction": "asc"}],
        },
        "mode": "calendar",
        "scope": "window",
        "date_field": reference(date_field),
        "from_date": date(2026, 9, 8),
        "to_date": date(2026, 9, 8),
    }

    first = query_window_records(window_db, WindowRecordQuery(**base, limit=25), reader=READER)
    second = query_window_records(
        window_db, WindowRecordQuery(**base, limit=25, offset=25), reader=READER
    )

    expected_ids = sorted(row.id for row in rows)
    assert [item.id for item in first.items] == expected_ids[:25]
    assert [item.id for item in second.items] == expected_ids[25:]
    assert first.pagination.total == second.pagination.total == 31
    assert first.pagination.has_more is True and second.pagination.has_more is False

    max_module, max_field, max_rows = setup_rows(window_db, "date", ["9999-12-31"])
    max_window = WindowRecordQuery(
        module_id=max_module.id,
        definition={"columns": [reference(max_field)]},
        mode="calendar",
        scope="window",
        date_field=reference(max_field),
        from_date=date.max,
        to_date=date.max,
    )
    assert [
        item.id for item in query_window_records(window_db, max_window, reader=READER).items
    ] == [max_rows[0].id]


@pytest.mark.integration
def test_calendar_rejects_inactive_or_type_changed_field(window_db: Session) -> None:
    module, field, _ = setup_rows(window_db, "date", ["2026-09-08"])
    payload = WindowRecordQuery(
        module_id=module.id,
        definition={"columns": []},
        mode="calendar",
        scope="window",
        date_field=reference(field),
        from_date=date(2026, 9, 8),
        to_date=date(2026, 9, 8),
    )
    field.is_deleted = True
    window_db.flush()

    with pytest.raises(HTTPException) as inactive_error:
        query_window_records(window_db, payload, reader=READER)
    assert inactive_error.value.status_code == 409

    field.is_deleted = False
    field.type = "text"
    window_db.flush()
    with pytest.raises(HTTPException) as changed_error:
        query_window_records(window_db, payload, reader=READER)
    assert changed_error.value.status_code == 409
