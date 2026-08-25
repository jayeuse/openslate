import os
from enum import StrEnum

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.listing import ListQuerySpec, StandardListRequest, execute_standard_list
from app.systems.departments.models import Department

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)


class DepartmentSortField(StrEnum):
    NAME = "department_name"


def test_standard_list_executes_against_postgresql(integration_db: Session) -> None:
    integration_db.add_all(
        [
            Department(department_name="Alpha"),
            Department(department_name="Beta"),
            Department(department_name="Deleted", is_deleted=True),
        ]
    )
    integration_db.flush()

    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
        search_fields=(Department.department_name,),
        deleted_field=Department.is_deleted,
    )
    result = execute_standard_list(
        integration_db,
        select(Department),
        StandardListRequest[DepartmentSortField](search="a", limit=1),
        spec,
    )

    assert [department.department_name for department in result.items] == ["Alpha"]
    assert result.pagination.total == 2
    assert result.pagination.has_more is True
