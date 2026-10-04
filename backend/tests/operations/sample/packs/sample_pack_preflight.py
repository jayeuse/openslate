"""Offline admission of generated sample payloads against application contracts."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import replace
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from app.systems.boards.event_schemas import EventCreate
from app.systems.boards.post_schemas import PostCreate
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import validate_module_schema, validate_record_data
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.rules import (
    _field_type,
    operational_config,
    relationship_metadata,
)
from app.systems.sandbox.records.router import _apply_creation_defaults
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from app.systems.sandbox.relationships.locking import validate_relationship_modules
from app.systems.sandbox.relationships.schemas import RelationshipCreate
from operations.sample.blueprint import SampleDataset, _option_id
from operations.sample.board_text import post_text
from operations.sample.catalog import module_counts
from operations.sample.client import _SAFE_MAPPING_VALUE
from operations.sample.history import plan_history
from operations.sample.packs.interface import OrganizationPack
from operations.sample.population.activity import build_record_payload, create_data
from operations.sample.population.board_entries import event_payload
from operations.sample.population.board_steps import BoardMeta
from operations.sample.population.boards import project_board_logical_id
from operations.seed_sample_data import build_plan_summary
from tests.operations.sample.packs.sample_pack_chain_preflight import (
    validate_phase_plan_consistency,
    validate_record_chain_consistency,
)
from tests.operations.sample.packs.sample_pack_openview_preflight import validate_openview_payloads

_JOURNAL_KINDS = {
    "boards",
    "content_fallback",
    "dashboards",
    "departments",
    "edge",
    "edges",
    "events",
    "expected_failure",
    "fields",
    "group",
    "modules",
    "posts",
    "record",
    "relationships",
    "reports",
    "sandbox_tests",
    "sandbox_versions",
    "trigger_runs",
    "user",
    "views",
    "widgets",
}


def _uuid(value: str) -> UUID:
    return UUID(value)


def _number(value: object) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise AssertionError("Named scenario calculations require numeric inputs")
    return value


def _record_server_id(dataset: SampleDataset, logical_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"{dataset.seed}:record:{logical_id}"))


def _active_actor_ids(dataset: SampleDataset) -> dict[str, str]:
    namespace = dataset.organization.identity.uuid_namespace
    return {
        person.key: str(uuid5(NAMESPACE_URL, f"{namespace}:{dataset.seed}:actor:{person.key}"))
        for person in dataset.organization.actors.people
        if person.status == "active"
    }


def _operational_fields(
    document: SandboxDocument,
) -> tuple[dict[str, list[Field]], dict[str, Module]]:
    fields_by_module: dict[str, list[Field]] = {}
    modules_by_id: dict[str, Module] = {}
    for module in document.design.modules:
        fields = [
            Field(
                id=_uuid(field.id),
                module_id=_uuid(module.id),
                name=field.name,
                type=FieldType(_field_type(field)),
                required=field.required,
                position=position,
                config=operational_config(field),
            )
            for position, field in enumerate(module.fields)
            if not field.closed
        ]
        fields_by_module[module.id] = fields
        modules_by_id[module.id] = Module(
            id=_uuid(module.id),
            department_id=_uuid(module.department_id),
            module_name=module.name,
            is_deleted=module.closed,
        )

    for relationship in document.design.relationships:
        multiple_targets, multiple_sources = relationship_metadata(relationship)
        source_fields = fields_by_module[relationship.source_module_id]
        source_fields.append(
            Field(
                id=_uuid(relationship.id),
                module_id=_uuid(relationship.source_module_id),
                name=relationship.name,
                type=FieldType.RELATIONSHIP,
                required=False,
                position=len(source_fields),
                config={},
                relationship_target_module_id=_uuid(relationship.target_module_id),
                relationship_multiple_targets=multiple_targets,
                relationship_multiple_sources=multiple_sources,
            )
        )
    for fields in fields_by_module.values():
        validate_module_schema(fields)
    return fields_by_module, modules_by_id


def _validate_record_states(
    dataset: SampleDataset, fields_by_module: dict[str, list[Field]]
) -> None:
    histories = plan_history(dataset)
    actor_ids = _active_actor_ids(dataset)
    for record in dataset.records:
        module_fields = fields_by_module[dataset.module_ids[record.module_key]]
        document_fields = dataset.field_ids[record.module_key]
        api_fields = {identifier: identifier for identifier in document_fields.values()}
        history = histories.get(record.logical_id)
        created = replace(record, data=create_data(dataset, record, history))
        payload = build_record_payload(
            created,
            module_id=dataset.module_ids[record.module_key],
            api_field_ids=api_fields,
            actor_ids=actor_ids,
        )
        RecordCreate.model_validate(payload)
        state = dict(payload["data"])
        validate_record_data(_apply_creation_defaults(state, module_fields), module_fields)
        if history is None:
            continue
        for index, step in enumerate(history.steps):
            changes: dict[str, Any] = {
                api_fields[document_fields["status"]]: _option_id(
                    dataset.seed, record.module_key, "status", step.status, dataset.organization
                )
            }
            changes.update(
                {api_fields[document_fields[key]]: value for key, value in step.values.items()}
            )
            if index == 0 and history.initial_assignee is not None:
                changes[api_fields[document_fields["owner"]]] = actor_ids[record.assignee_key]
            state.update(changes)
            RecordUpdate.model_validate({"data": dict(state)})
            validate_record_data(_apply_creation_defaults(state, module_fields), module_fields)


def _board_metas(pack: OrganizationPack) -> tuple[BoardMeta, ...]:
    boards = [BoardMeta("company", None, "company", ("admin",))]
    boards.extend(
        BoardMeta(f"department:{key}", key, "department", pack.actors.team_keys[key])
        for key, _name in pack.catalog.departments
    )
    boards.extend(
        BoardMeta(
            project_board_logical_id(department, name),
            department,
            "project",
            pack.actors.team_keys[department],
        )
        for name, department in pack.content.data.projects
    )
    return tuple(boards)


def _validate_board_payloads(dataset: SampleDataset) -> None:
    pack = dataset.organization
    spec = pack.content.data
    for board_index, meta in enumerate(_board_metas(pack)):
        board = {"department_key": meta.department_key, "scope": meta.scope}
        for index in range(spec.posts_per_board):
            title, body = post_text(
                board, index, spec.scenario_total, spec.scenario_paid, organization=pack
            )
            PostCreate.model_validate(
                {
                    "board_revision": 1,
                    "title": title,
                    "body": body,
                    "links": [],
                    "expires_at": None,
                    "pinned": False,
                }
            )
        for index in range(spec.events_per_board):
            payload, _reminders = event_payload(
                board_index, index, dataset.anchor_date, organization=pack
            )
            EventCreate.model_validate({**payload, "board_revision": 1})


def _validate_relationships(dataset: SampleDataset, document: SandboxDocument) -> None:
    pack = dataset.organization
    records = {record.logical_id: record for record in dataset.records}
    relationships = {relationship.key: relationship for relationship in pack.catalog.relationships}
    document_relationships = {item.id: item for item in document.design.relationships}
    edges_by_relationship: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for edge in dataset.edges:
        source = records[edge.source_record_id]
        target = records[edge.target_record_id]
        relationship_key = next(
            key
            for key, identifier in dataset.relationship_ids.items()
            if identifier == edge.relationship_id
        )
        relationship = relationships[relationship_key]
        assert source.module_key == relationship.source
        assert target.module_key == relationship.target
        schema = document_relationships[edge.relationship_id]
        RelationshipCreate.model_validate(
            {
                "field_id": schema.id,
                "source_record_id": _record_server_id(dataset, source.logical_id),
                "target_record_id": _record_server_id(dataset, target.logical_id),
            }
        )
        edges_by_relationship[relationship_key].append((source.logical_id, target.logical_id))

    module_rows = {
        module.key: Module(
            id=_uuid(dataset.module_ids[module.key]),
            department_id=_uuid(dataset.department_ids[module.department]),
            module_name=module.name,
            is_deleted=False,
        )
        for module in pack.catalog.modules
    }
    document_modules = {module.id: module for module in document.design.modules}
    for spec in pack.catalog.relationships:
        relation = document_relationships[dataset.relationship_ids[spec.key]]
        assert document_modules[relation.source_module_id].id == dataset.module_ids[spec.source]
        assert document_modules[relation.target_module_id].id == dataset.module_ids[spec.target]
        validate_relationship_modules(module_rows[spec.source], module_rows[spec.target])
        edges = edges_by_relationship[spec.key]
        assert len(edges) == len(set(edges))
        multiple_targets, multiple_sources = relationship_metadata(relation)
        if not multiple_targets:
            assert max(Counter(source for source, _target in edges).values(), default=0) <= 1
        if not multiple_sources:
            assert max(Counter(target for _source, target in edges).values(), default=0) <= 1


def _journal_ids(
    dataset: SampleDataset,
    openview_plans: dict[str, tuple[tuple[str, dict[str, Any], list[dict[str, Any]]], ...]],
) -> dict[str, set[str]]:
    pack = dataset.organization
    mappings: dict[str, set[str]] = defaultdict(set)

    def add(kind: str, value: str) -> None:
        mappings[kind].add(value)

    for key, _name in pack.catalog.departments:
        add("departments", key)
    for module in pack.catalog.modules:
        add("modules", module.key)
        for field in module.fields:
            add("fields", f"{module.key}:{field.key}")
    for relationship in pack.catalog.relationships:
        add("relationships", relationship.key)
    for group in pack.actors.group_access:
        add("group", group)
    for person in pack.actors.people:
        add("user", person.key)
    for record in dataset.records:
        add("record", record.logical_id)
    for edge in dataset.edges:
        relationship_key = next(
            key for key, value in dataset.relationship_ids.items() if value == edge.relationship_id
        )
        add("edge", f"{relationship_key}:{edge.source_record_id}:{edge.target_record_id}")
    boards = _board_metas(pack)
    for board in boards:
        add("boards", board.logical_id)
        add("content_fallback", board.logical_id)
        for index in range(pack.content.data.posts_per_board):
            add("posts", f"{board.logical_id}:post:{index + 1:02d}")
        for index in range(pack.content.data.events_per_board):
            add("events", f"{board.logical_id}:event:{index + 1:02d}")
        for index in range(4):
            add("widgets", f"{board.logical_id}:widget:{index + 1:02d}")
    for department, _name in pack.catalog.departments:
        add("dashboards", f"department:{department}:dashboard")
        for index in range(4):
            add("widgets", f"department:{department}:dashboard:widget:{index + 1:02d}")
        for layout in pack.content.data.layouts:
            source_module = openview_plans[department][0][0]
            add("views", f"department:{department}:view:{source_module}:{layout}")
        for index in range(len(openview_plans[department])):
            add("reports", f"department:{department}:report:{index + 1:02d}")
    for link in pack.content.data.board_links:
        for logical_id in link.records:
            content_id = f"{link.kind}:{link.board}:{link.index}"
            add("edges", f"board:{content_id}:record:{logical_id}")
    for vector in dataset.test_vectors:
        add("sandbox_tests", vector.key.replace("-", "_"))
    for key in ("initial_checkpoint", "published"):
        add("sandbox_versions", key)
    for case in (*pack.rejections.activity_cases, *pack.rejections.closing_cases):
        add("expected_failure", case.key)
    for key in pack.generators.trigger_keys:
        add("trigger_runs", f"{key.replace('-', '_')}:0001")
    assert set(mappings) == _JOURNAL_KINDS
    return mappings


def _validate_journal_ids(
    dataset: SampleDataset,
    openview_plans: dict[str, tuple[tuple[str, dict[str, Any], list[dict[str, Any]]], ...]],
) -> None:
    for kind, logical_ids in _journal_ids(dataset, openview_plans).items():
        assert _SAFE_MAPPING_VALUE.fullmatch(kind)
        for logical_id in logical_ids:
            assert _SAFE_MAPPING_VALUE.fullmatch(logical_id), (kind, logical_id)
    identifiers = (
        *dataset.department_ids.values(),
        *dataset.module_ids.values(),
        *(field for module in dataset.field_ids.values() for field in module.values()),
        *dataset.relationship_ids.values(),
        *dataset.trigger_ids.values(),
    )
    assert all(_uuid(value) for value in identifiers)


def _validate_access_and_totals(dataset: SampleDataset) -> None:
    from operations.sample.actors import planned_access_level
    from operations.sample.episodes import plan_sessions, record_parents
    from operations.sample.history import plan_history

    pack = dataset.organization
    modules = {module.key: module for module in pack.catalog.modules}
    records = {record.logical_id: record for record in dataset.records}
    assert len(records) == sum(dataset.module_counts.values())
    assert dataset.module_counts == module_counts("small", pack)
    assert Counter(record.module_key for record in dataset.records) == dataset.module_counts
    for record in dataset.records:
        module = modules[record.module_key]
        assert planned_access_level(pack, record.creator_key, module.department, module.key) >= 2
        assert planned_access_level(pack, record.assignee_key, module.department, module.key) >= 2
    for logical_id, parent_ids in record_parents(dataset).items():
        assert logical_id in records
        assert set(parent_ids) <= records.keys()
    histories = plan_history(dataset)
    parents_by_record = record_parents(dataset)
    created: set[str] = set()
    completed: set[str] = set()
    for session in plan_sessions(dataset):
        if session.kind == "create":
            module = modules[session.module_key]
            assert (
                planned_access_level(pack, session.creator_key, module.department, module.key) >= 2
            )
            for logical_id in session.record_ids:
                assert records[logical_id].creator_key == session.creator_key
                assert set(parents_by_record.get(logical_id, ())) <= created
                assert set(pack.links.after_history.get(logical_id, ())) <= completed
                created.add(logical_id)
        elif session.kind == "reject":
            case = next(
                item for item in pack.rejections.activity_cases if item.key == session.case_key
            )
            assert set(case.needs) <= created
        else:
            module = modules[session.module_key]
            assert (
                planned_access_level(pack, session.creator_key, module.department, module.key) >= 2
            )
            for logical_id, index in session.steps:
                history = histories[logical_id]
                assert logical_id in created
                assert history.steps[index].updater_key == session.creator_key
                if index + 1 == len(history.steps):
                    completed.add(logical_id)
    assert created == records.keys()
    assert completed == {logical_id for logical_id, history in histories.items() if history.steps}

    for edge in dataset.edges:
        source, target = records[edge.source_record_id], records[edge.target_record_id]
        assert (
            planned_access_level(pack, edge.creator_key, source.actor_key, source.module_key) >= 2
        )
        assert (
            planned_access_level(pack, edge.creator_key, target.actor_key, target.module_key) >= 1
        )
    for case in (*pack.rejections.activity_cases, *pack.rejections.closing_cases):
        assert set(case.needs) <= records.keys()
        if case.expected_status not in {403, 404}:
            continue
        case_record_id = case.target_record_id or case.template_record_id
        if case_record_id is None:
            continue
        refusal_module = modules.get(case_record_id.split(":", maxsplit=1)[0])
        if refusal_module is None:
            continue
        needed = 1 if case.operation == "read-record" else 2
        assert (
            planned_access_level(
                pack, case.actor_key, refusal_module.department, refusal_module.key
            )
            < needed
        )

    summary = build_plan_summary(dataset)
    assert summary["operational_records"] == len(dataset.records)
    assert summary["relationship_edges"] == len(dataset.edges)
    assert summary["planned_rejections"] == len(
        (*pack.rejections.activity_cases, *pack.rejections.closing_cases)
    )


def admit_dataset(dataset: SampleDataset) -> None:
    """Assert one generated Small dataset satisfies its offline server contracts."""
    document = SandboxDocument.model_validate(dataset.document)
    fields_by_module, _modules = _operational_fields(document)
    openview_plans = validate_openview_payloads(dataset, document)
    _validate_access_and_totals(dataset)
    _validate_relationships(dataset, document)
    _validate_record_states(dataset, fields_by_module)
    validate_record_chain_consistency(dataset)
    validate_phase_plan_consistency(dataset)
    _validate_board_payloads(dataset)
    _validate_journal_ids(dataset, openview_plans)
