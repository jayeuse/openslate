import os
from collections.abc import Generator
from enum import StrEnum

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.common.listing import ListQuerySpec, StandardListRequest, execute_standard_list
from app.core.database import model_registry  # noqa: F401
from app.core.database.base import Base
from app.core.database.session import AuditSession
from app.systems.departments.models import Department

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)


@pytest.fixture
def db() -> Generator[Session, None, None]:
    assert TEST_DATABASE_URL is not None
    engine = create_engine(TEST_DATABASE_URL)
    Base.metadata.create_all(engine)
    connection = engine.connect()
    transaction = connection.begin()
    session = AuditSession(bind=connection)
    try:
        yield session
    finally:
        session.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


class DepartmentSortField(StrEnum):
    NAME = "department_name"


def test_standard_list_executes_against_postgresql(db: Session) -> None:
    db.add_all(
        [
            Department(department_name="Alpha"),
            Department(department_name="Beta"),
            Department(department_name="Deleted", is_deleted=True),
        ]
    )
    db.flush()

    spec = ListQuerySpec(
        sort_fields={DepartmentSortField.NAME: Department.department_name},
        default_sort=DepartmentSortField.NAME,
        tie_breaker=Department.id,
        search_fields=(Department.department_name,),
        deleted_field=Department.is_deleted,
    )
    result = execute_standard_list(
        db,
        select(Department),
        StandardListRequest[DepartmentSortField](search="a", limit=1),
        spec,
    )

    assert [department.department_name for department in result.items] == ["Alpha"]
    assert result.pagination.total == 2
    assert result.pagination.has_more is True
