"""Run planned work sessions with explicit record and relationship writers."""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

from operations.sample_blueprint import SampleDataset, SampleEdge, SampleRecord, _option_id
from operations.sample_catalog import JsonValue
from operations.sample_client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample_episodes import SampleSession
from operations.sample_history import RecordHistory, plan_history
from operations.sample_population import SamplePopulationError, _api, _api_id, _record_if_match
from operations.sample_rejections import RejectionContext, run_rejection
from operations.sample_trigger_population import (
    _matches_conditions,
    _module_defaults,
    _trigger_action_field,
    _trigger_action_value,
    _trigger_by_key,
    _trigger_conditions,
    _trigger_module_id,
)

# A record-created automation updates its record just after the create. Linking waits
# for that result so the link does not meet the automation's lock. Several timeouts in a
# row mean the automation worker is not running, so the run stops.
_RULE_WAIT_SECONDS, _RULE_POLL_SECONDS, _RULE_TIMEOUTS_IN_A_ROW = 15.0, 0.2, 3
_BUSY_RETRY_DELAY_SECONDS = 0.3


def build_record_payload(
    record: SampleRecord,
    *,
    module_id: str,
    api_field_ids: Mapping[str, str],
    actor_ids: Mapping[str, str],
) -> dict[str, Any]:
    """Translate authored document-field values to published UI API IDs."""
    data: dict[str, Any] = {}
    for document_field_id, value in record.data.items():
        api_field_id = api_field_ids.get(document_field_id)
        if not api_field_id:
            raise SamplePopulationError("Published record field mapping is incomplete")
        if isinstance(value, str) and value.startswith("@user:"):
            value = actor_ids.get(value.removeprefix("@user:"), "")
            if not value:
                raise SamplePopulationError("Assigned person mapping is incomplete")
        data[api_field_id] = value
    return {"module_id": module_id, "data": data}


def relationship_write(
    *, field_id: str, source_id: str, target_id: str, field: Mapping[str, Any]
) -> tuple[str, str, dict[str, str]]:
    """Return the UI endpoint and payload for the field's actual cardinality."""
    multiple = field.get("relationship_multiple_targets")
    if not isinstance(multiple, bool):
        raise SamplePopulationError("Published relationship cardinality is missing")
    if multiple:
        body = {"field_id": field_id, "source_record_id": source_id, "target_record_id": target_id}
        return "POST", "/api/relationships", body
    return (
        "PUT",
        f"/api/relationships/fields/{field_id}/sources/{source_id}",
        {"target_record_id": target_id},
    )


def create_data(
    dataset: SampleDataset, record: SampleRecord, history: RecordHistory | None
) -> dict[str, JsonValue]:
    """The values a record is created with: earlier status and owner when it has a history."""
    data = dict(record.data)
    if history is not None:
        fields = dataset.field_ids[record.module_key]
        data[fields["status"]] = _option_id(
            dataset.seed,
            record.module_key,
            "status",
            history.initial_status,
            dataset.organization,
        )
        data.update({fields[key]: value for key, value in history.initial_values.items()})
        if history.initial_assignee is not None:
            data[fields["owner"]] = f"@user:{history.initial_assignee}"
    return data


def rule_candidates(
    dataset: SampleDataset, histories: Mapping[str, RecordHistory]
) -> dict[str, tuple[str, Any]]:
    """Records whose create values fire a record-created rule: the field and value it sets."""
    candidates: dict[str, tuple[str, Any]] = {}
    for key in dataset.organization.blueprint.record_created_trigger_keys:
        trigger = _trigger_by_key(dataset, key)
        module_key = next(
            name
            for name, value in dataset.module_ids.items()
            if value == _trigger_module_id(trigger)
        )
        operator, conditions = _trigger_conditions(trigger)
        defaults = _module_defaults(dataset, module_key)
        action = (_trigger_action_field(trigger), _trigger_action_value(trigger))
        for record in dataset.records:
            if record.module_key != module_key:
                continue
            created = replace(
                record, data=create_data(dataset, record, histories.get(record.logical_id))
            )
            if _matches_conditions(created, conditions, defaults, operator=operator):
                candidates[record.logical_id] = action
    return candidates


def _rule_results(
    dataset: SampleDataset,
    field_ids: Mapping[str, Mapping[str, str]],
    histories: Mapping[str, RecordHistory],
) -> dict[str, tuple[str, Any]]:
    """For records that fire a record-created rule: the API field and value it sets."""
    waits: dict[str, tuple[str, Any]] = {}
    for logical_id, (action_field, value) in rule_candidates(dataset, histories).items():
        api_field = field_ids[logical_id.split(":")[0]].get(action_field)
        if not api_field:
            raise SamplePopulationError("Record trigger field mapping is incomplete")
        waits[logical_id] = (api_field, value)
    return waits


