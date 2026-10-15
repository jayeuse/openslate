"""One department, module and text field, and route clients for OpenView access tests."""

from dataclasses import dataclass

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.live_session_support import with_live_session
from tests.rbac.support import add_department, add_module


@dataclass(frozen=True)
class Area:
    department: Department
    module: Module
    field: Field


def new_area(db: Session) -> Area:
    department = add_department(db)
    module = add_module(db, department)
    field = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Status",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    db.add(field)
    db.flush()
    return Area(department, module, field)


def route_client(db: Session, actor: User, *routers: APIRouter) -> TestClient:
    app = FastAPI()
    for router in routers:
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    return with_live_session(TestClient(app), db, actor)


def field_reference(field: Field) -> dict[str, str]:
    return {"field_id": str(field.id), "expected_type": "text"}


def view_payload(area: Area, name: str, *, is_default: bool = False) -> dict[str, object]:
    return {
        "module_id": str(area.module.id),
        "name": name,
        "definition": {"version": 1, "columns": [field_reference(area.field)]},
        "is_default": is_default,
    }
