"""Server-side categorical aggregates and complete calendar date series."""

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from sqlalchemy import Date, Engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.policy.checks import module_hidden
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.aggregate_buckets import calendar_buckets, sql_bucket_start
from app.systems.sandbox.records.display import FieldDisplayResolver
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query import (
    compile_query,
    field_expression,
    validate_definition,
)
from app.systems.sandbox.records.query_schemas import (
    MAX_AGGREGATE_SNAPSHOT_BUCKETS,
    MAX_AGGREGATE_SNAPSHOT_BYTES,
    AggregateDatum,
    AggregatePaginationMetadata,
    AggregateResponse,
    AggregateSnapshotPaginationMetadata,
    AggregateSnapshotQuery,
    AggregateSnapshotResponse,
    AggregateSnapshotsRequest,
    AggregateSnapshotsResponse,
    DateSeriesAggregateQuery,
    FieldReference,
    GroupedAggregateQuery,
    GroupedAggregateSnapshotQuery,
)


def _workspace_timezone(db: Session, org_id: UUID) -> tuple[str, ZoneInfo]:
    timezone_name = db.scalars(
        select(WorkspaceProfile.timezone).where(WorkspaceProfile.id == org_id)
    ).one_or_none()
    if not timezone_name:
        raise HTTPException(503, detail="Workspace configuration is unavailable")
    try:
        return timezone_name, ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise HTTPException(503, detail="Workspace timezone is unavailable") from error


def _workspace_week_start(db: Session, org_id: UUID) -> str:
    value = db.scalars(
        select(WorkspaceProfile.week_start).where(WorkspaceProfile.id == org_id)
    ).one_or_none()
    if value not in {"monday", "sunday"}:
        raise HTTPException(503, detail="Workspace configuration is unavailable")
    return str(value)


def _aggregate_expression(
    aggregation: str, measure: FieldReference | None, fields: dict[UUID, Field]
) -> ColumnElement[Any]:
    if aggregation == "count":
        return func.count(Record.id)
    assert measure is not None
    expression = field_expression(fields[measure.field_id])
    if aggregation == "distinct":
        return func.count(func.distinct(expression))
    if aggregation in {"min", "max"}:
        return func.min(expression) if aggregation == "min" else func.max(expression)
    function = func.sum(expression) if aggregation == "sum" else func.avg(expression)
    return func.coalesce(function, 0)


def _key(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def _date_window_predicates(
    db: Session, field: Field, from_date: date, to_date: date
) -> tuple[ColumnElement[bool], ...]:
    date_expression = field_expression(field)
    if field.type == FieldType.DATE:
        return (date_expression >= from_date, date_expression <= to_date)

    timezone_name, workspace_timezone = _workspace_timezone(db, field.org_id)
    bucket_expression = func.timezone(timezone_name, date_expression).cast(Date())
    lower = datetime.combine(from_date, time.min, tzinfo=workspace_timezone)
    if to_date == date.max:
        return (date_expression >= lower, bucket_expression <= to_date)
    upper = datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=workspace_timezone)
    return (date_expression >= lower, date_expression < upper)


def _grouped_aggregate(
    db: Session, payload: GroupedAggregateQuery, fields: dict[UUID, Field]
) -> AggregateResponse:
    dimension = fields[payload.dimension.field_id]
    dimension_expression = field_expression(dimension)
    aggregate_expression = _aggregate_expression(payload.aggregation, payload.measure, fields)
    count_expression = func.count(Record.id)
    base_query = compile_query(payload.module_id, payload.definition, fields).order_by(None)
    grouped_query = (
        base_query.with_only_columns(
            dimension_expression.label("dimension"),
            aggregate_expression.label("value"),
            count_expression.label("record_count"),
        )
        .group_by(dimension_expression)
        .order_by(
            aggregate_expression.desc().nulls_last(),
            dimension_expression.asc().nulls_last(),
        )
    )
    total = (
        db.scalar(
            select(func.count()).select_from(
                grouped_query.with_only_columns(dimension_expression.label("dimension"))
                .order_by(None)
                .subquery()
            )
        )
        or 0
    )
    rows = db.execute(grouped_query.limit(payload.limit).offset(payload.offset)).all()
    resolver = FieldDisplayResolver(db, payload.module_id, (dimension,))
    items = [
        AggregateDatum(
            key=_key(row.dimension),
            label=(
                "Unspecified" if row.dimension is None else resolver.label(dimension, row.dimension)
            ),
            value=row.value,
            record_count=row.record_count,
        )
        for row in rows
    ]
    return AggregateResponse(
        items=items,
        pagination=AggregatePaginationMetadata(
            limit=payload.limit,
            offset=payload.offset,
            count=len(items),
            total=total,
            has_more=payload.offset + len(items) < total,
        ),
    )


