"""Lifecycle keeps group access through close and reopen and removes it with a purge."""

from datetime import UTC, datetime

import pytest
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel, GroupAccess
from app.systems.access.policy.scope import level_for
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.modules.models import Module
from tests.rbac.support import add_user, make_group_access, organization
from tests.sandbox_designs.fixtures import create_document

pytestmark = pytest.mark.integration


def test_closing_a_department_is_not_blocked_and_keeps_its_group_access(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    org = organization(db)
    create_document(db, org)
    member = add_user(db)
    department = Department(org_id=org.id, department_name=f"Close keeps access {uuid7()}")
    db.add(department)
    db.flush()
    grant = make_group_access(db, [member], department, level=AccessLevel.WRITE)
    db.commit()

    close_plan = plan_lifecycle(db, "department", department.id, "close", None)
    assert close_plan.blockers == ()
    execute_lifecycle(db, close_plan)

    assert db.get(GroupAccess, grant.id) is not None
    assert level_for(db, member, department.id) is AccessLevel.WRITE


def test_department_purge_removes_every_group_access_row_that_references_it(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    org = organization(db)
    create_document(db, org)
    member = add_user(db)
    department = Department(
        org_id=org.id,
        department_name=f"Access purge {uuid7()}",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(department)
    db.flush()
    module = Module(
        org_id=department.org_id,
        department_id=department.id,
        module_name=f"Purged module {uuid7().hex[-12:]}",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(module)
    db.flush()
    department_row = make_group_access(db, [member], department, level=AccessLevel.READ)
    module_row = make_group_access(db, [member], department, module, level=AccessLevel.WRITE)
    retired_row = make_group_access(db, [], department, level=AccessLevel.MANAGE)
    retired_row.is_deleted = True
    retired_row.deleted_at = datetime.now(UTC)
    db.commit()

    plan = plan_lifecycle(db, "department", department.id, "purge", None)
    expected = tuple(sorted((department_row.id, module_row.id, retired_row.id)))
    assert plan.scope_ids["group_access"] == expected
    assert plan.blockers == ()
    execute_lifecycle(db, plan)

    for row_id in expected:
        assert db.get(GroupAccess, row_id) is None
    assert db.get(Department, department.id) is None
