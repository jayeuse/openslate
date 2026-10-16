"""Authorization and wire contract for recent trigger activity."""

from datetime import UTC, datetime
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.sandbox.record_triggers.router import router
from app.systems.sandbox.record_triggers.schemas import (
    TriggerRunListResponse,
    TriggerRunResponse,
)
from tests.organization_scope_support import scoped_override
from tests.rbac.support import make_user


def test_recent_runs_are_administrator_only(monkeypatch) -> None:
    import app.systems.sandbox.record_triggers.router as trigger_router

    database = Mock(spec=Session)
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: database
    current_user, membership = make_user("partial", role="member")
    database.dirty = set()
    database.scalars.return_value.all.return_value = [membership]
    application.dependency_overrides[get_current_user] = scoped_override(lambda: current_user)
    client = TestClient(application)

    assert client.get("/api/sandbox/trigger-runs").status_code == 403

    response_model = TriggerRunListResponse(
        items=[
            TriggerRunResponse(
                id=uuid7(),
                createdAt=datetime.now(UTC),
                triggerId=uuid7(),
                triggerName="Set request status",
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
    monkeypatch.setattr(trigger_router, "list_recent_runs", lambda *_args, **_kw: response_model)
    current_user, membership = make_user("reader")
    database.scalars.return_value.all.return_value = [membership]

    response = client.get("/api/sandbox/trigger-runs?limit=20&offset=0")

    assert response.status_code == 200
    assert response.json() == response_model.model_dump(by_alias=True, mode="json")
    assert client.get("/api/sandbox/trigger-runs?limit=51").status_code == 422
