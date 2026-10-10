"""Lossless live/name query and widget codecs; no authority, locks or writes."""

from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError

from app.systems.boards.portability_schemas import (
    PortableAggregateConfig,
    PortableChartConfig,
    PortableDateQuery,
    PortableFieldReference,
    PortableGroupedQuery,
    PortableQueryFilter,
    PortableRecordsConfig,
    PortableRecordsQuery,
    PortableWidgetConfig,
)
from app.systems.boards.widget_schemas import BoardInlineConfig, BoardWidgetConfig
from app.systems.openview.dashboards.schemas import (
    DashboardAggregateConfig,
    DashboardChartConfig,
    DashboardRecordsConfig,
    DashboardRecordsQuery,
)
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.query import comparison_value
from app.systems.sandbox.records.query_schemas import (
    SEARCHABLE_FIELD_TYPES,
    DateSeriesAggregateQuery,
    FieldReference,
    GroupedAggregateSnapshotQuery,
    QueryFilter,
    Scalar,
)

LiveQuery = GroupedAggregateSnapshotQuery | DateSeriesAggregateQuery | DashboardRecordsQuery
PortableQuery = PortableGroupedQuery | PortableDateQuery | PortableRecordsQuery
PortableConfig = (
    PortableWidgetConfig | PortableChartConfig | PortableAggregateConfig | PortableRecordsConfig
)


