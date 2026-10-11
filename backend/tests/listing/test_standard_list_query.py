from enum import StrEnum

import pytest
from fastapi import HTTPException
from hypothesis import assume, given
from hypothesis import strategies as st
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.common.listing.query import ListQuerySpec, build_standard_list_statements
from app.common.listing.schemas import StandardListRequest
from app.systems.sandbox.departments.models import Department
from tests.property_support import PROPERTY


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
            search="50%_done",
            deleted="only",
            sort_order="desc",
            limit=10,
            offset=20,
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
            select(Department),
            StandardListRequest[DepartmentSortField](**params),
            spec,
        )
    assert error.value.status_code == 422


def _like_pattern(search: str) -> str:
    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
        search_fields=(Department.department_name,),
    )
    items, _ = build_standard_list_statements(
        select(Department), StandardListRequest[DepartmentSortField](search=search), spec
    )
    (pattern,) = (
        value
        for value in items.compile(dialect=postgresql.dialect()).params.values()
        if isinstance(value, str)
    )
    return pattern


def _like_tokens(pattern: str) -> list[tuple[str, str]]:
    """Read a LIKE pattern with the backslash escape: ("wild", "%"|"_") or ("text", char)."""

    tokens = []
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "\\":
            assert index + 1 < len(pattern), "a trailing escape matches nothing"
            tokens.append(("text", pattern[index + 1]))
            index += 2
            continue
        tokens.append(("wild" if character in "%_" else "text", character))
        index += 1
    return tokens


@PROPERTY
@given(
    st.text(alphabet=st.sampled_from("ab %_\\\t"), min_size=1, max_size=30) | st.text(max_size=100)
)
def test_list_search_matches_its_text_literally_inside_any_value(search: str) -> None:
    normalized = search.strip()
    assume(normalized)

    tokens = _like_tokens(_like_pattern(search))

    assert tokens[0] == ("wild", "%") and tokens[-1] == ("wild", "%")
    assert all(kind == "text" for kind, _ in tokens[1:-1])
    assert "".join(character for _, character in tokens[1:-1]) == normalized