def _date_series_aggregate(
    db: Session, payload: DateSeriesAggregateQuery, fields: dict[UUID, Field]
) -> AggregateResponse:
    field = fields[payload.date_field.field_id]
    date_expression = field_expression(field)
    local_date = (
        date_expression
        if field.type == FieldType.DATE
        else func.timezone(_workspace_timezone(db, field.org_id)[0], date_expression).cast(Date())
    )
    week_start = _workspace_week_start(db, field.org_id) if payload.bucket == "week" else "monday"
    try:
        starts = calendar_buckets(payload.from_date, payload.to_date, payload.bucket, week_start)
    except ValueError as error:
        raise HTTPException(
            422, detail={"code": "aggregate_date_range_invalid", "message": str(error)}
        ) from error
    bucket_expression = sql_bucket_start(local_date, payload.bucket, week_start)
    date_filter = _date_window_predicates(db, field, payload.from_date, payload.to_date)

    aggregate_expression = _aggregate_expression(payload.aggregation, payload.measure, fields)
    base_query = (
        compile_query(payload.module_id, payload.definition, fields)
        .order_by(None)
        .where(*date_filter)
    )
    series_query = (
        base_query.with_only_columns(
            bucket_expression.label("day"),
            aggregate_expression.label("value"),
            func.count(Record.id).label("record_count"),
        )
        .group_by(bucket_expression)
        .order_by(bucket_expression.asc())
    )
    by_day = {row.day: (row.value, row.record_count) for row in db.execute(series_query).all()}
    length = len(starts)
    zero: int | Decimal | None = (
        None
        if payload.aggregation in {"average", "min", "max"}
        else 0
        if payload.aggregation in {"count", "distinct"}
        else Decimal(0)
    )
    items = []
    for day in starts:
        value, record_count = by_day.get(day, (zero, 0))
        label = day.isoformat()
        items.append(
            AggregateDatum(
                key=label,
                label=label,
                value=value,
                record_count=record_count,
            )
        )
    return AggregateResponse(
        items=items,
        pagination=AggregatePaginationMetadata(
            limit=length,
            offset=0,
            count=length,
            total=length,
            has_more=False,
        ),
    )


def aggregate_records(
    db: Session, payload: GroupedAggregateQuery | DateSeriesAggregateQuery, *, reader: User
) -> AggregateResponse:
    references = (
        (payload.dimension, payload.measure)
        if isinstance(payload, GroupedAggregateQuery)
        else (payload.date_field, payload.measure)
    )
    fields = validate_definition(
        db,
        payload.module_id,
        payload.definition,
        reader=reader,
        extra_references=tuple(reference for reference in references if reference is not None),
    )
    if isinstance(payload, GroupedAggregateQuery):
        return _grouped_aggregate(db, payload, fields)
    return _date_series_aggregate(db, payload, fields)


