from enum import StrEnum
from typing import Annotated

from fastapi import FastAPI, Query
from fastapi.testclient import TestClient

from app.common.listing import (
    PaginationMetadata,
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


app = FastAPI()


@app.get("/test-items", response_model=ExampleListResponse)
def list_test_items(
    params: Annotated[ExampleListRequest, Query()],
) -> ExampleListResponse:
    items = ["alpha", "beta"][params.offset : params.offset + params.limit]
    return ExampleListResponse(
        items=items,
        pagination=PaginationMetadata(
            limit=params.limit,
            offset=params.offset,
            count=len(items),
            total=2,
            has_more=params.offset + len(items) < 2,
        ),
    )


client = TestClient(app)


def test_standard_request_binds_to_query_parameters() -> None:
    response = client.get("/test-items?limit=1&offset=1&sort_by=created_at&sort_order=desc")

    assert response.status_code == 200
    assert response.json()["pagination"] == {
        "limit": 1,
        "offset": 1,
        "count": 1,
        "total": 2,
        "has_more": False,
    }


def test_invalid_standard_query_returns_422() -> None:
    response = client.get("/test-items?limit=101")

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-1] == "limit"


def test_endpoint_sort_fields_are_documented_in_openapi() -> None:
    openapi = client.get("/openapi.json").json()
    operation = openapi["paths"]["/test-items"]["get"]
    sort_parameter = next(
        parameter for parameter in operation["parameters"] if parameter["name"] == "sort_by"
    )

    assert sort_parameter["required"] is False
    assert "ExampleSortField" in str(sort_parameter["schema"])
    assert openapi["components"]["schemas"]["ExampleSortField"]["enum"] == [
        "name",
        "created_at",
    ]
