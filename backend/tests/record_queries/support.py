"""Shared builders for record query, analytics and window tests.

``query_db`` is the rolled-back owner session; every test that uses it carries the
``integration`` mark, so the autouse guard in ``tests/conftest.py`` has already checked
both runner databases for the test. ``route_client`` gives HTTP tests the complete
application without its process lifespan (``tests/route_app_support.py``).
"""

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import NAMESPACE_URL, uuid5

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_schemas import RecordQuery
from tests.conftest import create_member
from tests.organization_scope_support import scoped_override
from tests.rbac.support import organization
from tests.route_app_support import route_app


@pytest.fixture
def query_db(integration_owner_db: Session) -> Session:
    create_member(integration_owner_db, organization(integration_owner_db), "admin",
                  id=READER.id, email="query-reader@example.test", username="query-reader")
    return integration_owner_db


# An administrator reads every module, so direct query calls need no group.
READER, _READER_MEMBERSHIP = create_member(None, WorkspaceProfile(id=uuid7()), "admin",
                                         id=uuid7(), status="active", is_deleted=False)


def option_id(label: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"record-query:{label}"))


def route_actor(db: Session, *, records_read: bool = True) -> User:
    """Give HTTP query tests a persisted actor for Access policy evaluation."""

    actor_id = uuid7()
    actor, _membership = create_member(db, organization(db), "admin" if records_read else "member",
        id=actor_id,
        email=f"query-{actor_id.hex}@example.test",
        username=f"query_{actor_id.hex[:16]}",
        status="active",
    )
    return actor


@contextmanager
def route_client(db: Session, actor: User, **options: object) -> Iterator[TestClient]:
    """A client of the complete application whose requests use *db* as *actor*."""

    application = route_app()
    application.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    application.dependency_overrides[get_db] = lambda: db
    with TestClient(application, **options) as client:
        yield client


def setup_rows(db: Session, kind: str, values: list[object]):
    department = Department(org_id=organization(db).id, department_name=f"query-{uuid7()}")
    db.add(department)
    db.flush()
    module = Module(org_id=department.org_id, department_id=department.id, module_name="Records")
    db.add(module)
    db.flush()
    field = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Value",
        type=kind,
        position=0,
        required=False,
        config=(
            {
                "options": [
                    {"id": option_id(value), "label": value}
                    for value in dict.fromkeys(value for value in values if isinstance(value, str))
                ]
            }
            if kind == "select"
            else {}
        ),
    )
    db.add(field)
    db.flush()
    rows = [
        Record(
            org_id=module.org_id,
            module_id=module.id,
            data=(
                {}
                if value is ...
                else {
                    str(field.id): (
                        option_id(value) if kind == "select" and isinstance(value, str) else value
                    )
                }
            ),
        )
        for value in values
    ]
    db.add_all(rows)
    db.flush()
    return module, field, rows


def request_for(module, field, **definition):
    reference = {"field_id": field.id, "expected_type": field.type}
    return RecordQuery(module_id=module.id, definition={"columns": [reference], **definition})


def reference(field: Field) -> dict[str, object]:
    return {"field_id": field.id, "expected_type": field.type}


def add_values(
    db: Session,
    module,
    rows,
    name: str,
    kind: str,
    values: list[object],
    *,
    position: int = 1,
) -> Field:
    field = Field(
        org_id=module.org_id,
        module_id=module.id,
        name=name,
        type=kind,
        position=position,
        required=False,
        config={},
    )
    db.add(field)
    db.flush()
    for row, value in zip(rows, values, strict=True):
        if value is not ...:
            row.data = {**row.data, str(field.id): value}
    db.flush()
    return field
