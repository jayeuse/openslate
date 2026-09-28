"""Adapters between Designer field schema objects and portable mapping rules."""

from app.systems.sandbox.designs.field_validation import (
    DocumentValueError,
    FieldMetadata,
    validate_mapping,
)
from app.systems.sandbox.designs.schemas import (
    DesignField,
    ModuleDocument,
    SelectFieldConfig,
    TextFieldConfig,
    ValidationIssue,
)


def title_field_issue(module: ModuleDocument) -> ValidationIssue | None:
    if module.title_field_id is None:
        return None
    selected = next((field for field in module.fields if field.id == module.title_field_id), None)
    if selected is not None and selected.type in {
        "Text", "Long text", "Email", "URL", "Integer", "Number", "Select"
    } and (not selected.closed or module.closed):
        return None
    return ValidationIssue(
        code="module.title_field_invalid",
        message="Choose an active title field in this module",
        target_id=module.id,
    )


def fields_compatible(source: DesignField, target: DesignField) -> bool:
    try:
        validate_mapping(field_metadata(source), field_metadata(target), "relationship")
    except DocumentValueError:
        return False
    return True


def field_metadata(field: DesignField) -> FieldMetadata:
    config = field.config
    return FieldMetadata(
        config_kind=config.kind,
        required=field.required,
        closed=field.closed,
        select_options=(
            frozenset(option.id for option in config.options)
            if isinstance(config, SelectFieldConfig)
            else frozenset()
        ),
        select_labels=(
            frozenset(option.label for option in config.options)
            if isinstance(config, SelectFieldConfig)
            else frozenset()
        ),
        max_length=config.max_length if isinstance(config, TextFieldConfig) else None,
        minimum=config.minimum if config.kind in {"number", "integer"} else None,
        maximum=config.maximum if config.kind in {"number", "integer"} else None,
        step=config.step if config.kind in {"number", "integer"} else None,
        earliest=config.earliest if config.kind in {"date", "datetime"} else None,
        latest=config.latest if config.kind in {"date", "datetime"} else None,
    )