def _grouped_aggregate_snapshot(
    db: Session, payload: GroupedAggregateSnapshotQuery, fields: dict[UUID, Field]
) -> AggregateSnapshotResponse:
    dimension = fields[payload.dimension.field_id]
    dimension_expression = field_expression(dimension)
    aggregate_expression = _aggregate_expression(payload.aggregation, payload.measure, fields)
    count_expression = func.count(Record.id)
    base_query = compile_query(payload.module_id, payload.definition, fields).order_by(None)
    if payload.date_field is not None:
        assert payload.from_date is not None and payload.to_date is not None
        base_query = base_query.where(
            *_date_window_predicates(
                db,
                fields[payload.date_field.field_id],
                payload.from_date,
                payload.to_date,
            )
        )
    grouped_query = (
        base_query.with_only_columns(
            dimension_expression.label("dimension"),
            aggregate_expression.label("value"),
            count_expression.label("record_count"),
        )
        .group_by(dimension_expression)
        .order_by(
            aggregate_expression.desc().nulls_last(),
            dimension_expression.asc().nulls_last(),
        )
    )
    rows = db.execute(grouped_query.limit(MAX_AGGREGATE_SNAPSHOT_BUCKETS + 1)).all()
    if len(rows) > MAX_AGGREGATE_SNAPSHOT_BUCKETS:
        raise _snapshot_limit_exceeded()
    resolver = FieldDisplayResolver(db, payload.module_id, (dimension,))
    items = [
        AggregateDatum(
            key=_key(row.dimension),
            label=(
                "Unspecified" if row.dimension is None else resolver.label(dimension, row.dimension)
            ),
            value=row.value,
            record_count=row.record_count,
        )
        for row in rows
    ]
    return AggregateSnapshotResponse(
        items=items,
        pagination=AggregateSnapshotPaginationMetadata(
            limit=max(len(items), 1),
            offset=0,
            count=len(items),
            total=len(items),
            has_more=False,
        ),
    )


def _snapshot_limit_exceeded() -> HTTPException:
    return HTTPException(
        422,
        detail={
            "code": "aggregate_snapshot_limit_exceeded",
            "message": "Aggregate snapshot exceeds 10,000 buckets or 8 MiB",
        },
    )


def aggregate_snapshot_records(
    db: Session, payload: AggregateSnapshotQuery, *, reader: User
) -> AggregateSnapshotResponse:
    references = (
        (payload.dimension, payload.measure, payload.date_field)
        if isinstance(payload, GroupedAggregateSnapshotQuery)
        else (payload.date_field, payload.measure)
    )
    fields = validate_definition(
        db,
        payload.module_id,
        payload.definition,
        reader=reader,
        extra_references=tuple(reference for reference in references if reference is not None),
    )
    if isinstance(payload, GroupedAggregateSnapshotQuery):
        return _grouped_aggregate_snapshot(db, payload, fields)
    result = _date_series_aggregate(db, payload, fields)
    return AggregateSnapshotResponse(
        items=result.items,
        pagination=AggregateSnapshotPaginationMetadata(
            limit=result.pagination.limit,
            offset=result.pagination.offset,
            count=result.pagination.count,
            total=result.pagination.total,
            has_more=result.pagination.has_more,
        ),
    )


def aggregate_snapshot(
    engine: Engine, payload: AggregateSnapshotQuery, *, reader_id: UUID
) -> tuple[bytes, int]:
    """Materialize a complete JSON result inside one independent read snapshot.

    The reader's module level is checked inside the same snapshot.
    """
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with Session(bind=connection) as snapshot:
            reader = snapshot.get(User, reader_id)
            if reader is None:
                raise module_hidden()
            result = aggregate_snapshot_records(snapshot, payload, reader=reader)
            content = result.model_dump_json().encode("utf-8")
            if len(content) > MAX_AGGREGATE_SNAPSHOT_BYTES:
                raise _snapshot_limit_exceeded()
            return content, len(result.items)


def aggregate_snapshots(
    engine: Engine, payload: AggregateSnapshotsRequest, *, reader_id: UUID
) -> tuple[bytes, int]:
    """Materialize the ordered batch in one read snapshot with combined limits."""
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with Session(bind=connection) as snapshot:
            reader = snapshot.get(User, reader_id)
            if reader is None:
                raise module_hidden()
            items = []
            bucket_count = 0
            for query in payload.queries:
                result = aggregate_snapshot_records(snapshot, query, reader=reader)
                bucket_count += len(result.items)
                if bucket_count > MAX_AGGREGATE_SNAPSHOT_BUCKETS:
                    raise _snapshot_limit_exceeded()
                items.append(result)
            content = AggregateSnapshotsResponse(items=items).model_dump_json().encode("utf-8")
            if len(content) > MAX_AGGREGATE_SNAPSHOT_BYTES:
                raise _snapshot_limit_exceeded()
            return content, bucket_count
