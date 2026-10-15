"""A selected record title remains valid across lifecycle transitions."""

import pytest
from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.exceptions import LifecyclePreflightError
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleOperation, LifecycleTargetType
from app.systems.sandbox.lifecycle.service import (
    close_lifecycle,
    purge_lifecycle,
    reopen_lifecycle,
)
from app.systems.sandbox.modules.models import Module
from tests.rbac.support import add_department, add_module, organization
from tests.sandbox_designs.fixtures import create_document

pytestmark = pytest.mark.integration


def test_selected_title_field_blocks_standalone_close_but_module_lifecycle_remains_valid(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    create_document(db, organization(db))
    module = add_module(db, add_department(db))
    title_field = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Title",
        type=FieldType.TEXT,
        position=0,
        required=False,
        config={},
    )
    db.add(title_field)
    db.flush()
    module.title_field_id = title_field.id
    db.commit()

    field_plan = plan_lifecycle(
        db, LifecycleTargetType.FIELD, title_field.id, LifecycleOperation.CLOSE, None
    )
    assert field_plan.blockers
    with pytest.raises(LifecyclePreflightError):
        close_lifecycle(db, LifecycleTargetType.FIELD, title_field.id, None, plan=field_plan)
    assert db.get(Field, title_field.id).is_deleted is False

    close_lifecycle(db, LifecycleTargetType.MODULE, module.id, None)
    db.refresh(module)
    assert module.is_deleted and module.title_field_id == title_field.id
    reopen_lifecycle(db, LifecycleTargetType.MODULE, module.id, None)
    db.refresh(module)
    assert not module.is_deleted and module.title_field_id == title_field.id
    assert db.get(Field, title_field.id).is_deleted is False

    close_lifecycle(db, LifecycleTargetType.MODULE, module.id, None)
    purge_lifecycle(db, LifecycleTargetType.MODULE, module.id, None)
    assert db.get(Module, module.id) is None
    assert db.get(Field, title_field.id) is None