class PortabilityError(ValueError):
    """Safe domain rejection; the caller maps the code to its route-local HTTP shape."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        self.message = message
        super().__init__(message or code)


def _field_reference(
    reference: PortableFieldReference, module_id: UUID, fields: dict[tuple[UUID, str], Field]
) -> FieldReference:
    field = fields.get((module_id, reference.name))
    if field is None or field.type != reference.expected_type:
        raise PortabilityError("board_source_unavailable")
    return FieldReference(field_id=field.id, expected_type=reference.expected_type)


def _select_option_labels(field: Field) -> dict[str, str]:
    options = field.config.get("options")
    if not isinstance(options, list) or not options:
        raise PortabilityError("board_source_unavailable")
    labels: dict[str, str] = {}
    for option in options:
        if not isinstance(option, dict) or set(option) != {"id", "label"}:
            raise PortabilityError("board_source_unavailable")
        option_id, label = option["id"], option["label"]
        if not isinstance(option_id, str) or not isinstance(label, str):
            raise PortabilityError("board_source_unavailable")
        if option_id in labels or label in labels.values():
            raise PortabilityError("board_source_unavailable")
        labels[option_id] = label
    return labels


def _map_select_value(
    value: Scalar | list[Scalar] | None, options: dict[str, str]
) -> str | list[str] | None:
    if value is None:
        return None
    values = value if isinstance(value, list) else [value]
    mapped: list[str] = []
    for item in values:
        if not isinstance(item, str) or item not in options:
            raise PortabilityError("board_source_unavailable")
        mapped.append(options[item])
    return mapped if isinstance(value, list) else mapped[0]


def select_filter_labels(
    field: Field, value: Scalar | list[Scalar] | None
) -> str | list[str] | None:
    """Export a live select predicate by portable labels, never installation IDs."""

    return _map_select_value(value, _select_option_labels(field))


def _select_filter_ids(field: Field, value: Scalar | list[Scalar] | None) -> str | list[str] | None:
    labels = _select_option_labels(field)
    return _map_select_value(value, {label: option_id for option_id, label in labels.items()})


def reject_nonportable_person_filter(field: Field, value: Scalar | list[Scalar] | None) -> None:
    if field.type == FieldType.USER and value is not None:
        raise PortabilityError(
            "board_bundle_invalid",
            "Person filter values cannot be transferred in a Board bundle",
        )


def _filter(
    reference: PortableQueryFilter, module_id: UUID, fields: dict[tuple[UUID, str], Field]
) -> QueryFilter:
    field = fields.get((module_id, reference.name))
    if field is None or field.type != reference.expected_type:
        raise PortabilityError("board_source_unavailable")
    reject_nonportable_person_filter(field, reference.value)
    try:
        value = (
            _select_filter_ids(field, reference.value)
            if field.type == FieldType.SELECT
            else reference.value
        )
        predicate = QueryFilter(
            field_id=field.id,
            expected_type=reference.expected_type,
            operator=reference.operator,
            value=value,
        )
        comparison_value(field, predicate)
    except (HTTPException, ValidationError, ValueError) as error:
        raise PortabilityError("board_source_unavailable") from error
    return predicate


def _portable_reference(
    reference: FieldReference, module_id: UUID, fields: dict[UUID, Field]
) -> PortableFieldReference:
    field = fields.get(reference.field_id)
    if (
        field is None
        or (field.is_deleted or field.deleted_at is not None)
        or field.module_id != module_id
        or field.type != reference.expected_type
    ):
        raise PortabilityError("board_source_unavailable")
    return PortableFieldReference(name=field.name, expected_type=field.type)


def _portable_predicate(
    predicate: QueryFilter, module_id: UUID, fields: dict[UUID, Field]
) -> PortableQueryFilter:
    reference = _portable_reference(predicate, module_id, fields)
    field = fields[predicate.field_id]
    reject_nonportable_person_filter(field, predicate.value)
    try:
        comparison_value(field, predicate)
        value = (
            select_filter_labels(field, predicate.value)
            if field.type == FieldType.SELECT
            else predicate.value
        )
        return PortableQueryFilter(
            **reference.model_dump(), operator=predicate.operator, value=value
        )
    except (HTTPException, ValidationError, ValueError) as error:
        raise PortabilityError("board_source_unavailable") from error


def portable_query(query: LiveQuery, fields: dict[UUID, Field]) -> PortableQuery:
    """Translate only typed query positions; business values and order stay intact."""

    document = query.model_dump(mode="python", exclude={"module_id"})
    definition = document["definition"]
    for key in ("columns", "search_fields"):
        definition[key] = [
            _portable_reference(ref, query.module_id, fields).model_dump()
            for ref in getattr(query.definition, key)
        ]
    definition["filters"] = [
        _portable_predicate(ref, query.module_id, fields).model_dump()
        for ref in query.definition.filters
    ]
    definition["sort"] = [
        {
            **_portable_reference(ref, query.module_id, fields).model_dump(),
            "direction": ref.direction.value,
        }
        for ref in query.definition.sort
    ]
    if not isinstance(query, DashboardRecordsQuery):
        for key in ("measure", "date_field"):
            ref = getattr(query, key)
            if ref is not None:
                document[key] = _portable_reference(ref, query.module_id, fields).model_dump()
        if isinstance(query, GroupedAggregateSnapshotQuery):
            document["dimension"] = _portable_reference(
                query.dimension, query.module_id, fields
            ).model_dump()
    schema = (
        PortableRecordsQuery
        if isinstance(query, DashboardRecordsQuery)
        else PortableGroupedQuery
        if isinstance(query, GroupedAggregateSnapshotQuery)
        else PortableDateQuery
    )
    return schema.model_validate(document)


def query_references(query: PortableQuery) -> list[PortableFieldReference]:
    definition = query.definition
    references: list[PortableFieldReference] = [
        *definition.columns,
        *definition.filters,
        *definition.sort,
        *definition.search_fields,
    ]
    if not isinstance(query, PortableRecordsQuery):
        references.extend(ref for ref in (query.measure, query.date_field) if ref is not None)
        if isinstance(query, PortableGroupedQuery):
            references.append(query.dimension)
    return references


def _resolved_query(
    query: PortableQuery, module_id: UUID, fields: dict[tuple[UUID, str], Field]
) -> LiveQuery:
    document = query.model_dump(mode="python")
    document["module_id"] = module_id
    definition = document["definition"]
    for key in ("columns", "search_fields"):
        definition[key] = [
            _field_reference(ref, module_id, fields).model_dump()
            for ref in getattr(query.definition, key)
        ]
    if any(
        ref.expected_type not in SEARCHABLE_FIELD_TYPES for ref in query.definition.search_fields
    ):
        raise PortabilityError("board_source_unavailable")
    definition["filters"] = [
        _filter(ref, module_id, fields).model_dump() for ref in query.definition.filters
    ]
    definition["sort"] = [
        {**_field_reference(ref, module_id, fields).model_dump(), "direction": ref.direction}
        for ref in query.definition.sort
    ]
    if not isinstance(query, PortableRecordsQuery):
        for key in ("measure", "date_field"):
            ref = getattr(query, key)
            if ref is not None:
                document[key] = _field_reference(ref, module_id, fields).model_dump()
        if isinstance(query, PortableGroupedQuery):
            document["dimension"] = _field_reference(
                query.dimension, module_id, fields
            ).model_dump()
    schema = (
        DashboardRecordsQuery
        if isinstance(query, PortableRecordsQuery)
        else GroupedAggregateSnapshotQuery
        if isinstance(query, PortableGroupedQuery)
        else DateSeriesAggregateQuery
    )
    return schema.model_validate(document)


def portable_config(
    config: BoardInlineConfig,
    module_id: UUID,
    fields: dict[UUID, Field],
    size: str,
    pinned: bool,
) -> PortableConfig:
    """Export legacy instructions or complete normalized queries with presentation."""
    if isinstance(config, BoardWidgetConfig):
        return PortableWidgetConfig(
            fields=[_portable_reference(ref, module_id, fields) for ref in config.fields],
            filters=[_portable_predicate(ref, module_id, fields) for ref in config.filters],
            logic=config.logic,
            aggregation=config.aggregation,
            metric=_portable_reference(config.metric, module_id, fields) if config.metric else None,
            visualization=config.visualization,
            size=size,
            refresh=config.refresh,
            pinned=pinned,
        )
    document = config.model_dump(mode="python", exclude={"query"})
    document.update(
        query=portable_query(config.query, fields), size=size, pinned=pinned, refresh="manual"
    )
    schema = (
        PortableChartConfig
        if isinstance(config, DashboardChartConfig)
        else PortableAggregateConfig
        if isinstance(config, DashboardAggregateConfig)
        else PortableRecordsConfig
    )
    return schema.model_validate(document)


def inline_config(
    config: PortableConfig, module_id: UUID, fields: dict[tuple[UUID, str], Field]
) -> BoardInlineConfig:
    """Resolve names into the existing inline DTO without layout or refresh storage."""
    if isinstance(config, PortableWidgetConfig):
        return BoardWidgetConfig(
            fields=[_field_reference(ref, module_id, fields) for ref in config.fields],
            filters=[_filter(ref, module_id, fields) for ref in config.filters],
            logic=config.logic,
            aggregation=config.aggregation,
            metric=_field_reference(config.metric, module_id, fields) if config.metric else None,
            visualization=config.visualization,
        )
    document = config.model_dump(exclude={"size", "refresh", "pinned", "query"})
    document["query"] = _resolved_query(config.query, module_id, fields)
    schema = (
        DashboardChartConfig
        if isinstance(config, PortableChartConfig)
        else DashboardAggregateConfig
        if isinstance(config, PortableAggregateConfig)
        else DashboardRecordsConfig
    )
    return schema.model_validate(document)
