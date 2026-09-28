"""Lookup indexes used while validating one portable Sandbox document."""

from dataclasses import dataclass

from app.systems.sandbox.designs.schemas import (
    DesignField,
    ModuleDocument,
    RelationshipDocument,
    SandboxDocument,
)


@dataclass(slots=True)
class ValidationIndexes:
    modules: dict[str, ModuleDocument]
    fields: dict[str, set[str]]
    relationships: dict[str, RelationshipDocument]
    first_modules: dict[str, ModuleDocument]
    first_fields: dict[tuple[str, str], DesignField]
    first_relationships: dict[str, RelationshipDocument]


def build_indexes(document: SandboxDocument) -> ValidationIndexes:
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
    return ValidationIndexes(
        modules, fields, relationships, first_modules, first_fields, first_relationships
    )
