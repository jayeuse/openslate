"""Live person assignments use the current module-reader policy."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.router import router as modules_router
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import router as records_router
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(modules_router, prefix="/api")
    app.include_router(records_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def test_assignable_picker_and_record_writes_follow_current_module_readers(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = add_department(db)
    module = add_module(db, department)
    assignee = Field(
        module_id=module.id,
        name="Assignee",
        type="user",
        position=0,
        required=False,
        config={},
    )
    db.add(assignee)
    writer = add_user(db, "assignment-writer", role=UserRole.ADMIN)
    eligible = add_user(db, "assignment-eligible", role=UserRole.MEMBER)
    eligible.display_name = "Alex Reader"
    outsider = add_user(db, "assignment-outsider", role=UserRole.MEMBER)
    disabled = add_user(db, "assignment-disabled", role=UserRole.MEMBER, status=UserStatus.DISABLED)
    grant = make_group_access(db, [eligible, disabled], department, module)
    db.commit()

    picker_path = f"/api/modules/{module.id}/assignable-users"
    with _client(db, outsider) as client:
        hidden = client.get(picker_path)
    assert hidden.status_code == 404
    with _client(db, writer) as client:
        picker = client.get(picker_path)
        assert picker.status_code == 200, picker.text
        assert picker.headers["cache-control"] == "private, no-store"
        entries = {item["id"]: item for item in picker.json()["items"]}
        assert str(eligible.id) in entries
        assert entries[str(eligible.id)] == {
            "id": str(eligible.id),
            "display_name": "Alex Reader",
            "username": eligible.username,
        }
        assert str(disabled.id) not in entries
        assert str(outsider.id) not in entries
        assert "email" not in picker.text

        invalid = client.post(
            "/api/records",
            json={"module_id": str(module.id), "data": {str(assignee.id): str(outsider.id)}},
        )
        assert invalid.status_code == 422
        assert invalid.json()["detail"]["code"] == "record_validation_failed"
        assert (
            db.scalar(select(func.count()).select_from(Record).where(Record.module_id == module.id))
            == 0
        )

        created = client.post(
            "/api/records",
            json={"module_id": str(module.id), "data": {str(assignee.id): str(eligible.id)}},
        )
        assert created.status_code == 201, created.text
        record_id = created.json()["id"]
        assert created.json()["data"][str(assignee.id)] == str(eligible.id)
        assert created.json()["display_values"][str(assignee.id)] == "Alex Reader"

        grant.is_deleted = True
        db.commit()
        historical = client.get(f"/api/records/{record_id}")
        assert historical.status_code == 200
        assert historical.json()["data"][str(assignee.id)] == str(eligible.id)
        assert historical.json()["display_values"][str(assignee.id)] == "Unavailable user"
        denied = client.patch(
            f"/api/records/{record_id}",
            json={"data": {str(assignee.id): str(eligible.id)}},
            headers={"If-Match": f'"{historical.json()["updated_at"]}"'},
        )
        assert denied.status_code == 422
        assert denied.json()["detail"]["code"] == "record_validation_failed"
        assert client.delete(f"/api/records/{record_id}").status_code == 204
        refused_restore = client.post(f"/api/records/{record_id}/restore")
        assert refused_restore.status_code == 422
        stored = db.get(Record, record_id)
        assert stored is not None and stored.is_deleted
        assert stored.data[str(assignee.id)] == str(eligible.id)
