"""Build the authorable Sandbox v4 document and its temporary Test vectors."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import cast
from zoneinfo import ZoneInfo

from app.systems.sandbox.designs.field_schemas import SelectFieldConfig
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.validation import validate_document
from operations.sample_catalog import _anchor, _doc_id
from operations.sample_packs import default_pack
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.types import ActorKey, FieldSpec, JsonValue, SampleProfile


@dataclass(frozen=True)
class SampleRecord:
    logical_id: str
    module_key: str
    actor_key: ActorKey  # the owning department
    data: dict[str, JsonValue]
    creator_key: str  # the person who creates the record
    assignee_key: str  # the person in "Assigned to"


@dataclass(frozen=True)
class SampleEdge:
    relationship_id: str
    source_record_id: str
    target_record_id: str
    creator_key: str = ""  # legacy hand-authored edges use the child's creator


@dataclass(frozen=True)
class NamedFieldCheck:
    logical_record_id: str
    field_key: str
    expected_key: str


@dataclass(frozen=True)
class NamedRelationshipCheck:
    relationship_key: str
    source_record_id: str
    target_record_id: str


@dataclass(frozen=True)
class NamedCalculationCheck:
    expected_key: str
    operator: str
    operand_keys: tuple[str, ...]


@dataclass(frozen=True)
class NamedScenario:
    key: str
    name: str
    record_ids: tuple[str, ...]
    expected: dict[str, JsonValue]
    field_checks: tuple[NamedFieldCheck, ...] = ()
    relationship_checks: tuple[NamedRelationshipCheck, ...] = ()
    calculation_checks: tuple[NamedCalculationCheck, ...] = ()


@dataclass(frozen=True)
class SampleTestVector:
    key: str
    module_key: str
    event: dict[str, object]
    values: dict[str, JsonValue]
    trigger_ids: tuple[str, ...]


@dataclass(frozen=True)
class SampleDataset:
    organization: OrganizationPack
    profile: SampleProfile
    seed: int
    anchor_date: date
    document: dict[str, object]
    module_counts: dict[str, int]
    department_ids: dict[str, str]
    module_ids: dict[str, str]
    field_ids: dict[str, dict[str, str]]
    relationship_ids: dict[str, str]
    trigger_ids: dict[str, str]
    records: tuple[SampleRecord, ...]
    edges: tuple[SampleEdge, ...]
    test_vectors: tuple[SampleTestVector, ...]
    named_scenarios: tuple[NamedScenario, ...]


def _field_config(
    field: FieldSpec,
    seed: int,
    anchor: date,
    module_key: str,
    organization: OrganizationPack,
) -> dict[str, object]:
    kind = {
        "Text": "text",
        "Long text": "long-text",
        "Number": "number",
        "Integer": "integer",
        "Date": "date",
        "Date/Time": "datetime",
        "Checkbox": "checkbox",
        "Select": "select",
        "Email": "email",
        "URL": "url",
        "User": "user",
    }[field.type]
    config: dict[str, object] = {"kind": kind}
    if field.has_default:
        config["defaultValue"] = (
            _option_id(seed, module_key, field.key, cast(str, field.default_value), organization)
            if field.type == "Select"
            else field.default_value
        )
    if field.type == "Select":
        config["options"] = [
            {
                "id": _option_id(seed, module_key, field.key, label, organization),
                "label": label,
            }
            for label in field.options
        ]
    if field.type in {"Number", "Integer"}:
        if field.minimum is not None:
            config["min"] = field.minimum
        if field.maximum is not None:
            config["max"] = field.maximum
        if field.step is not None:
            config["step"] = field.step
    if field.type in {"Date", "Date/Time"} and field.value_kind != "birth_date":
        earliest, latest = anchor - timedelta(days=365), anchor + timedelta(days=90)
        if field.type == "Date":
            config.update({"earliest": earliest.isoformat(), "latest": latest.isoformat()})
        else:
            config.update(
                {
                    "earliest": datetime.combine(
                        earliest, time.min, ZoneInfo(organization.identity.timezone)
                    ).isoformat(timespec="minutes"),
                    "latest": datetime.combine(
                        latest, time(23, 59), ZoneInfo(organization.identity.timezone)
                    ).isoformat(timespec="minutes"),
                }
            )
    return config


def _build_document(
    seed: int, anchor: date, organization: OrganizationPack
) -> tuple[dict[str, object], dict[str, object]]:
    departments = organization.catalog.departments
    modules = organization.catalog.modules
    relationships = organization.catalog.relationships
    department_ids = {key: _doc_id(seed, "department", key, organization) for key, _ in departments}
    module_ids = {
        module.key: _doc_id(seed, "module", module.key, organization) for module in modules
    }
    field_ids = {
        module.key: {
            field.key: _doc_id(seed, "field", f"{module.key}:{field.key}", organization)
            for field in module.fields
        }
        for module in modules
    }
    relationship_ids = {
        item.key: _doc_id(seed, "relationship", item.key, organization) for item in relationships
    }
    department_documents = [
        {"id": department_ids[key], "name": name, "closed": False} for key, name in departments
    ]
    module_documents = []
    for module in modules:
        module_documents.append(
            {
                "id": module_ids[module.key],
                "departmentId": department_ids[module.department],
                "name": module.name,
                "closed": False,
                "titleFieldId": field_ids[module.key]["name"],
                "fields": [
                    {
                        "id": field_ids[module.key][field.key],
                        "name": field.name,
                        "type": field.type,
                        "required": field.required,
                        "closed": False,
                        "config": _field_config(field, seed, anchor, module.key, organization),
                    }
                    for field in module.fields
                ],
            }
        )
    relationship_documents = [
        {
            "id": relationship_ids[item.key],
            "name": item.name,
            "sourceModuleId": module_ids[item.source],
            "targetModuleId": module_ids[item.target],
            "cardinality": item.cardinality,
            "fieldMappings": [],
        }
        for item in relationships
    ]
    layout: dict[str, dict[str, int]] = {}
    for index, (key, _name) in enumerate(departments):
        department_x, department_y = 24 + (index % 3) * 760, 24 + (index // 3) * 480
        layout[department_ids[key]] = {
            "x": department_x,
            "y": department_y,
            "width": 720,
            "height": 440,
        }
        children = [module for module in modules if module.department == key]
        for child_index, module in enumerate(children):
            layout[module_ids[module.key]] = {
                "x": department_x + 24 + (child_index % 2) * 336,
                "y": department_y + 64 + (child_index // 2) * 176,
                "width": 320,
                "height": 152,
            }
    maps: dict[str, object] = {
        "department_ids": department_ids,
        "module_ids": module_ids,
        "field_ids": field_ids,
        "relationship_ids": relationship_ids,
    }
    payload = {
        "kind": "openslate-sandbox",
        "schemaVersion": 4,
        "design": {
            "departments": department_documents,
            "modules": module_documents,
            "relationships": relationship_documents,
            "layout": layout,
        },
        "triggers": organization.generators.build_triggers(
            organization, seed, module_ids, field_ids
        ),
        "scenarios": [],
    }
    parsed = SandboxDocument.model_validate(payload)
    issues = validate_document(parsed)
    if issues:
        raise ValueError(f"Generated Sandbox document is invalid: {issues[0].code}")
    return parsed.model_dump(by_alias=True, mode="json", exclude_none=True), maps


def _option_id(
    seed: int,
    module_key: str,
    field_key: str,
    label: str,
    organization: OrganizationPack | None = None,
) -> str:
    return _doc_id(seed, "option", f"{module_key}:{field_key}:{label}", organization)


def _build_test_vectors(
    seed: int,
    module_ids: dict[str, str],
    field_ids: dict[str, dict[str, str]],
    records: tuple[SampleRecord, ...],
    document: dict[str, object],
    trigger_ids: dict[str, str],
) -> tuple[SampleTestVector, ...]:
    parsed = SandboxDocument.model_validate(document)
    modules_by_id = {module.id: module for module in parsed.design.modules}
    records_by_module: dict[str, SampleRecord] = {}
    for record in records:
        records_by_module.setdefault(record.module_key, record)
    module_keys = {module_id: key for key, module_id in module_ids.items()}
    trigger_keys = {trigger_id: key for key, trigger_id in trigger_ids.items()}
    vectors = []
    for trigger in parsed.triggers:
        event = trigger.trigger
        module_key = module_keys[event.module_id]
        record = records_by_module[module_key]
        values = dict(record.data)
        values.pop(field_ids[module_key]["owner"], None)
        fields = {field.id: field for field in modules_by_id[event.module_id].fields}
        conditions = trigger.condition_group.conditions
        if trigger.condition_group.operator == "any":
            conditions = conditions[:1]
        for condition in conditions:
            if condition.value.kind == "literal":
                values[condition.field.field_id] = condition.value.value
        if event.kind == "record-created":
            test_event: dict[str, object] = {"kind": event.kind}
        elif event.kind == "schedule":
            test_event = {"kind": event.kind, "frequency": event.frequency, "time": event.time}
            if event.weekday is not None:
                test_event["weekday"] = event.weekday
        elif event.kind == "field-changed":
            field_id = event.field_id
            field = fields[field_id]
            current = values.get(field_id)
            previous: JsonValue = None
            if field.type in {"Number", "Integer"} and isinstance(current, (int, float)):
                previous = current - 1
            elif field.type == "Checkbox" and isinstance(current, bool):
                previous = not current
            elif field.type == "Select" and isinstance(field.config, SelectFieldConfig):
                previous = next(
                    (option.id for option in field.config.options if option.id != current), None
                )
            test_event = {"kind": event.kind, "fieldId": field_id, "previousValue": previous}
        else:
            field_id = event.field_id
            if event.value.kind != "literal" or not isinstance(event.value.value, (int, float)):
                raise ValueError("Sample trigger vectors require numeric literal thresholds")
            threshold = event.value.value
            if event.operator == ">":
                previous, current = threshold, threshold + 1
            elif event.operator == ">=":
                previous, current = threshold - 1, threshold
            elif event.operator == "<":
                previous, current = threshold, threshold - 1
            elif event.operator == "<=":
                previous, current = threshold + 1, threshold
            elif event.operator == "=":
                previous, current = threshold + 1, threshold
            else:
                previous, current = threshold, threshold + 1
            values[field_id] = current
            test_event = {"kind": event.kind, "fieldId": field_id, "previousValue": previous}
        key = trigger_keys[trigger.id]
        vectors.append(SampleTestVector(key, module_key, test_event, values, (trigger.id,)))
    return tuple(vectors)


def build_document(
    seed: int = 42,
    anchor_date: date | None = None,
    organization: OrganizationPack | None = None,
) -> dict[str, object]:
    """Build a UI-authorable Sandbox v4 design with deterministic IDs."""
    pack = organization or default_pack()
    return _build_document(seed, _anchor(anchor_date, pack), pack)[0]
