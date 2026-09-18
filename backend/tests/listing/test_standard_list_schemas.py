from enum import StrEnum

import pytest
from pydantic import ValidationError

from app.common.listing.schemas import (
    DeletedFilter,
    PaginationMetadata,
    SortOrder,
    StandardListRequest,
    StandardListResponse,
)


class ExampleSortField(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"


class ExampleListRequest(StandardListRequest[ExampleSortField]):
    pass


class ExampleListResponse(StandardListResponse[str]):
    pass


def test_standard_list_request_defaults() -> None:
    request = ExampleListRequest()

    assert request.limit == 25
    assert request.offset == 0
    assert request.sort_by is None
    assert request.sort_order is SortOrder.ASC
    assert request.search is None
    assert request.deleted is DeletedFilter.EXCLUDE


@pytest.mark.parametrize("limit", [0, 101])
def test_standard_list_request_rejects_invalid_limits(limit: int) -> None:
    with pytest.raises(ValidationError):
        ExampleListRequest(limit=limit)


def test_standard_list_request_rejects_negative_offset() -> None:
    with pytest.raises(ValidationError):
        ExampleListRequest(offset=-1)


def test_standard_list_request_normalizes_search() -> None:
    assert ExampleListRequest(search="  alpha  ").search == "alpha"
    assert ExampleListRequest(search="   ").search is None


@pytest.mark.parametrize(("search", "valid"), [("x" * 100, True), ("x" * 101, False)])
def test_standard_list_request_bounds_trimmed_search(search: str, valid: bool) -> None:
    value = f"  {search}  "

    if valid:
        assert ExampleListRequest(search=value).search == search
    else:
        with pytest.raises(ValidationError):
            ExampleListRequest(search=value)


def test_standard_list_request_exposes_endpoint_sort_enum() -> None:
    request = ExampleListRequest(sort_by=ExampleSortField.CREATED_AT, sort_order="desc")

    assert request.sort_by is ExampleSortField.CREATED_AT
    assert request.sort_order is SortOrder.DESC

    with pytest.raises(ValidationError):
        ExampleListRequest(sort_by="unsupported")


def test_standard_list_response_contains_pagination_metadata() -> None:
    response = ExampleListResponse(
        items=["one"],
        pagination=PaginationMetadata(limit=25, offset=0, count=1, total=1, has_more=False),
    )

    assert response.model_dump() == {
        "items": ["one"],
        "pagination": {
            "limit": 25,
            "offset": 0,
            "count": 1,
            "total": 1,
            "has_more": False,
        },
    }
