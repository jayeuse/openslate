"""Independent stateful S17 batch responses for the existing Platform wire."""

import json
from datetime import datetime, timedelta

import httpx

from app.systems.sandbox.records.schemas import RecordBatchUpdate


def batch_response(wire, request):
    payload = RecordBatchUpdate.model_validate(json.loads(request.content))
    module = next(row for row in wire.lifecycle.live.values() if "department_id" in row)
    field_id = str(wire.fields()[1].id)
    assert str(payload.module_id) == module["id"]
    assert len(payload.items) == 2
    assert len({item.record_id for item in payload.items}) == 2
    results = []
    for item in payload.items:
        identifier = str(item.record_id)
        row = wire.records[identifier]
        assert not row["is_deleted"] and row["module_id"] == module["id"]
        assert str(item.field_id) == field_id and isinstance(item.value, str)
        revision = datetime.fromisoformat(row["updated_at"])
        if item.revision != revision:
            results.append({"status": "stale", "record_id": identifier})
            continue
        row["data"] = {**row["data"], field_id: item.value}
        row["updated_at"] = (revision + timedelta(seconds=1)).isoformat()
        results.append(
            {"status": "updated", "record_id": identifier, "record": wire.record(identifier)}
        )
    return httpx.Response(
        200, headers={"Cache-Control": "private, no-store"}, json={"results": results}
    )
