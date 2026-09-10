"""Scan requests schedule work without holding a scanner or Storage dependency."""

from datetime import UTC, datetime
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.files import service
from app.systems.files.providers import get_scanner, transfer_slot
from app.systems.files.router import router
from app.systems.files.schemas import FileResponse
from app.systems.files.storage import get_storage
from app.systems.users.models import Role, User


def test_scan_endpoint_returns_202_location_without_provider_access(monkeypatch):
    file_id, actor_id = uuid4(), uuid4()
    item = FileResponse(
        id=file_id,
        purpose="library_document",
        record_id=None,
        creator_id=actor_id,
        filename="document.pdf",
        media_type="application/pdf",
        expected_size=10,
        actual_size=10,
        state="pending_scan",
        failure_code=None,
        is_deleted=False,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: User(
        id=actor_id, status="active", is_deleted=False, role=Role(role="admin", is_deleted=False)
    )
    app.dependency_overrides[get_db] = lambda: None

    def forbidden_provider():
        raise AssertionError("A queue-only request resolved an external provider")

    app.dependency_overrides[get_storage] = forbidden_provider
    app.dependency_overrides[get_scanner] = forbidden_provider
    monkeypatch.setattr(service, "scan", lambda *args: item)

    @app.middleware("http")
    async def admitted(request, call_next):
        with transfer_slot() as lease:
            request.state.file_transfer_lease = lease
            return await call_next(request)

    with TestClient(app) as client:
        result = client.post(f"/api/files/{file_id}/scan")
    assert result.status_code == 202
    assert result.headers["location"] == f"/api/files/{file_id}"
    assert result.json()["state"] == "pending_scan"
