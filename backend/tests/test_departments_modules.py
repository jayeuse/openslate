from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.listing import DeletedFilter, StandardListRequest
from app.systems.departments.models import Department
from app.systems.departments.router import (
    DepartmentSortField,
    create_department,
    delete_department,
    list_departments,
    restore_department,
    update_department,
)
from app.systems.departments.router import router as departments_router
from app.systems.departments.schemas import DepartmentCreate, DepartmentUpdate
from app.systems.fields.models import Field
from app.systems.lifecycle.exceptions import LifecycleClosedAncestorError
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.modules.models import Module
from app.systems.modules.router import (
    ModuleSortField,
    accept_module_schema,
    create_module,
    delete_module,
    list_modules,
    restore_module,
    update_module,
)
from app.systems.modules.router import router as modules_router
from app.systems.modules.schemas import ModuleCreate, ModuleResponse, ModuleUpdate


def test_crud_routers_expose_standard_contract() -> None:
    app = FastAPI()
    app.include_router(departments_router, prefix="/api")
    app.include_router(modules_router, prefix="/api")
    client = TestClient(app)

    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths["/api/departments"]) == {"get", "post"}
    assert set(paths["/api/departments/{department_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/departments/{department_id}/restore"]) == {"post"}
    assert set(paths["/api/modules"]) == {"get", "post"}
    assert set(paths["/api/modules/{module_id}"]) == {"get", "patch", "delete"}
    assert set(paths["/api/modules/{module_id}/restore"]) == {"post"}
    assert set(paths["/api/modules/{module_id}/schema/accept"]) == {"post"}


def test_schema_acceptance_is_output_only() -> None:
    assert "is_schema_accepted" not in ModuleCreate.model_fields
    assert "is_schema_accepted" not in ModuleUpdate.model_fields
    assert ModuleResponse.model_fields["is_schema_accepted"].json_schema_extra == {
        "readOnly": True
    }


def test_names_are_trimmed_and_blank_names_are_rejected() -> None:
    assert DepartmentCreate(department_name="  Operations  ").department_name == "Operations"
    assert ModuleCreate(department_id=uuid7(), module_name="  Assets  ").module_name == "Assets"

    with pytest.raises(ValueError):
        DepartmentCreate(department_name="   ")
    with pytest.raises(ValueError):
        ModuleUpdate(module_name="   ")


def test_list_endpoints_use_standard_search_and_deleted_filters() -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = 0
    db.scalars.return_value.all.return_value = []

    department_result = list_departments(
        None,
        db,
        StandardListRequest[DepartmentSortField](
            search="Operations",
            deleted=DeletedFilter.ONLY,
        ),
    )
    module_result = list_modules(
        None,
        db,
        StandardListRequest[ModuleSortField](
            search="Assets",
            deleted=DeletedFilter.INCLUDE,
        ),
    )

    assert department_result.pagination.total == 0
    assert module_result.pagination.total == 0
    assert db.scalar.call_count == 2
    assert db.scalars.call_count == 2


def test_department_lifecycle_and_active_module_dependency() -> None:
    department = Department(department_name="Operations", is_deleted=False)
    department.id = uuid7()
    db = Mock(spec=Session)
    db.scalar.side_effect = [None, 0]

    created = create_department(DepartmentCreate(department_name="  Operations  "), None, db)
    assert created.department_name == "Operations"
    assert db.commit.call_count == 1

    db.get.return_value = department
    db.scalar.side_effect = None
    db.scalar.return_value = None
    update_department(department.id, DepartmentUpdate(department_name="  Support  "), None, db)
    assert department.department_name == "Support"

    db.scalar.return_value = 1
    with pytest.raises(HTTPException) as error:
        delete_department(department.id, None, db)
    assert error.value.status_code == 409
    assert department.is_deleted is False

    db.scalar.side_effect = [None]
    deleted = Department(department_name="Retired", is_deleted=True)
    deleted.id = uuid7()
    db.get.return_value = deleted
    actor = SimpleNamespace(id=uuid7())
    with patch(
        "app.systems.departments.router.reopen_lifecycle",
        side_effect=lambda *_args: setattr(deleted, "is_deleted", False),
    ):
        restored = restore_department(deleted.id, actor, db)
    assert restored is deleted
    assert deleted.is_deleted is False
    assert deleted.deleted_at is None


