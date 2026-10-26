"""Existing Dashboard route builders with real owned sessions and unchanged auth transport."""

from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.dashboards.router import router
from app.systems.openview.dashboards.schemas import DashboardChartConfig
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.live_session_support import with_live_session
from tests.rbac.support import add_user, make_group_access, organization

_ACTORS_KEY = "dashboard_test_actors"


def _actor(db: Session, *, level: str = AccessLevel.MANAGE) -> User:
    """A member who gets ``level`` on every department that :func:`_module` creates later."""

    user = add_user(db, "dash")
    db.info.setdefault(_ACTORS_KEY, []).append((user, level))
    return user


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    return with_live_session(TestClient(app), db, actor)


def _department(db: Session, name: str = "Dashboards") -> Department:
    department = Department(org_id=organization(db).id, department_name=f"{name} {uuid7().hex}")
    db.add(department)
    db.flush()
    for actor, level in db.info.get(_ACTORS_KEY, []):
        make_group_access(db, [actor], department, level=level)
    return department


def _module(
    db: Session, *, name: str = "Dashboard records", department: Department | None = None
) -> tuple[Module, Field]:
    department = department or _department(db, name)
    module = Module(
        org_id=department.org_id,
        department_id=department.id,
        module_name=name,
    )
    db.add(module)
    db.flush()
    dimension = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Status",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    db.add(dimension)
    db.flush()
    return module, dimension


def _chart_config(module: Module, dimension: Field, chart_type: str = "bar") -> dict[str, object]:
    return DashboardChartConfig.model_validate(
        {
            "version": 1,
            "chart_type": chart_type,
            "query": {
                "module_id": str(module.id),
                "definition": {"version": 1, "columns": []},
                "mode": "groups",
                "dimension": {"field_id": str(dimension.id), "expected_type": "text"},
                "aggregation": "count",
            },
        }
    ).model_dump(mode="json")


Cells = tuple[int, int, int, int]


def _cells(cells: Cells) -> dict[str, int]:
    """Grid placement as (column, row, columns, rows)."""
    column, row, columns, rows = cells
    return {"grid_column": column, "grid_row": row, "column_span": columns, "row_span": rows}


def _chart(
    module: Module, dimension: Field, at: Cells = (0, 0, 2, 2), chart_type: str = "bar"
) -> dict[str, object]:
    config = _chart_config(module, dimension, chart_type)
    return {"widget_type": "chart", **_cells(at), "config": config}


def _aggregate_widget(
    widget_type: str, module: Module, dimension: Field, at: Cells | None = None
) -> dict[str, object]:
    default: Cells = (0, 0, 1, 1) if widget_type == "summary" else (0, 0, 2, 2)
    return {
        "widget_type": widget_type,
        **_cells(at or default),
        "config": {
            "version": 1,
            "query": {
                "module_id": str(module.id),
                "definition": {"version": 1, "columns": []},
                "mode": "groups",
                "dimension": {"field_id": str(dimension.id), "expected_type": "text"},
                "aggregation": "count",
            },
        },
    }


def _records_widget(module: Module, field: Field, at: Cells = (0, 0, 2, 2)) -> dict[str, object]:
    return {
        "widget_type": "records",
        **_cells(at),
        "config": {
            "version": 1,
            "query": {
                "module_id": str(module.id),
                "definition": {
                    "version": 1,
                    "columns": [
                        {"field_id": str(field.id), "expected_type": "text"},
                    ],
                },
            },
        },
    }


def _dashboard_audit_rows(db: Session, dashboard_id: UUID) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.entity_type == "dashboards", AuditLog.entity_id == dashboard_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )
