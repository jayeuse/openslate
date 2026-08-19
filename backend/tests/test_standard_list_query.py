from enum import StrEnum
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.common.listing.query import (
    ListQuerySpec,
    build_standard_list_statements,
    execute_standard_list,
)
from app.common.listing.schemas import DeletedFilter, StandardListRequest
from app.core.database import model_registry  # noqa: F401
from app.systems.departments.models import Department


class DepartmentSortField(StrEnum):
    NAME = "department_name"
    CREATED_AT = "created_at"


class RecordingResult:
    def __init__(self, items: list[object]) -> None:
        self.items = items

    def all(self) -> list[object]:
        return self.items


class RecordingSession:
    def __init__(self, *, total: int, items: list[object]) -> None:
        self.total = total
        self.items = items
        self.count_statement = None
        self.items_statement = None

    def scalar(self, statement: Any) -> int:
        self.count_statement = statement
        return self.total

    def scalars(self, statement: Any) -> RecordingResult:
        self.items_statement = statement
        return RecordingResult(self.items)


def make_spec() -> ListQuerySpec[DepartmentSortField]:
    return ListQuerySpec(
        sort_fields={
            DepartmentSortField.NAME: Department.department_name,
            DepartmentSortField.CREATED_AT: Department.created_at,
        },
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
        search_fields=(Department.department_name,),
        deleted_field=Department.is_deleted,
    )


def compile_statement(statement: Any) -> str:
    return str(statement.compile(dialect=postgresql.dialect()))


def compile_parameters(statement: Any) -> dict[str, Any]:
    return statement.compile(dialect=postgresql.dialect()).params


def test_execute_standard_list_returns_items_and_metadata() -> None:
    first = object()
    second = object()
    session = RecordingSession(total=3, items=[first, second])

    result = execute_standard_list(
        session,
        select(Department),
        StandardListRequest[DepartmentSortField](limit=2, offset=1),
        make_spec(),
    )

    assert result.items == [first, second]
    assert result.pagination.limit == 2
    assert result.pagination.offset == 1
    assert result.pagination.count == 2
    assert result.pagination.total == 3
    assert result.pagination.has_more is False


def test_query_applies_search_deleted_filter_and_stable_sort() -> None:
    session = RecordingSession(total=0, items=[])
    request = StandardListRequest[DepartmentSortField](
        search="50%_done\\",
        deleted=DeletedFilter.ONLY,
        sort_by=DepartmentSortField.CREATED_AT,
        sort_order="desc",
        limit=10,
        offset=20,
    )

    execute_standard_list(session, select(Department), request, make_spec())

    assert session.items_statement is not None
    sql = compile_statement(session.items_statement)
    assert "ILIKE" in sql
    assert "is_deleted IS true" in sql
    assert "ORDER BY departments.created_at DESC NULLS LAST, departments.id DESC NULLS LAST" in sql
    assert "LIMIT %(param_1)s" in sql
    assert "OFFSET %(param_2)s" in sql
    assert "%50\\%\\_done\\\\%" in compile_parameters(session.items_statement).values()


def test_count_statement_has_no_pagination_or_ordering() -> None:
    session = RecordingSession(total=0, items=[])

    execute_standard_list(
        session,
        select(Department),
        StandardListRequest[DepartmentSortField](limit=5, offset=10),
        make_spec(),
    )

    assert session.count_statement is not None
    sql = compile_statement(session.count_statement)
    assert "ORDER BY" not in sql
    assert "LIMIT" not in sql
    assert "OFFSET" not in sql


def test_unsupported_search_returns_unprocessable_entity() -> None:
    session = RecordingSession(total=0, items=[])
    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
    )

    with pytest.raises(HTTPException) as error:
        execute_standard_list(
            session,
            select(Department),
            StandardListRequest[DepartmentSortField](search="alpha"),
            spec,
        )

    assert error.value.status_code == 422


def test_unsupported_deleted_mode_returns_unprocessable_entity() -> None:
    session = RecordingSession(total=0, items=[])
    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
    )

    with pytest.raises(HTTPException) as error:
        execute_standard_list(
            session,
            select(Department),
            StandardListRequest[DepartmentSortField](deleted=DeletedFilter.ONLY),
            spec,
        )

    assert error.value.status_code == 422


def test_exclude_without_deleted_field_is_supported() -> None:
    session = RecordingSession(total=0, items=[])
    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
    )

    execute_standard_list(
        session,
        select(Department),
        StandardListRequest[DepartmentSortField](),
        spec,
    )


def test_invalid_query_spec_fails_during_configuration() -> None:
    with pytest.raises(ValueError):
        ListQuerySpec(
            sort_fields={},
            default_sort=DepartmentSortField.NAME,
            tie_breaker=Department.id,
        )


def test_build_statements_can_be_reused_without_execution() -> None:
    item_statement, count_statement = build_standard_list_statements(
        select(Department),
        StandardListRequest[DepartmentSortField](),
        make_spec(),
    )

    assert "LIMIT" in compile_statement(item_statement)
    assert "COUNT" in compile_statement(count_statement).upper()
