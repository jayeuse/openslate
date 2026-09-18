from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db, model_registry  # noqa: F401
from app.systems.access.users.models import UserRole
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.router import router as fields_router
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.router import router as records_router


def make_module(*, deleted: bool = False) -> Module:
    module = Module(
        department_id=uuid7(),
        module_name="Assets",
        is_deleted=deleted,
        is_schema_accepted=True,
    )
    module.id = uuid7()
    return module


def make_field(
    module_id: UUID,
    field_type: FieldType = FieldType.TEXT,
    *,
    required: bool = False,
    config: dict[str, object] | None = None,
    deleted: bool = False,
    audit_redacted: bool = False,
) -> Field:
    field = Field(
        module_id=module_id,
        name="Title",
        type=field_type,
        required=required,
        position=0,
        config=config or {},
        is_deleted=deleted,
        audit_redacted=audit_redacted,
    )
    field.id = uuid7()
    return field


def _make_validation_client(
    *, role: UserRole = UserRole.ADMIN, db: Session | None = None
) -> TestClient:
    app = FastAPI()
    app.include_router(fields_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    database = db or Mock(spec=Session)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        role=SimpleNamespace(role=role)
    )
    app.dependency_overrides[get_db] = lambda: database
    return TestClient(app)