class _RuleWaits:
    """Wait for record-created automation results and notice a stopped worker."""

    def __init__(self) -> None:
        self.timeouts: list[str] = []
        self._in_a_row = 0

    def wait(
        self,
        client: SampleClient,
        record_id: str,
        field_id: str,
        value: Any,
        *,
        required: bool = False,
    ) -> None:
        deadline = time.monotonic() + _RULE_WAIT_SECONDS
        while True:
            current = _api(client, "GET", f"/api/records/{record_id}")
            data = current.get("data")
            if isinstance(data, Mapping) and data.get(field_id) == value:
                self._in_a_row = 0
                return
            if time.monotonic() >= deadline:
                break
            time.sleep(_RULE_POLL_SECONDS)
        self.timeouts.append(record_id)
        self._in_a_row += 1
        if required or self._in_a_row >= _RULE_TIMEOUTS_IN_A_ROW:
            raise SamplePopulationError(
                "Record-created automation results did not appear; check the automation worker"
            )


def _edge_exists(client: SampleClient, field_id: str, source_id: str, target_id: str) -> str | None:
    listed = _api(
        client,
        "GET",
        "/api/relationships",
        params={"field_id": field_id, "source_record_id": source_id, "target_record_id": target_id},
    )
    items = listed.get("items")
    if isinstance(items, list) and len(items) == 1 and isinstance(items[0], Mapping):
        return _api_id(items[0], "relationship edge ID")
    return None


def _link(client: SampleClient, field: Mapping[str, Any], source_id: str, target_id: str) -> str:
    """Write one edge. A busy 503 is reconciled by reading the edge before one retry."""
    field_id = _api_id(field, "relationship field ID")
    method, path, body = relationship_write(
        field_id=field_id, source_id=source_id, target_id=target_id, field=field
    )
    for attempt in range(2):
        try:
            response = _api(client, method, path, body=body, expected=(200, 201))
            return _api_id(response, "relationship edge ID")
        except SampleWriteOutcomeUnknown as error:
            # Only the known busy response is reconciled; any other outcome stops the run.
            if error.failure_code != "relationship_busy":
                raise
            existing = _edge_exists(client, field_id, source_id, target_id)
            if existing is not None:
                return existing
            if attempt == 1:
                raise
            time.sleep(_BUSY_RETRY_DELAY_SECONDS)
    raise SamplePopulationError("Relationship write did not complete")


def _apply_step(client: SampleClient, record_id: str, changes: Mapping[str, Any]) -> bool:
    """Read the record and send it whole with the step's changes; skip when already done."""
    current = _api(client, "GET", f"/api/records/{record_id}")
    data = current.get("data")
    if not isinstance(data, dict):
        raise SamplePopulationError("Record readback failed before a history update")
    if all(data.get(field) == value for field, value in changes.items()):
        return False  # An automation, or a colleague, already made this change.
    _api(
        client,
        "PATCH",
        f"/api/records/{record_id}",
        body={"data": {**data, **changes}},
        headers=_record_if_match(current),
    )
    return True


@dataclass
class ActivityResult:
    records: dict[str, dict[str, Any]] = field(default_factory=dict)
    edge_count: int = 0
    history_updates: int = 0
    history_skipped: list[str] = field(default_factory=list)


def _write_edge(
    client: SampleClient,
    edge: SampleEdge,
    result: ActivityResult,
    relation_key: Mapping[str, str],
    relationship_fields: Mapping[str, Mapping[str, Any]],
) -> None:
    key = relation_key.get(edge.relationship_id, "")
    relation = relationship_fields.get(key)
    source = result.records.get(edge.source_record_id)
    target = result.records.get(edge.target_record_id)
    if relation is None or source is None or target is None:
        raise SamplePopulationError("Relationship record or field mapping is incomplete")
    edge_id = _link(
        client, relation, _api_id(source, "source record ID"), _api_id(target, "target record ID")
    )
    client.record_mapping("edge", f"{key}:{edge.source_record_id}:{edge.target_record_id}", edge_id)
    result.edge_count += 1


def _wait_for_followup_flags(
    dataset: SampleDataset,
    logical_id: str,
    records: Mapping[str, Mapping[str, Any]],
    by_logical: Mapping[str, SampleRecord],
    field_ids: Mapping[str, Mapping[str, str]],
    clients: Mapping[str, SampleClient],
    waits: _RuleWaits,
) -> None:
    links = dataset.organization.links
    required_parents = set(links.after_history.get(logical_id, ())) | set(
        links.after_flags.get(logical_id, ())
    )
    for parent_id in sorted(required_parents):
        parent = by_logical[parent_id]
        client = clients.get(parent.creator_key)
        if client is None:
            raise SamplePopulationError("Follow-up parent writer is unavailable")
        for key in dataset.organization.generators.trigger_keys:
            trigger = _trigger_by_key(dataset, key)
            event = trigger.get("trigger", {})
            if (
                trigger.get("enabled") is not True
                or event.get("kind") == "schedule"
                or _trigger_module_id(trigger) != dataset.module_ids[parent.module_key]
            ):
                continue
            operator, conditions = _trigger_conditions(trigger)
            if not _matches_conditions(
                parent, conditions, _module_defaults(dataset, parent.module_key), operator=operator
            ):
                continue
            action_field = _trigger_action_field(trigger)
            waits.wait(
                client,
                _api_id(records[parent_id]),
                field_ids[parent.module_key][action_field],
                _trigger_action_value(trigger),
                required=True,
            )


