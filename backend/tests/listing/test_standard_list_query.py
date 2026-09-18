from enum import StrEnum

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.common.listing.query import ListQuerySpec, build_standard_list_statements
from app.common.listing.schemas import StandardListRequest
from app.systems.sandbox.departments.models import Department


class DepartmentSortField(StrEnum):
    NAME = "department_name"


def test_list_query_escapes_search_and_counts_before_pagination() -> None:
    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
        search_fields=(Department.department_name,),
        deleted_field=Department.is_deleted,
    )
    items, count = build_standard_list_statements(
        select(Department),
        StandardListRequest[DepartmentSortField](
            search="50%_done", deleted="only", sort_order="desc", limit=10, offset=20,
        ),
        spec,
    )
    compiled = items.compile(dialect=postgresql.dialect())
    assert "%50\\%\\_done%" in compiled.params.values()
    assert "is_deleted IS true" in str(compiled)
    assert "departments.id DESC NULLS LAST" in str(compiled)
    assert "LIMIT" in str(compiled) and "OFFSET" in str(compiled)
    count_sql = str(count.compile(dialect=postgresql.dialect()))
    assert all(keyword not in count_sql for keyword in ("ORDER BY", "LIMIT", "OFFSET"))


@pytest.mark.parametrize("params", [{"search": "alpha"}, {"deleted": "only"}])
def test_unsupported_list_filters_return_422(params: dict[str, str]) -> None:
    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
    )
    with pytest.raises(HTTPException) as error:
        build_standard_list_statements(
            select(Department), StandardListRequest[DepartmentSortField](**params), spec,
        )
    assert error.value.status_code == 422
