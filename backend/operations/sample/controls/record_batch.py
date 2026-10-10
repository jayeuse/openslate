"""API-only legacy/compound round trip on two owned Platform import records."""

import copy
import json
from collections.abc import Callable, Mapping
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError

from app.systems.sandbox.records.schemas import (
    RecordBatchChange,
    RecordBatchChangesItem,
    RecordBatchInput,
    RecordBatchItem,
    RecordBatchResponse,
    RecordBatchUpdate,
    RecordBatchUpdated,
    RecordResponse,
)
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
)


def round_trip_records(
    context: PhaseExecutionContext,
    keys: tuple[str, ...],
    read: Callable[[str, str], dict[str, Any]],
    post: Callable[[str, Mapping[str, Any]], httpx.Response],
) -> None:
    bindings = context.runtime_mappings.get("sandbox_lifecycle", {})
    module = _id(bindings, "module", label="owned module", step="batch_before_records")
    field = _id(bindings, "field", label="non-title field", step="batch_before_records")
    title = _id(bindings, "title_field", label="title field", step="batch_before_records")
    identifiers = [
        _mapped_id(context, "platform_records", key, step="batch_before_records") for key in keys
    ]
    if len(identifiers) != 2 or len(set(identifiers)) != 2 or field == title:
        raise SamplePhaseActionError(
            "Batch control ownership is invalid", step="batch_before_records"
        )

    def owned_record(body: Mapping[str, Any], identifier: str, step: str) -> RecordResponse:
        try:
            record = RecordResponse.model_validate_json(json.dumps(body), strict=True)
        except ValidationError:
            raise SamplePhaseActionError("Batch record response is invalid", step=step) from None
        if (
            str(record.id) != identifier
            or str(record.module_id) != module
            or record.is_deleted
            or record.updated_at.utcoffset() is None
            or not isinstance(record.data.get(field), str)
            or not isinstance(record.data.get(title), str)
        ):
            raise SamplePhaseActionError(
                "Batch record identity, state or revision differs", step=step
            )
        return record

    originals = {
        identifier: owned_record(
            read(f"/api/records/{identifier}", f"batch_before_{key}"),
            identifier,
            f"batch_before_{key}",
        )
        for key, identifier in zip(keys, identifiers, strict=True)
    }

    def validate_updated(
        record: RecordResponse,
        before: RecordResponse,
        changes: Mapping[str, str],
        step: str,
    ) -> None:
        expected = {**copy.deepcopy(before.data), **changes}
        if (
            record.id != before.id
            or str(record.module_id) != module
            or record.is_deleted
            or record.updated_at.utcoffset() is None
            or record.updated_at == before.updated_at
            or record.data != expected
        ):
            raise SamplePhaseActionError(
                "Batch update changed identity, revision or non-target data", step=step
            )

    def batch(
        step: str,
        before: Mapping[str, RecordResponse],
        changes: Mapping[str, Mapping[str, str]],
        statuses: tuple[str, str],
        *,
        stale_first: bool = False,
    ) -> dict[str, RecordResponse]:
        commands: list[RecordBatchInput] = []
        for index, identifier in enumerate(identifiers):
            revision = (
                originals[identifier].updated_at
                if stale_first and index == 0
                else before[identifier].updated_at
            )
            requested = changes[identifier]
            if len(requested) == 1:
                command: RecordBatchInput = RecordBatchItem(
                    record_id=UUID(identifier),
                    revision=revision,
                    field_id=UUID(field),
                    value=requested[field],
                )
            else:
                command = RecordBatchChangesItem(
                    record_id=UUID(identifier),
                    revision=revision,
                    changes=[
                        RecordBatchChange(field_id=UUID(key), value=value)
                        for key, value in requested.items()
                    ],
                )
            commands.append(command)
        payload = RecordBatchUpdate(module_id=UUID(module), items=commands)
        response = post(step, payload.model_dump(mode="json"))
        body = _read_json(response, step=step)
        controls = {
            item.strip().lower() for item in response.headers.get("Cache-Control", "").split(",")
        }
        if response.status_code != 200 or "no-store" not in controls or set(body) != {"results"}:
            raise SamplePhaseActionError("Batch response status or shape differs", step=step)
        try:
            result = RecordBatchResponse.model_validate_json(response.content, strict=True)
        except ValidationError:
            raise SamplePhaseActionError("Batch result is malformed", step=step) from None
        result_ids = [str(item.record_id) for item in result.results]
        if len(result_ids) != 2 or len(set(result_ids)) != 2 or set(result_ids) != set(identifiers):
            raise SamplePhaseActionError("Batch result IDs do not match the request", step=step)
        results = {str(item.record_id): item for item in result.results}
        raw = {
            str(item.record_id): source
            for item, source in zip(result.results, body["results"], strict=True)
        }
        updated = dict(before)
        for identifier, status in zip(identifiers, statuses, strict=True):
            item = results[identifier]
            allowed = (
                {"status", "record_id", "record"}
                if status == "updated"
                else {"status", "record_id"}
            )
            if item.status != status or set(raw[identifier]) != allowed:
                raise SamplePhaseActionError("Batch item outcome differs from its plan", step=step)
            if isinstance(item, RecordBatchUpdated):
                validate_updated(item.record, before[identifier], changes[identifier], step)
                updated[identifier] = item.record
        return updated

    def read_back(
        prefix: str,
        receipts: Mapping[str, RecordResponse],
    ) -> dict[str, RecordResponse]:
        observed = {}
        for key, identifier in zip(keys, identifiers, strict=True):
            step = f"{prefix}_{key}"
            record = owned_record(read(f"/api/records/{identifier}", step), identifier, step)
            if (
                record.data != receipts[identifier].data
                or record.updated_at != receipts[identifier].updated_at
            ):
                raise SamplePhaseActionError(
                    "Batch readback differs from the confirmed outcome", step=step
                )
            observed[identifier] = record
        return observed

    first, second = identifiers
    changed = {
        first: {field: str(originals[first].data[field]) + "\nBatch review"},
        second: {
            title: str(originals[second].data[title]) + " — Batch review",
            field: str(originals[second].data[field]) + "\nBatch review",
        },
    }
    updated = read_back(
        "batch_updated", batch("batch_update_records", originals, changed, ("updated", "updated"))
    )
    partial = {
        first: {
            title: str(originals[first].data[title]) + " — Partial review",
            field: str(originals[first].data[field]) + "\nPartial review",
        },
        second: {field: str(originals[second].data[field]) + "\nPartial review"},
    }
    current = read_back(
        "batch_partial",
        batch("batch_partial_records", updated, partial, ("stale", "updated"), stale_first=True),
    )
    restored = {
        first: {field: str(originals[first].data[field])},
        second: {
            title: str(originals[second].data[title]),
            field: str(originals[second].data[field]),
        },
    }
    batch("batch_restore_records", current, restored, ("updated", "updated"))
