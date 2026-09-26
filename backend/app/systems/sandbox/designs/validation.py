"""Pure semantic validation for the portable Sandbox design document."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from app.systems.sandbox.designs.field_validation import (
    DocumentValueError,
    validate_value,
)
from app.systems.sandbox.designs.mapping_validation import field_metadata, fields_compatible
from app.systems.sandbox.designs.schemas import (
    AutomationValue,
    DesignField,
    FieldMapping,
    FieldReference,
    ModuleDocument,
    RelationshipDocument,
    SandboxDocument,
    ScenarioLink,
    ValidationIssue,
)


@dataclass(slots=True)
class _ValidationIndexes:
    modules: dict[str, ModuleDocument]
    fields: dict[str, set[str]]
    relationships: dict[str, RelationshipDocument]
    first_modules: dict[str, ModuleDocument]
    first_fields: dict[tuple[str, str], DesignField]
    first_relationships: dict[str, RelationshipDocument]


def _build_indexes(document: SandboxDocument) -> _ValidationIndexes:
    modules = {item.id: item for item in document.design.modules}
    fields = {item.id: {field.id for field in item.fields} for item in document.design.modules}
    relationships = {item.id: item for item in document.design.relationships}
    first_modules: dict[str, ModuleDocument] = {}
    first_fields: dict[tuple[str, str], DesignField] = {}
    for module in document.design.modules:
        if module.id not in first_modules:
            first_modules[module.id] = module
            for field in module.fields:
                first_fields.setdefault((module.id, field.id), field)
    first_relationships: dict[str, RelationshipDocument] = {}
    for relationship in document.design.relationships:
        first_relationships.setdefault(relationship.id, relationship)
    return _ValidationIndexes(
        modules, fields, relationships, first_modules, first_fields, first_relationships
    )


def validate_document(document: SandboxDocument | dict[str, object]) -> list[ValidationIssue]:
    """Return repairable semantic errors after strict schema validation."""

    parsed = document
    if not isinstance(parsed, SandboxDocument):
        parsed = SandboxDocument.model_validate(parsed)
    indexes = _build_indexes(parsed)
    issues: list[ValidationIssue] = []
    departments = {item.id for item in parsed.design.departments}
    for module in parsed.design.modules:
        if module.department_id not in departments:
            issues.append(
                _issue("module.department_missing", "Module department does not exist", module.id)
            )
    for relationship in parsed.design.relationships:
        source_fields = indexes.fields.get(relationship.source_module_id, set())
        target_fields = indexes.fields.get(relationship.target_module_id, set())
        if relationship.source_module_id not in indexes.modules:
            issues.append(
                _issue(
                    "relationship.source_module_missing",
                    "Relationship source module does not exist",
                    relationship.id,
                )
            )
        if relationship.target_module_id not in indexes.modules:
            issues.append(
                _issue(
                    "relationship.target_module_missing",
                    "Relationship target module does not exist",
                    relationship.id,
                )
            )
        for mapping in relationship.field_mappings:
            if mapping.source_field_id not in source_fields:
                issues.append(
                    _issue(
                        "relationship.source_field_missing",
                        "Relationship mapping source field does not exist on its source module",
                        relationship.id,
                    )
                )
            if mapping.target_field_id not in target_fields:
                issues.append(
                    _issue(
                        "relationship.target_field_missing",
                        "Relationship mapping target field does not exist on its target module",
                        relationship.id,
                    )
                )
            elif mapping.source_field_id in source_fields:
                _validate_mapping(indexes, relationship.id, mapping, issues)
        _validate_duplicate_mappings(relationship.id, relationship.field_mappings, issues)
    for entity_id in {*departments, *indexes.modules} - set(parsed.design.layout):
        issues.append(
            _issue(
                "layout.entity_missing",
                "Layout is required for every department and module",
                entity_id,
            )
        )
    for entity_id in parsed.design.layout:
        if entity_id not in departments and entity_id not in indexes.modules:
            issues.append(
                _issue(
                    "layout.entity_missing",
                    "Layout references an unknown department or module",
                    entity_id,
                )
            )
    _validate_duplicate_ids(parsed, issues)
    _validate_relationship_pairs(parsed, issues)
    _validate_automations(parsed, indexes, issues)
    _validate_scenarios(parsed, indexes, issues)
    return issues


def _issue(code: str, message: str, target_id: str) -> ValidationIssue:
    return ValidationIssue(code=code, message=message, target_id=target_id)


def _validate_duplicate_ids(document: SandboxDocument, issues: list[ValidationIssue]) -> None:
    groups = (
        ("department", [item.id for item in document.design.departments]),
        ("module", [item.id for item in document.design.modules]),
        ("relationship", [item.id for item in document.design.relationships]),
        ("automation", [item.id for item in document.automations]),
        ("scenario", [item.id for item in document.scenarios]),
    )
    for kind, values in groups:
        for duplicate in sorted(value for value, count in Counter(values).items() if count > 1):
            issues.append(_issue(f"{kind}.id_duplicate", f"Duplicate {kind} ID", duplicate))
    for module in document.design.modules:
        values = [field.id for field in module.fields]
        for _duplicate in sorted(value for value, count in Counter(values).items() if count > 1):
            issues.append(_issue("field.id_duplicate", "Duplicate field ID", module.id))


def _field(indexes: _ValidationIndexes, module_id: str, field_id: str) -> DesignField | None:
    return indexes.first_fields.get((module_id, field_id))


def _validate_mapping(
    indexes: _ValidationIndexes,
    relationship_id: str,
    mapping: FieldMapping,
    issues: list[ValidationIssue],
) -> None:
    relationship = indexes.first_relationships[relationship_id]
    source = _field(indexes, relationship.source_module_id, mapping.source_field_id)
    target = _field(indexes, relationship.target_module_id, mapping.target_field_id)
    if source is None or target is None:
        return
    if source.closed or target.closed:
        issues.append(
            _issue(
                "relationship.mapping_field_closed",
                "Relationship mappings cannot use closed fields",
                relationship_id,
            )
        )
        return
    if not fields_compatible(source, target):
        issues.append(
            _issue(
                "relationship.mapping_incompatible",
                "Relationship mapping field types are incompatible",
                relationship_id,
            )
        )


def _validate_duplicate_mappings(
    relationship_id: str, mappings: list[FieldMapping], issues: list[ValidationIssue]
) -> None:
    pairs: set[tuple[str, str]] = set()
    for mapping in mappings:
        pair = (mapping.source_field_id, mapping.target_field_id)
        if pair in pairs:
            issues.append(
                _issue(
                    "relationship.mapping_duplicate",
                    "Duplicate relationship field mapping",
                    relationship_id,
                )
            )
        pairs.add(pair)


def _validate_relationship_pairs(document: SandboxDocument, issues: list[ValidationIssue]) -> None:
    for relationship in document.design.relationships:
        if relationship.source_module_id == relationship.target_module_id:
            issues.append(
                _issue(
                    "relationship.self_link",
                    "A relationship cannot link a module to itself",
                    relationship.id,
                )
            )


def _validate_reference(
    indexes: _ValidationIndexes,
    reference: FieldReference,
    target_id: str,
    issues: list[ValidationIssue],
) -> None:
    module = indexes.first_modules.get(reference.module_id)
    if module is None:
        issues.append(
            _issue("automation.module_missing", "Automation references a missing module", target_id)
        )
        return
    field = _field(indexes, reference.module_id, reference.field_id)
    if field is None:
        issues.append(
            _issue("automation.field_missing", "Automation references a missing field", target_id)
        )
    elif module.closed or field.closed:
        issues.append(
            _issue(
                "automation.reference_closed", "Automation references a closed entity", target_id
            )
        )
    if reference.relationship_id is not None:
        relationship = indexes.first_relationships.get(reference.relationship_id)
        if relationship is None:
            issues.append(
                _issue(
                    "automation.relationship_missing",
                    "Automation references a missing relationship",
                    target_id,
                )
            )
        elif reference.module_id not in {
            relationship.source_module_id,
            relationship.target_module_id,
        }:
            issues.append(
                _issue(
                    "automation.relationship_module_mismatch",
                    "Automation relationship does not connect its referenced module",
                    target_id,
                )
            )


def _validate_value_reference(
    indexes: _ValidationIndexes,
    value: AutomationValue,
    target_id: str,
    issues: list[ValidationIssue],
) -> None:
    if value.kind == "field-reference":
        _validate_reference(indexes, value, target_id, issues)


def _validate_value_for_field(
    indexes: _ValidationIndexes,
    value: AutomationValue,
    target: DesignField | None,
    target_id: str,
    issues: list[ValidationIssue],
) -> None:
    if target is None:
        return
    if value.kind == "literal":
        if not _value_matches_field(target, value.value):
            issues.append(
                _issue(
                    "automation.value_type_invalid",
                    "Automation value does not match its target field type",
                    target_id,
                )
            )
        return
    _validate_value_reference(indexes, value, target_id, issues)
    source = _field(indexes, value.module_id, value.field_id)
    if source is not None and not fields_compatible(source, target):
        issues.append(
            _issue(
                "automation.value_type_invalid",
                "Automation field reference is incompatible with its target field",
                target_id,
            )
        )


def _validate_automations(
    document: SandboxDocument,
    indexes: _ValidationIndexes,
    issues: list[ValidationIssue],
) -> None:
    for automation in document.automations:
        trigger = automation.trigger
        if trigger.kind == "record-created" or trigger.kind == "schedule":
            if trigger.module_id not in indexes.modules:
                issues.append(
                    _issue(
                        "automation.module_missing",
                        "Automation references a missing module",
                        automation.id,
                    )
                )
        else:
            _validate_reference(
                indexes,
                FieldReference(module_id=trigger.module_id, field_id=trigger.field_id),
                automation.id,
                issues,
            )
        if trigger.kind == "threshold-crossed":
            _validate_value_for_field(
                indexes,
                trigger.value,
                _field(indexes, trigger.module_id, trigger.field_id),
                automation.id,
                issues,
            )
        for condition in automation.condition_group.conditions:
            _validate_reference(indexes, condition.field, automation.id, issues)
            _validate_value_for_field(
                indexes,
                condition.value,
                _field(indexes, condition.field.module_id, condition.field.field_id),
                automation.id,
                issues,
            )
        for action in automation.actions:
            if action.kind == "set-field":
                _validate_reference(indexes, action.target, automation.id, issues)
                _validate_value_for_field(
                    indexes,
                    action.value,
                    _field(indexes, action.target.module_id, action.target.field_id),
                    automation.id,
                    issues,
                )
            elif action.kind == "create-record":
                module = indexes.first_modules.get(action.module_id)
                if module is None or module.closed:
                    issues.append(
                        _issue(
                            "automation.module_missing",
                            "Automation action references a missing or closed module",
                            automation.id,
                        )
                    )
                for value in action.values:
                    field = _field(indexes, action.module_id, value.field_id)
                    if field is None or field.closed:
                        issues.append(
                            _issue(
                                "automation.field_missing",
                                "Automation action references a missing or closed field",
                                automation.id,
                            )
                        )
                    _validate_value_for_field(
                        indexes,
                        value.value,
                        field,
                        automation.id,
                        issues,
                    )


def _validate_scenarios(
    document: SandboxDocument,
    indexes: _ValidationIndexes,
    issues: list[ValidationIssue],
) -> None:
    for scenario in document.scenarios:
        records = {record.id: record for record in scenario.records}
        if len(records) != len(scenario.records):
            issues.append(
                _issue("scenario.record_id_duplicate", "Duplicate scenario record ID", scenario.id)
            )
        for record in scenario.records:
            module = indexes.modules.get(record.module_id)
            if module is None or module.closed:
                issues.append(
                    _issue(
                        "scenario.module_missing",
                        "Scenario record references a missing or closed module",
                        scenario.id,
                    )
                )
            for field_id in record.values:
                field = _field(indexes, record.module_id, field_id)
                if field is None or field.closed:
                    issues.append(
                        _issue(
                            "scenario.field_missing",
                            "Scenario value references a missing or closed field",
                            scenario.id,
                        )
                    )
                elif not _value_matches_field(field, record.values[field_id]):
                    issues.append(
                        _issue(
                            "scenario.value_type_invalid",
                            "Scenario value does not match its field type",
                            scenario.id,
                        )
                    )
        seen_links: set[tuple[str, str, str]] = set()
        links_by_relationship: dict[str, list[ScenarioLink]] = {}
        for link in scenario.links:
            links_by_relationship.setdefault(link.relationship_id, []).append(link)
            relationship = indexes.relationships.get(link.relationship_id)
            source = records.get(link.source_record_id)
            target = records.get(link.target_record_id)
            key = (link.relationship_id, link.source_record_id, link.target_record_id)
            if key in seen_links:
                issues.append(
                    _issue(
                        "scenario.link_duplicate",
                        "Duplicate scenario relationship link",
                        scenario.id,
                    )
                )
            seen_links.add(key)
            if relationship is None or source is None or target is None:
                issues.append(
                    _issue(
                        "scenario.link_missing_reference",
                        "Scenario link references a missing entity",
                        scenario.id,
                    )
                )
            elif (
                source.module_id != relationship.source_module_id
                or target.module_id != relationship.target_module_id
            ):
                issues.append(
                    _issue(
                        "scenario.link_module_mismatch",
                        "Scenario link does not match relationship modules",
                        scenario.id,
                    )
                )
        _validate_link_cardinality(
            scenario.id, links_by_relationship, indexes.relationships, issues
        )


def _value_matches_field(field: DesignField, value: object) -> bool:
    if value is not None and not isinstance(value, (str, int, float, bool)):
        return False
    try:
        validate_value(value, field_metadata(field))
    except DocumentValueError:
        return False
    return True


def _validate_link_cardinality(
    scenario_id: str,
    links_by_relationship: dict[str, list[ScenarioLink]],
    relationships: dict[str, RelationshipDocument],
    issues: list[ValidationIssue],
) -> None:
    for relationship_id, relationship in relationships.items():
        relevant = links_by_relationship.get(relationship_id, [])
        sources = [link.source_record_id for link in relevant]
        targets = [link.target_record_id for link in relevant]
        if relationship.cardinality == "one-to-one" and (
            len(sources) != len(set(sources)) or len(targets) != len(set(targets))
        ):
            issues.append(
                _issue(
                    "scenario.cardinality_invalid",
                    "Scenario links violate one-to-one cardinality",
                    scenario_id,
                )
            )
        if relationship.cardinality == "one-to-many" and len(targets) != len(set(targets)):
            issues.append(
                _issue(
                    "scenario.cardinality_invalid",
                    "Scenario links violate one-to-many cardinality",
                    scenario_id,
                )
            )
