"""HTTP and CSV assignments notify only final net-new eligible people."""

from uuid import UUID

import pytest
from sqlalchemy import event, select

from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.record_triggers.models import RecordTriggerEvent
from app.systems.sandbox.records.models import Record
from tests.catalog.test_record_import_integration import _preview
from tests.catalog.test_record_import_integration import world as world
from tests.platform_scheduling.support import notification_client as _client

pytestmark = pytest.mark.integration


def notices(db, record_id):
    return list(
        db.scalars(
            select(InAppNotification).where(
                InAppNotification.kind == "record-assigned",
                InAppNotification.subject_id == record_id,
            )
        )
    )


def test_http_assignments_deduplicate_fields_and_reassignment_but_preserve_archived_reads(world):
    db = world.db
    second = Field(
        org_id=world.module.org_id,
        module_id=world.module.id,
        name="Second owner",
        type="user",
        position=len(world.fields),
        required=False,
        config={},
    )
    db.add(second)
    db.commit()
    first_key, second_key = str(world.fields["user"].id), str(second.id)
    response = world.client.post(
        "/api/records",
        json={
            "module_id": str(world.module.id),
            "data": {
                str(world.fields["title"].id): "Assigned record",
                first_key: str(world.reader.id),
                second_key: str(world.reader.id),
            },
        },
    )
    assert response.status_code == 201, response.text
    row = response.json()
    record_id = UUID(row["id"])
    assert [n.recipient_id for n in notices(db, record_id)] == [world.reader.id]

    def patch(data):
        nonlocal row
        result = world.client.patch(
            f"/api/records/{record_id}",
            json={"data": {**row["data"], **data}},
            headers={"If-Match": f'"{row["updated_at"]}"'},
        )
        assert result.status_code == 200, result.text
        row = result.json()

    patch({first_key: str(world.reader.id), second_key: None})
    assert len(notices(db, record_id)) == 1
    patch({first_key: None, second_key: str(world.reader.id)})
    assert len(notices(db, record_id)) == 1
    patch({first_key: None, second_key: None})
    assert len(notices(db, record_id)) == 1
    patch({first_key: str(world.reader.id)})
    assert len(notices(db, record_id)) == 2
    stale = world.client.patch(
        f"/api/records/{record_id}",
        json={"data": {second_key: str(world.reader.id)}},
        headers={"If-Match": '"2020-01-01T00:00:00Z"'},
    )
    assert stale.status_code == 412
    assert len(notices(db, record_id)) == 2
    assert world.client.delete(f"/api/records/{record_id}").status_code == 204
    reader = _client(db, world.reader)
    statements = []

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(db.bind, "before_cursor_execute", capture)
    try:
        listed = reader.get("/api/notifications?status=unread")
        assert reader.get("/api/notifications?limit=1&offset=1").status_code == 200
    finally:
        event.remove(db.bind, "before_cursor_execute", capture)
    assert not any("records.data" in statement for statement in statements)
    assert listed.status_code == 200, listed.text
    assert listed.json()["pagination"]["total"] == 2
    assert all(
        n["module_id"] == str(world.module.id)
        and n["scheduled_for"] is None
        and n["subject_id"] == str(record_id)
        for n in listed.json()["items"]
    )
    world.grant.is_deleted = True
    db.commit()
    assert reader.get("/api/notifications").json()["items"] == []
    assert reader.get("/api/notifications/unread-count").json() == {"unread_count": 0}
    assert reader.post("/api/notifications/read-all").json() == {"updated_count": 0}
    assert reader.post(f"/api/notifications/{notices(db, record_id)[0].id}/read").status_code == 404


def test_csv_import_notifies_only_valid_created_assignments_and_not_preview(world):
    payload = world.payload()
    before = _preview(world, payload)
    assert (
        list(
            world.db.scalars(
                select(InAppNotification).where(InAppNotification.kind == "record-assigned")
            )
        )
        == []
    )
    payload.update(mode="import", schema_digest=before["schema_digest"])
    result = _preview(world, payload)
    record_id = UUID(result["rows"][0]["record_id"])
    assert result["created_count"] == 1
    assert [n.recipient_id for n in notices(world.db, record_id)] == [world.reader.id]
    assert result["rows"][1]["record_id"] is None
    assert result["rows"][2]["record_id"] is None


def test_failed_csv_batch_rolls_back_first_assignment_notification(world, monkeypatch):
    import app.systems.sandbox.records.importing as importing

    original = importing.enqueue_record_event
    calls = 0

    def invalid_second_event(db, record, *, previous):
        nonlocal calls
        calls += 1
        original(db, record, previous=previous)
        if calls == 2:
            for event in db.new:
                if isinstance(event, RecordTriggerEvent):
                    event.depth = -1

    payload = world.payload()
    payload["rows"] = [
        {"row_number": i, "cells": [f"Assigned {i}", "1", str(world.reader.id)]} for i in (2, 3)
    ]
    payload.update(mode="import", schema_digest=_preview(world, payload)["schema_digest"])
    monkeypatch.setattr(importing, "enqueue_record_event", invalid_second_event)
    result = world.client.post("/api/records/import", json=payload)
    assert result.status_code == 409, result.text
    assert world.count(Record) == 0
    assert (
        list(
            world.db.scalars(
                select(InAppNotification).where(InAppNotification.kind == "record-assigned")
            )
        )
        == []
    )
