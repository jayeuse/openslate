"""Independent complete snapshot fixtures for actual sample HTTP callers."""

import copy
import json
from datetime import timedelta
from uuid import uuid4

import httpx
from pydantic import TypeAdapter

from app.systems.sandbox.records.query_schemas import (
    AggregateSnapshotQuery,
    AggregateSnapshotsRequest,
)


def empty_snapshot(query):
    if query.mode == "groups":
        items = []
    else:
        assert query.bucket == "day", "Non-day tests must provide independent literal buckets"
        length = (query.to_date - query.from_date).days + 1
        zero = None if query.aggregation in {"average", "min", "max"} else 0
        items = [
            {
                "key": (query.from_date + timedelta(days=index)).isoformat(),
                "label": (query.from_date + timedelta(days=index)).isoformat(),
                "value": zero,
                "record_count": 0,
            }
            for index in range(length)
        ]
    return {
        "items": items,
        "pagination": {
            "limit": max(len(items), 1),
            "offset": 0,
            "count": len(items),
            "total": len(items),
            "has_more": False,
        },
    }


def snapshot_response(request, *, replies=None, fault="none"):
    body = json.loads(request.content)
    plural = request.url.path.endswith("/aggregate-snapshots")
    queries = (
        AggregateSnapshotsRequest.model_validate(body).queries
        if plural
        else [TypeAdapter(AggregateSnapshotQuery).validate_python(body)]
    )
    snapshots = [
        copy.deepcopy(replies[query.mode]) if replies else empty_snapshot(query)
        for query in queries
    ]
    result = {"items": snapshots} if plural else snapshots[0]
    if plural:
        if fault == "denied":
            return httpx.Response(403, json={"detail": "private-canary"})
        if fault == "unavailable":
            return httpx.Response(503, json={"detail": "private-canary"})
        if fault == "malformed":
            result = {"items": "bad"}
        elif fault == "missing":
            result["items"].pop()
        elif fault == "extra":
            result["items"].append(copy.deepcopy(snapshots[0]))
        elif fault == "reversed":
            result["items"].reverse()
        elif fault == "partial":
            snapshots[1]["pagination"]["has_more"] = True
        elif fault == "offset":
            snapshots[1]["pagination"]["offset"] = 1
        elif fault == "wrong_total":
            snapshots[1]["pagination"]["total"] += 1
        elif fault == "wrong_limit":
            snapshots[1]["pagination"]["limit"] += 1
        elif fault == "duplicate_key":
            snapshots[1]["items"][1]["key"] = snapshots[1]["items"][0]["key"]
        elif fault == "wrong_key":
            snapshots[1]["items"][0]["key"] = "2000-01-01"
        elif fault == "wrong_label":
            snapshots[1]["items"][0]["label"] = "Wrong date"
        elif fault == "bool_count":
            snapshots[1]["items"][0]["record_count"] = True
        elif fault == "bool_value":
            snapshots[1]["items"][0]["value"] = True
        elif fault == "null_count":
            snapshots[1]["items"][0]["value"] = None
        elif fault == "nonfinite":
            snapshots[1]["items"][0]["value"] = "NaN"
        elif fault == "altered":
            snapshots[1]["items"][0].update(value=1, record_count=1)
        elif fault == "shape":
            result["unexpected"] = True
    headers = {
        "X-Request-ID": str(uuid4()),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if plural and fault == "cache":
        headers["Cache-Control"] = "public"
    if plural and fault == "nosniff":
        headers["X-Content-Type-Options"] = "missing"
    if plural and fault == "size":
        return httpx.Response(200, headers=headers, content=b"x" * (8 * 1024 * 1024 + 1))
    return httpx.Response(200, headers=headers, json=result)
