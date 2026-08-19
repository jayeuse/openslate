from uuid import uuid7

from sqlalchemy import ForeignKey, inspect

from app.core.base_model import BaseModel
from app.systems.audit.models import AuditLog
from app.systems.departments.models import Department
from app.systems.departments.schemas import DepartmentCreate, DepartmentResponse
from app.systems.fields.models import Field
from app.systems.fields.schemas import FieldCreate, FieldUpdate
from app.systems.modules.models import Module
from app.systems.modules.schemas import ModuleCreate, ModuleUpdate
from app.systems.records.models import Record
from app.systems.records.schemas import RecordCreate, RecordUpdate
from app.systems.users.models import Role, User
from app.systems.users.schemas import RoleCreate, RoleResponse, RoleUpdate, UserResponse


def test_domain_models_inherit_base_model() -> None:
    assert all(
        issubclass(model, BaseModel)
        for model in (Role, User, Department, Module, Field, Record)
    )
    assert not issubclass(AuditLog, BaseModel)


def test_domain_columns_and_foreign_keys_match_target_schema() -> None:
    assert User.__table__.c.username.type.length == 100
    assert User.__table__.c.password_hash.type.__class__.__name__ == "Text"
    assert User.__table__.c.role_id.nullable is False
    assert Department.__table__.c.department_name.type.length == 150
    assert Module.__table__.c.module_name.type.length == 150
    assert Field.__table__.c.type.type.length == 20
    assert Field.__table__.c.position.type.python_type is int
    assert Record.__table__.c.data.nullable is False

    role_fk = next(iter(User.__table__.c.role_id.foreign_keys))
    module_fk = next(iter(Record.__table__.c.module_id.foreign_keys))
    assert isinstance(role_fk, ForeignKey)
    assert role_fk.target_fullname == "roles.id"
    assert role_fk.ondelete == "RESTRICT"
    assert module_fk.target_fullname == "modules.id"


def test_audit_log_matches_exact_immutable_shape() -> None:
    assert set(AuditLog.__table__.columns.keys()) == {
        "id",
        "created_at",
        "performed_by",
        "action",
        "entity_type",
        "entity_id",
        "before",
        "after",
        "request_id",
        "request_method",
        "request_path",
    }
    assert AuditLog.__table__.c.performed_by.nullable
    assert AuditLog.__table__.c.entity_id.nullable
    assert AuditLog.__table__.c.before.nullable
    assert AuditLog.__table__.c.after.nullable


def test_target_schemas_validate_lengths_and_defaults() -> None:
    department_id = uuid7()
    module_id = uuid7()
    department = DepartmentCreate(department_name="Operations")
    module = ModuleCreate(department_id=department_id, module_name="Assets")
    field = FieldCreate(
        module_id=module_id,
        name="Name",
        type="text",
        position=0,
    )
    record = RecordCreate(module_id=module_id)

    assert department.department_name == "Operations"
    assert module.department_id == department_id
    assert field.config == {}
    assert record.data == {}
    assert ModuleUpdate().model_dump(exclude_unset=True) == {}
    assert FieldUpdate().model_dump(exclude_unset=True) == {}
    assert RecordUpdate().model_dump(exclude_unset=True) == {}
    assert DepartmentResponse.model_fields["id"].is_required()
    assert RoleCreate(role="member").permissions == {}
    assert RoleUpdate().model_dump(exclude_unset=True) == {}
    assert RoleResponse.model_fields["permissions"].is_required()
    assert UserResponse.model_fields["role"].is_required()


def test_models_have_expected_relationships() -> None:
    assert inspect(Role).relationships["users"].key == "users"
    assert inspect(User).relationships["role"].key == "role"
    assert inspect(Department).relationships["modules"].key == "modules"
    assert inspect(Module).relationships["fields"].key == "fields"
    assert inspect(Module).relationships["records"].key == "records"
