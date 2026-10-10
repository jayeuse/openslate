"""Independent stateful legacy/compound responses for the Platform wire."""

import json
from datetime import datetime, timedelta

import httpx


def batch_response(wire, request):
    payload = json.loads(request.content)
    module = next(row for row in wire.lifecycle.live.values() if "department_id" in row)
    title, field = (str(row.id) for row in wire.fields())
    assert set(payload) == {"module_id", "items"} and payload["module_id"] == module["id"]
    assert len(payload["items"]) == 2
    assert len({item["record_id"] for item in payload["items"]}) == 2
    results = []
    for item in payload["items"]:
        identifier = item["record_id"]
        row = wire.records[identifier]
        assert not row["is_deleted"] and row["module_id"] == module["id"]
        if "changes" in item:
            assert set(item) == {"record_id", "revision", "changes"}
            changes = item["changes"]
            assert 1 <= len(changes) <= 2
        else:
            assert set(item) == {"record_id", "revision", "field_id", "value"}
            changes = [{"field_id": item["field_id"], "value": item["value"]}]
        assert len({change["field_id"] for change in changes}) == len(changes)
        assert all(
            set(change) == {"field_id", "value"}
            and change["field_id"] in {title, field}
            and isinstance(change["value"], str)
            for change in changes
        )
        requested = {change["field_id"]: change["value"] for change in changes}
        revision = datetime.fromisoformat(row["updated_at"])
        original_revision = datetime.fromisoformat(item["revision"])
        assert original_revision.utcoffset() is not None
        if original_revision != revision:
            results.append({"status": "stale", "record_id": identifier})
            continue
        row["data"] = {**row["data"], **requested}
        row["updated_at"] = (revision + timedelta(seconds=1)).isoformat()
        results.append(
            {"status": "updated", "record_id": identifier, "record": wire.record(identifier)}
        )
    return httpx.Response(
        200, headers={"Cache-Control": "private, no-store"}, json={"results": results}
    )
