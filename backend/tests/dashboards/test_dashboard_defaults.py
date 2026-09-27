"""Current-user Dashboard default behavior on runner-owned PostgreSQL."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.dashboards.models import Dashboard, DashboardDefault
from app.systems.openview.dashboards.router import router
from tests.rbac.support import capability_actor


def test_dashboard_default_routes_precede_dashboard_id_route() -> None:
    paths = [(route.path, route.methods) for route in router.routes]
    default_position = next(
        index for index, (path, _) in enumerate(paths) if path == "/dashboards/default"
    )
    dashboard_position = next(
        index for index, (path, _) in enumerate(paths) if path == "/dashboards/{dashboard_id}"
    )
    assert default_position < dashboard_position
    assert paths[default_position][1] == {"GET"}
    assert paths[default_position + 1] == ("/dashboards/default", {"PUT"})


def _actor(db: Session, capabilities: dict[str, bool]) -> User:
    return capability_actor(db, "default", capabilities)


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


@pytest.mark.integration
def test_personal_default_persists_switches_clears_and_hides_archived_dashboard(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    first = Dashboard(owner_id=owner.id, name="First")
    second = Dashboard(owner_id=owner.id, name="Second")
    db.add_all([first, second])
    db.flush()
    set_audit_actor(db, owner.id)

    with _client(db, owner) as client:
        empty = client.get("/api/dashboards/default")
        assert empty.status_code == 200
        assert empty.json() == {"dashboard_id": None}
        assert empty.headers["cache-control"] == "private, no-store"

        selected = client.put("/api/dashboards/default", json={"dashboard_id": str(first.id)})
        assert selected.status_code == 200
        assert selected.json() == {"dashboard_id": str(first.id)}
        assert client.get("/api/dashboards/default").json() == selected.json()
        unchanged = client.put("/api/dashboards/default", json={"dashboard_id": str(first.id)})
        assert unchanged.status_code == 200

        switched = client.put("/api/dashboards/default", json={"dashboard_id": str(second.id)})
        assert switched.status_code == 200
        assert switched.json() == {"dashboard_id": str(second.id)}
        stored = db.scalar(select(DashboardDefault).where(DashboardDefault.user_id == owner.id))
        assert stored is not None and stored.dashboard_id == second.id

        archived = client.delete(f"/api/dashboards/{second.id}?revision=1")
        assert archived.status_code == 204
        assert client.get("/api/dashboards/default").json() == {"dashboard_id": None}
        stored = db.scalar(select(DashboardDefault).where(DashboardDefault.user_id == owner.id))
        assert stored is not None and stored.dashboard_id == second.id
        unavailable = client.put("/api/dashboards/default", json={"dashboard_id": str(second.id)})
        assert unavailable.status_code == 409

        restored = client.post(f"/api/dashboards/{second.id}/restore", json={"revision": 2})
        assert restored.status_code == 200
        assert client.get("/api/dashboards/default").json() == {"dashboard_id": str(second.id)}

    with _client(db, owner) as reloaded:
        assert reloaded.get("/api/dashboards/default").json() == {"dashboard_id": str(second.id)}
        cleared = reloaded.put("/api/dashboards/default", json={"dashboard_id": None})
        assert cleared.status_code == 200
        assert cleared.json() == {"dashboard_id": None}
        assert reloaded.get("/api/dashboards/default").json() == {"dashboard_id": None}

    assert db.scalar(select(DashboardDefault).where(DashboardDefault.user_id == owner.id)) is None
    actions = db.scalars(
        select(AuditLog.action).where(
            AuditLog.entity_type == "dashboard_defaults",
            AuditLog.performed_by == owner.id,
        )
    ).all()
    assert actions.count(AuditAction.CREATE) == 1
    assert actions.count(AuditAction.UPDATE) == 1
    assert actions.count(AuditAction.DELETE) == 1


@pytest.mark.integration
def test_personal_default_rejects_foreign_and_archived_artifacts_without_leaking(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    outsider = _actor(db, {"records.read": True, "records.write": True})
    reader = _actor(db, {"records.read": True})
    writer = _actor(db, {"records.write": True})
    foreign = Dashboard(owner_id=outsider.id, name="Foreign")
    archived = Dashboard(
        owner_id=owner.id,
        name="Archived",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add_all([foreign, archived])
    db.flush()
    set_audit_actor(db, owner.id)

    with _client(db, owner) as client:
        for dashboard_id in (foreign.id, archived.id, UUID(int=0)):
            rejected = client.put(
                "/api/dashboards/default", json={"dashboard_id": str(dashboard_id)}
            )
            assert rejected.status_code == 409
            assert rejected.json()["detail"]["code"] == "default_dashboard_invalid"
        assert client.get("/api/dashboards/default").json() == {"dashboard_id": None}
        assert client.put("/api/dashboards/default", json={}).status_code == 422

    with _client(db, reader) as client:
        assert client.get("/api/dashboards/default").status_code == 200
        assert client.put("/api/dashboards/default", json={"dashboard_id": None}).status_code == 403
    with _client(db, writer) as client:
        assert client.get("/api/dashboards/default").status_code == 200
        assert client.put("/api/dashboards/default", json={"dashboard_id": None}).status_code == 200
