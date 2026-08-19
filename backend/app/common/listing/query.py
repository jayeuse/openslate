from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Select, asc, desc, func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing.schemas import (
    DeletedFilter,
    PaginationMetadata,
    SortOrder,
    StandardListRequest,
)


@dataclass(frozen=True, slots=True)
class ListQuerySpec[SortFieldT: StrEnum]:
    sort_fields: Mapping[SortFieldT, ColumnElement[Any]]
    default_sort: SortFieldT
    tie_breaker: ColumnElement[Any]
    search_fields: tuple[ColumnElement[str], ...] = ()
    deleted_field: ColumnElement[bool] | None = None

    def __post_init__(self) -> None:
        if not self.sort_fields:
            raise ValueError("A list query must define at least one sort field")
        if self.default_sort not in self.sort_fields:
            raise ValueError("The default sort field must be included in sort_fields")


@dataclass(frozen=True, slots=True)
class ListQueryResult[ModelT]:
    items: list[ModelT]
    pagination: PaginationMetadata


def _unsupported_parameter(parameter: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=[
            {
                "loc": ["query", parameter],
                "msg": message,
                "type": "value_error",
            }
        ],
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _deleted_condition[SortFieldT: StrEnum](
    request: StandardListRequest[SortFieldT],
    spec: ListQuerySpec[SortFieldT],
) -> ColumnElement[bool] | None:
    if spec.deleted_field is None:
        if request.deleted is not DeletedFilter.EXCLUDE:
            raise _unsupported_parameter(
                "deleted",
                "This endpoint does not support deleted record filtering",
            )
        return None

    if request.deleted is DeletedFilter.EXCLUDE:
        return spec.deleted_field.is_(False)
    if request.deleted is DeletedFilter.ONLY:
        return spec.deleted_field.is_(True)
    return None


def _search_condition[SortFieldT: StrEnum](
    request: StandardListRequest[SortFieldT],
    spec: ListQuerySpec[SortFieldT],
) -> ColumnElement[bool] | None:
    if request.search is None:
        return None
    if not spec.search_fields:
        raise _unsupported_parameter(
            "search",
            "This endpoint does not support search",
        )

    pattern = f"%{_escape_like(request.search)}%"
    return or_(*(field.ilike(pattern, escape="\\") for field in spec.search_fields))


def build_standard_list_statements[ModelT, SortFieldT: StrEnum](
    statement: Select[tuple[ModelT]],
    request: StandardListRequest[SortFieldT],
    spec: ListQuerySpec[SortFieldT],
) -> tuple[Select[tuple[ModelT]], Select[tuple[int]]]:
    filtered = statement.order_by(None).limit(None).offset(None)
    conditions = [
        condition
        for condition in (
            _deleted_condition(request, spec),
            _search_condition(request, spec),
        )
        if condition is not None
    ]
    if conditions:
        filtered = filtered.where(*conditions)

    count_statement = select(func.count()).select_from(filtered.subquery())
    sort_column = spec.sort_fields[request.sort_by or spec.default_sort]
    sort_function = asc if request.sort_order is SortOrder.ASC else desc
    item_statement = filtered.order_by(
        sort_function(sort_column).nulls_last(),
        sort_function(spec.tie_breaker).nulls_last(),
    )
    item_statement = item_statement.offset(request.offset).limit(request.limit)
    return item_statement, count_statement


def execute_standard_list[ModelT, SortFieldT: StrEnum](
    db: Session,
    statement: Select[tuple[ModelT]],
    request: StandardListRequest[SortFieldT],
    spec: ListQuerySpec[SortFieldT],
) -> ListQueryResult[ModelT]:
    item_statement, count_statement = build_standard_list_statements(statement, request, spec)
    total = int(db.scalar(count_statement) or 0)
    items = list(db.scalars(item_statement).all())
    pagination = PaginationMetadata(
        limit=request.limit,
        offset=request.offset,
        count=len(items),
        total=total,
        has_more=request.offset + len(items) < total,
    )
    return ListQueryResult(items=items, pagination=pagination)
