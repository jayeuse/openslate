"""Owner-private Chart preference routes on runner-owned PostgreSQL."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.openview.charts.models import UserChartPreference
from app.systems.openview.charts.router import router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module

pytestmark = pytest.mark.integration


def actor(db: Session, *, can_write: bool = True) -> User:
    permissions = {"records.read": True}
    if can_write:
        permissions["records.write"] = True
    role = Role(role=f"chart-preference-{uuid7().hex}", permissions=permissions)
    db.add(role)
    db.flush()
    user = User(
        email=f"chart-{uuid7().hex}@example.test",
        username=f"chart_{uuid7().hex[:20]}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
    )
    db.add(user)
    db.flush()
    return user


def client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def chart_config(module: Module, dimension: Field, date_field: Field) -> dict[str, object]:
    return {
        "version": 1,
        "module_id": str(module.id),
        "chart_type": "bar",
        "dimension_id": str(dimension.id),
        "date_field_id": str(date_field.id),
        "aggregation": "count",
        "measure_id": None,
        "filter_logic": "or",
        "filters": [],
        "from_date": "2026-09-01",
        "to_date": "2026-09-30",
        "top": 5,
        "show_legend": False,
        "show_values": True,
    }


def test_chart_preferences_are_private_and_saved_by_the_authenticated_owner(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = actor(db)
    other = actor(db)
    department = Department(department_name=f"Chart preferences {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name="Preference source",
    )
    db.add(module)
    db.flush()
    dimension = Field(
        module_id=module.id,
        name="Status",
        type=FieldType.SELECT,
        required=False,
        position=0,
        config={"options": ["Open"]},
    )
    date_field = Field(
        module_id=module.id,
        name="Scheduled",
        type=FieldType.DATE,
        required=False,
        position=1,
        config={},
    )
    db.add_all([dimension, date_field])
    db.flush()
    config = chart_config(module, dimension, date_field)
    payload = {"config": config}
    set_audit_actor(db, owner.id)

    with client(db, owner) as owner_client, client(db, other) as other_client:
        assert owner_client.get("/api/charts/preferences").json() == {"config": None}
        saved = owner_client.put("/api/charts/preferences", json=payload)
        assert saved.status_code == 200
        assert saved.json() == payload

        assert other_client.get("/api/charts/preferences").json() == {"config": None}
        assert other_client.put("/api/charts/preferences", json=payload).status_code == 200

        assert owner_client.get("/api/charts/preferences").json() == payload
        assert db.query(UserChartPreference).count() == 2

        reset_config = {
            **config,
            "filter_logic": "and",
            "filters": [],
            "from_date": None,
            "to_date": None,
            "top": None,
            "show_legend": True,
            "show_values": True,
        }
        reset = owner_client.put(
            "/api/charts/preferences", json={"config": reset_config}
        )
        assert reset.status_code == 200
        assert owner_client.get("/api/charts/preferences").json() == {
            "config": reset_config
        }
        assert other_client.get("/api/charts/preferences").json() == payload
        assert db.query(UserChartPreference).count() == 2


def test_chart_preferences_reject_stale_field_references(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = actor(db)
    department = Department(department_name=f"Chart stale field {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name="Stale preference source",
    )
    db.add(module)
    db.flush()
    dimension = Field(
        module_id=module.id,
        name="Status",
        type=FieldType.SELECT,
        required=False,
        position=0,
        config={},
    )
    date_field = Field(
        module_id=module.id,
        name="Scheduled",
        type=FieldType.DATE,
        required=False,
        position=1,
        config={},
    )
    other_module = Module(
        department_id=department.id,
        module_name="Unrelated source",
    )
    db.add_all([dimension, date_field, other_module])
    db.flush()
    unrelated = Field(
        module_id=other_module.id,
        name="Private field reference",
        type=FieldType.DATE,
        required=False,
        position=0,
        config={},
    )
    db.add(unrelated)
    db.flush()

    payload = {"config": chart_config(module, dimension, unrelated)}
    with client(db, owner) as test_client:
        response = test_client.put("/api/charts/preferences", json=payload)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "chart_preferences_invalid"


def test_chart_preferences_require_read_and_write_to_save(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    read_only_user = actor(db, can_write=False)
    config = {
        "version": 1,
        "module_id": str(uuid7()),
        "chart_type": "bar",
        "dimension_id": str(uuid7()),
        "date_field_id": None,
        "aggregation": "count",
        "measure_id": None,
        "filter_logic": "and",
        "filters": [],
        "from_date": None,
        "to_date": None,
        "top": None,
        "show_legend": True,
        "show_values": True,
    }

    with client(db, read_only_user) as test_client:
        response = test_client.put(
            "/api/charts/preferences", json={"config": config}
        )

    assert response.status_code == 403
    assert db.query(UserChartPreference).count() == 0