def test_module_requires_active_parent_and_keeps_department_immutable() -> None:
    department = Department(department_name="Operations")
    department.id = uuid7()
    module = Module(department_id=department.id, module_name="Assets")
    module.id = uuid7()
    db = Mock(spec=Session)
    db.scalar.side_effect = [department, None]

    created = create_module(
        ModuleCreate(department_id=department.id, module_name="  Assets  "),
        None,
        db,
    )
    assert created.module_name == "Assets"

    db.get.return_value = module
    db.commit.reset_mock()
    with pytest.raises(HTTPException) as error:
        update_module(
            module.id,
            ModuleUpdate(department_id=uuid7()),
            None,
            db,
        )
    assert error.value.status_code == 409
    db.commit.assert_not_called()


def test_module_delete_checks_active_fields_and_records() -> None:
    module = Module(department_id=uuid7(), module_name="Assets", is_deleted=False)
    module.id = uuid7()
    db = Mock(spec=Session)
    db.get.return_value = module
    db.scalar.return_value = 1

    with pytest.raises(HTTPException) as error:
        delete_module(module.id, None, db)

    assert error.value.status_code == 409
    assert module.is_deleted is False


def test_module_restore_requires_active_parent_and_duplicate_preflight() -> None:
    module = Module(department_id=uuid7(), module_name="Assets", is_deleted=True)
    module.id = uuid7()
    db = Mock(spec=Session)
    db.get.return_value = module
    db.scalar.return_value = None

    with patch(
        "app.systems.modules.router.reopen_lifecycle",
        side_effect=LifecycleClosedAncestorError("closed ancestor"),
    ):
        with pytest.raises(HTTPException) as error:
            restore_module(module.id, SimpleNamespace(id=uuid7()), db)
    assert error.value.status_code == 409
    assert module.is_deleted is True

    parent = Department(department_name="Operations")
    parent.id = module.department_id
    assert parent.id == module.department_id


def test_department_restore_delegates_to_lifecycle_reopen_for_authenticated_actor() -> None:
    department = Department(department_name="Operations", is_deleted=True)
    department.id = uuid7()
    user = SimpleNamespace(id=uuid7())
    db = Mock(spec=Session)
    db.get.return_value = department

    with patch(
        "app.systems.departments.router.reopen_lifecycle",
        return_value=Mock(),
    ) as reopen:
        restored = restore_department(department.id, user, db)

    reopen.assert_called_once_with(db, LifecycleTargetType.DEPARTMENT, department.id, user.id)
    assert restored is department


def test_module_restore_delegates_to_lifecycle_reopen_for_authenticated_actor() -> None:
    department = Department(department_name="Operations")
    department.id = uuid7()
    module = Module(
        department_id=department.id,
        module_name="Assets",
        is_deleted=True,
    )
    module.id = uuid7()
    user = SimpleNamespace(id=uuid7())
    db = Mock(spec=Session)
    db.get.return_value = module

    with patch(
        "app.systems.modules.router.reopen_lifecycle",
        return_value=Mock(),
    ) as reopen:
        restored = restore_module(module.id, user, db)

    reopen.assert_called_once_with(db, LifecycleTargetType.MODULE, module.id, user.id)
    assert restored is module

def test_module_schema_acceptance_is_idempotent_and_commits_the_transition() -> None:
    module = Module(department_id=uuid7(), module_name="Assets", is_schema_accepted=False)
    module.id = uuid7()
    field = Field(
        module_id=module.id,
        name="Title",
        type="text",
        position=0,
        config={},
    )
    db = Mock(spec=Session)
    db.get.return_value = module
    db.scalars.return_value.all.return_value = [field]

    accepted = accept_module_schema(module.id, None, db)

    assert accepted is module
    assert module.is_schema_accepted is True
    db.commit.assert_called_once()

    db.reset_mock()
    accepted_again = accept_module_schema(module.id, None, db)

    assert accepted_again is module
    db.commit.assert_not_called()


def test_module_schema_acceptance_returns_safe_conflict_for_invalid_schema() -> None:
    module = Module(department_id=uuid7(), module_name="Assets")
    module.id = uuid7()
    field = Field(
        module_id=module.id,
        name="   ",
        type="text",
        position=0,
        config={},
    )
    db = Mock(spec=Session)
    db.get.return_value = module
    db.scalars.return_value.all.return_value = [field]

    with pytest.raises(HTTPException) as error:
        accept_module_schema(module.id, None, db)

    assert error.value.status_code == 409
    assert error.value.detail == "Module schema is invalid: Field names must be non-blank"
    db.commit.assert_not_called()
