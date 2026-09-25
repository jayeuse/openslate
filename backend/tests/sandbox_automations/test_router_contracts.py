"""Authorization and wire contract for recent automation activity."""

from datetime import UTC, datetime
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.sandbox.automations.router import router
from app.systems.sandbox.automations.schemas import (
    AutomationRunListResponse,
    AutomationRunResponse,
)
from tests.rbac.support import make_user


def test_recent_runs_require_every_structure_read_capability(monkeypatch) -> None:
    import app.systems.sandbox.automations.router as automation_router

    database = Mock(spec=Session)
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: database
    current_user = make_user(
        "partial",
        permissions={Capability.MODULES_READ.value: True},
    )
    application.dependency_overrides[get_current_user] = lambda: current_user

    def authorize_current_user(*_args, capabilities, **_kwargs):
        if not all(has_capability(current_user.role, capability) for capability in capabilities):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return current_user

    monkeypatch.setattr(
        "app.common.dependencies.auth.authorize_workspace_capabilities",
        authorize_current_user,
    )
    client = TestClient(application)

    assert client.get("/api/sandbox/automation-runs").status_code == 403

    response_model = AutomationRunListResponse(
        items=[
            AutomationRunResponse(
                id=uuid7(),
                createdAt=datetime.now(UTC),
                automationId=uuid7(),
                automationName="Set request status",
                eventKind="field-changed",
                state="succeeded",
                details={"actionsApplied": 1},
                attempts=1,
            )
        ],
        limit=20,
        offset=0,
        count=1,
        total=1,
        hasMore=False,
    )
    monkeypatch.setattr(automation_router, "list_recent_runs", lambda *_args, **_kw: response_model)
    current_user = make_user(
        "reader",
        permissions={
            Capability.MODULES_READ.value: True,
            Capability.FIELDS_READ.value: True,
            Capability.RELATIONSHIPS_READ.value: True,
            Capability.DEPARTMENTS_READ.value: True,
        },
    )

    response = client.get("/api/sandbox/automation-runs?limit=20&offset=0")

    assert response.status_code == 200
    assert response.json() == response_model.model_dump(by_alias=True, mode="json")
    assert client.get("/api/sandbox/automation-runs?limit=51").status_code == 422
