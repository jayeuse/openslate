"""People and group list queries, without PostgreSQL.

``GET /api/users``, ``/api/users/summary``, ``/api/access/member-candidates`` and
``/api/access/groups`` validate their query models before any database work. FastAPI
hands each model the raw query strings (a list of strings for a repeated key), so each
row passes the same strings that the route tests sent, with the location the 422
reports. The route tests keep one HTTP 422 case per route:
``test_people_monitoring_integration.py`` and ``test_paging_extensions_integration.py``.
"""

from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from app.systems.access.policy.schemas import GroupListRequest, MemberCandidateListRequest
from app.systems.access.users.directory import UserListRequest, UserSummaryRequest

KNOWN_ID = "0190a000-0000-7000-8000-000000000001"


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({"status": "invented"}, id="status"),
        pytest.param({"group_id": "invalid"}, id="group"),
        pytest.param({"department_id": "invalid"}, id="department"),
        pytest.param({"mfa": "invented"}, id="mfa"),
        pytest.param({"sort_by": "last_active_at"}, id="sort"),
    ],
)
def test_directory_refuses_unlisted_filters(params: dict[str, str]) -> None:
    with pytest.raises(ValidationError) as refused:
        UserListRequest.model_validate(params)
    assert {error["loc"][0] for error in refused.value.errors()} == set(params)


@pytest.mark.parametrize("model", [UserListRequest, UserSummaryRequest])
@pytest.mark.parametrize("value", ["0", "3651", "true", "false", "1.5", "30.0"])
def test_recorded_history_days_refuse_noninteger_and_out_of_range_strings(
    model: type[BaseModel], value: str
) -> None:
    with pytest.raises(ValidationError) as refused:
        model.model_validate({"inactive_days": value})
    assert [error["loc"] for error in refused.value.errors()] == [("inactive_days",)]


@pytest.mark.parametrize("model", [UserListRequest, UserSummaryRequest])
def test_recorded_history_days_accept_a_decimal_string(model: type[BaseModel]) -> None:
    assert model.model_validate({"inactive_days": "30"}).model_dump()["inactive_days"] == 30


@pytest.mark.parametrize("model", [UserListRequest, MemberCandidateListRequest])
@pytest.mark.parametrize(
    ("ids", "loc"),
    [
        pytest.param([KNOWN_ID] * 101, ("ids",), id="over_limit"),
        pytest.param(["invalid"], ("ids", 0), id="malformed"),
        pytest.param([""], ("ids", 0), id="empty"),
    ],
)
def test_ids_lookup_refuses_unbounded_or_invalid_values(
    model: type[BaseModel], ids: list[str], loc: tuple[Any, ...]
) -> None:
    with pytest.raises(ValidationError) as refused:
        model.model_validate({"ids": ids})
    assert [error["loc"] for error in refused.value.errors()] == [loc]


@pytest.mark.parametrize("model", [UserListRequest, MemberCandidateListRequest])
def test_ids_lookup_accepts_one_hundred_ids(model: type[BaseModel]) -> None:
    assert len(model.model_validate({"ids": [KNOWN_ID] * 100}).model_dump()["ids"]) == 100


@pytest.mark.parametrize("member_id", ["invalid", ""])
def test_group_member_lookup_refuses_an_invalid_uuid(member_id: str) -> None:
    with pytest.raises(ValidationError) as refused:
        GroupListRequest.model_validate({"member_id": member_id})
    assert [error["loc"] for error in refused.value.errors()] == [("member_id",)]