def run_activity(
    dataset: SampleDataset,
    plan: Sequence[SampleSession],
    *,
    modules: Mapping[str, Mapping[str, Any]],
    field_ids: Mapping[str, Mapping[str, str]],
    relationship_fields: Mapping[str, Mapping[str, Any]],
    actor_ids: Mapping[str, str],
    clients: Mapping[str, SampleClient],
    rejections: RejectionContext | None = None,
    content: Any = None,
) -> ActivityResult:
    """Run every session: create and link records, then move records on through history."""
    by_logical = {record.logical_id: record for record in dataset.records}
    relation_key = {document_id: key for key, document_id in dataset.relationship_ids.items()}
    edges_by_target: dict[str, list[SampleEdge]] = {}
    for edge in dataset.edges:
        edges_by_target.setdefault(edge.target_record_id, []).append(edge)
    histories = plan_history(dataset)
    rule_results = _rule_results(dataset, field_ids, histories)
    rule_waits = _RuleWaits()
    result = ActivityResult()
    cases = {case.key: case for case in dataset.organization.rejections.activity_cases}
    for position, session in enumerate(plan):
        # Board work (posts, events, links) happens between record sessions.
        if content is not None and position:
            content.after_session(position, result.records)
        if session.kind == "reject":
            if rejections is None:
                raise SamplePopulationError("Planned rejections need a rejection context")
            run_rejection(rejections, cases[session.case_key])
            continue
        client = clients.get(session.creator_key)
        module_id = str(modules.get(session.module_key, {}).get("id") or "")
        if client is None or not module_id:
            raise SamplePopulationError("Session writer or module mapping is missing")
        if session.kind == "link":
            for index in session.edge_indices:
                if not 0 <= index < len(dataset.edges):
                    raise SamplePopulationError("Link session edge index is invalid")
                edge = dataset.edges[index]
                actor = edge.creator_key or by_logical[edge.target_record_id].creator_key
                if (
                    actor != session.creator_key
                    or by_logical[edge.source_record_id].module_key != session.module_key
                ):
                    raise SamplePopulationError(
                        "Link session differs from its planned writer or source module"
                    )
                _write_edge(client, edge, result, relation_key, relationship_fields)
            continue
        api_fields = field_ids[session.module_key]
        for logical_id, step_index in session.steps:
            history = histories[logical_id]
            step = history.steps[step_index]
            doc_fields = dataset.field_ids[session.module_key]
            changes: dict[str, Any] = {
                api_fields[doc_fields["status"]]: _option_id(
                    dataset.seed,
                    session.module_key,
                    "status",
                    step.status,
                    dataset.organization,
                )
            }
            changes.update(
                {api_fields[doc_fields[key]]: value for key, value in step.values.items()}
            )
            if step_index == 0 and history.initial_assignee is not None:
                changes[api_fields[doc_fields["owner"]]] = actor_ids[
                    by_logical[logical_id].assignee_key
                ]
            record_id = _api_id(result.records[logical_id], "record ID")
            if _apply_step(client, record_id, changes):
                result.history_updates += 1
            else:
                result.history_skipped.append(f"{logical_id}:{step_index}")
        for logical_id in session.record_ids:
            _wait_for_followup_flags(
                dataset, logical_id, result.records, by_logical, field_ids, clients, rule_waits
            )
            sample = by_logical[logical_id]
            created_as = replace(
                sample, data=create_data(dataset, sample, histories.get(logical_id))
            )
            payload = build_record_payload(
                created_as, module_id=module_id, api_field_ids=api_fields, actor_ids=actor_ids
            )
            created = _api(client, "POST", "/api/records", body=payload, expected=(201,))
            record_id = _api_id(created, "record ID")
            client.record_mapping("record", logical_id, record_id)
            result.records[logical_id] = {
                **created,
                "module_key": sample.module_key,
                "actor_key": sample.actor_key,
                "creator_key": sample.creator_key,
            }
            if logical_id in rule_results:
                rule_waits.wait(client, record_id, *rule_results[logical_id])
            for edge in edges_by_target.get(logical_id, []):
                if not edge.creator_key or edge.creator_key == session.creator_key:
                    _write_edge(client, edge, result, relation_key, relationship_fields)
    return result
