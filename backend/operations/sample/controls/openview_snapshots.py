"""Mapped complete snapshot calls and actor/query-bound private readback receipts."""

import json
from collections.abc import Mapping
from dataclasses import replace
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from pydantic import TypeAdapter, ValidationError

from app.systems.sandbox.records.query_schemas import (
    AggregateSnapshotQuery,
    AggregateSnapshotResponse,
    AggregateSnapshotsRequest,
    DateSeriesAggregateQuery,
)
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _request,
    _request_id,
    _result,
)

MAX_BYTES, MAX_BUCKETS = 8 * 1024 * 1024, 10_000
_RECEIPTS = "openview_snapshot_receipts"
_SINGLE = "/api/records/aggregate-snapshot"
_PLURAL = "/api/records/aggregate-snapshots"


def batch_snapshot_action(group: PhaseAction, series: PhaseAction) -> PhaseAction:
    if group.actor_key != series.actor_key:
        raise ValueError("Snapshot batch must retain the same authorized actor")
    return replace(
        group,
        key="control:aggregate_snapshots",
        target_key="control:aggregate_snapshots",
        values={
            "operation": "aggregate_snapshots",
            "queries": [group.values["query"], series.values["query"]],
        },
    )


def _date_keys(query: DateSeriesAggregateQuery) -> list[str]:
    if query.bucket == "week":
        raise ValueError("Weekly sample queries require existing authoritative calendar context")

    def start(value: date) -> date:
        if query.bucket == "month":
            return value.replace(day=1)
        if query.bucket == "quarter":
            return value.replace(month=1 + 3 * ((value.month - 1) // 3), day=1)
        if query.bucket == "year":
            return value.replace(month=1, day=1)
        return value

    current, last = start(query.from_date), start(query.to_date)
    keys = []
    while True:
        keys.append(current.isoformat())
        if len(keys) > 366:
            raise ValueError("Sample date series exceeds the bucket bound")
        if current == last:
            return keys
        if query.bucket == "day":
            current += timedelta(days=1)
        elif query.bucket == "year":
            current = current.replace(year=current.year + 1)
        else:
            months = (
                (current.year - 1) * 12
                + current.month
                - 1
                + (3 if query.bucket == "quarter" else 1)
            )
            year, month = divmod(months, 12)
            current = date(year + 1, month + 1, 1)


def _snapshot(body: Any, query: Any, step: str) -> AggregateSnapshotResponse:
    try:
        if not isinstance(body, Mapping) or set(body) != {"items", "pagination"}:
            raise ValueError("Snapshot shape differs")
        parsed = AggregateSnapshotResponse.model_validate_json(json.dumps(body), strict=True)
        page, items = parsed.pagination, parsed.items
        raw_page = body["pagination"]
        if (
            set(raw_page) != {"limit", "offset", "count", "total", "has_more"}
            or any(type(raw_page[key]) is not int for key in ("limit", "offset", "count", "total"))
            or raw_page["has_more"] is not False
            or page.offset != 0
            or page.count != len(items)
            or page.total != len(items)
            or page.limit != max(len(items), 1)
            or len(items) > MAX_BUCKETS
            or len({item.key for item in items}) != len(items)
        ):
            raise ValueError("Snapshot is not complete")
        series = isinstance(query, DateSeriesAggregateQuery)
        if series and [item.key for item in items] != _date_keys(query):
            raise ValueError("Snapshot date keys differ")
        for raw, item in zip(body["items"], items, strict=True):
            if (
                set(raw) != {"key", "label", "value", "record_count"}
                or type(raw["record_count"]) is not int
                or item.record_count < 0
                or (not series and item.record_count == 0)
                or isinstance(raw["value"], bool)
                or (series and item.label != item.key)
                or (not series and item.key is None and item.label != "Unspecified")
                or (item.value is not None and not Decimal(item.value).is_finite())
            ):
                raise ValueError("Snapshot datum differs")
            if query.aggregation in {"count", "distinct"}:
                if (
                    type(raw["value"]) is not int
                    or not isinstance(item.value, int)
                    or item.value < 0
                ):
                    raise ValueError("Snapshot count is invalid")
                if query.aggregation == "count" and item.value != item.record_count:
                    raise ValueError("Snapshot record count differs")
                if query.aggregation == "distinct" and item.value > item.record_count:
                    raise ValueError("Snapshot distinct count differs")
            elif (
                query.aggregation in {"sum", "average"}
                and item.record_count > 0
                and item.value is None
            ):
                raise ValueError("Occupied snapshot value is missing")
            if series and item.record_count == 0:
                expected = None if query.aggregation in {"average", "min", "max"} else 0
                if item.value != expected:
                    raise ValueError("Synthetic snapshot value differs")
        return parsed
    except (ValidationError, ValueError, TypeError, KeyError, OverflowError):
        raise SamplePhaseActionError(
            "OpenView snapshot result is incomplete or invalid", step=step
        ) from None


def execute_snapshot_control(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    step = str(action.values.get("operation"))
    plural = step == "aggregate_snapshots"
    raw_queries = action.values.get("queries") if plural else [action.values.get("query")]
    if not isinstance(raw_queries, list) or len(raw_queries) != (2 if plural else 1):
        raise SamplePhaseActionError("Snapshot control plan is invalid", step=step)
    try:
        queries: list[AggregateSnapshotQuery] = [
            TypeAdapter(AggregateSnapshotQuery).validate_python(
                _wire_references(query, context, step=step)
            )
            for query in raw_queries
        ]
        if plural and [query.mode for query in queries] != ["groups", "date_series"]:
            raise ValueError("Snapshot batch modes differ")
        payload = (
            AggregateSnapshotsRequest(queries=queries).model_dump(mode="json")
            if plural
            else queries[0].model_dump(mode="json")
        )
    except (ValidationError, ValueError):
        raise SamplePhaseActionError("Snapshot control query is invalid", step=step) from None
    actor = _id(context.user_ids, action.actor_key, label="snapshot actor", step=step)
    keys = [
        json.dumps([actor, query.model_dump(mode="json")], sort_keys=True, ensure_ascii=False)
        for query in queries
    ]
    receipts = context.private_values.setdefault(_RECEIPTS, {})
    if plural and any(key not in receipts for key in keys):
        raise SamplePhaseActionError("Snapshot batch lacks its owned singular receipts", step=step)
    evidence: list[dict[str, object]] = []
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path=_PLURAL if plural else _SINGLE,
        step=step,
        expected=200,
        on_substep=on_substep,
        json_body=payload,
    )
    cache = {
        value.strip().lower() for value in response.headers.get("Cache-Control", "").split(",")
    }
    if (
        len(response.content) > MAX_BYTES
        or "no-store" not in cache
        or response.headers.get("X-Content-Type-Options", "").lower() != "nosniff"
        or response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json"
    ):
        raise SamplePhaseActionError("Snapshot response headers or byte bound differ", step=step)
    body = _read_json(response, step=step, request_id=_request_id(response))
    if plural:
        if set(body) != {"items"} or not isinstance(body["items"], list) or len(body["items"]) != 2:
            raise SamplePhaseActionError("Snapshot batch result length or shape differs", step=step)
        results = [
            _snapshot(item, query, step) for item, query in zip(body["items"], queries, strict=True)
        ]
        if sum(len(result.items) for result in results) > MAX_BUCKETS:
            raise SamplePhaseActionError(
                "Snapshot batch exceeds its combined bucket bound", step=step
            )
        if any(result != receipts[key] for result, key in zip(results, keys, strict=True)):
            raise SamplePhaseActionError(
                "Snapshot batch differs from its owned singular readback", step=step
            )
    else:
        results = [_snapshot(body, queries[0], step)]
        receipts[keys[0]] = results[0]
    totals = [len(result.items) for result in results]
    extra: dict[str, object] = {"query_total": sum(totals)}
    if plural:
        extra["query_totals"] = totals
    return _result(action, context, evidence, [], extra=extra)


def _wire_references(value: Any, context: PhaseExecutionContext, *, step: str) -> Any:
    if isinstance(value, Mapping):
        if isinstance(value.get("field_key"), str):
            field_key = str(value["field_key"])
            result = {
                "field_id": _mapped_id(context, "fields", field_key, step=step),
                "expected_type": value.get("expected_type"),
            }
            result.update(
                {
                    key: _wire_references(item, context, step=step)
                    for key, item in value.items()
                    if key not in {"field_key", "expected_type"}
                }
            )
            return result
        result = {key: _wire_references(item, context, step=step) for key, item in value.items()}
        module_key = result.pop("module_key", None)
        if isinstance(module_key, str):
            result["module_id"] = _mapped_id(context, "modules", module_key, step=step)
        return result
    if isinstance(value, list):
        return [_wire_references(item, context, step=step) for item in value]
    return value
