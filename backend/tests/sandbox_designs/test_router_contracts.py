from unittest.mock import Mock

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.designs.schemas import DocumentResponse
from app.systems.sandbox.designs.service import (
    SandboxDesignError,
    canonical_document,
)
from tests.sandbox_designs.fixtures import sample_document


def _document_response() -> DocumentResponse:
    document = sample_document()
    _, content_hash, byte_count = canonical_document(document)
    return DocumentResponse(
        document=document,
        revision=1,
        contentHash=content_hash,
        byteCount=byte_count,
        issues=[],
    )


def test_document_read_requires_every_structural_read_capability(monkeypatch) -> None:
    import app.systems.sandbox.designs.router as designs_router
    from tests.rbac.support import make_user

    application = create_app()
    application.dependency_overrides[get_db] = lambda: Mock(spec=Session)
    monkeypatch.setattr(designs_router, "read_document", lambda _db: _document_response())
    partial = make_user("partial", permissions={Capability.DEPARTMENTS_READ.value: True})
    application.dependency_overrides[get_current_user] = lambda: partial

    assert TestClient(application).get("/api/sandbox/document").status_code == 403

    application.dependency_overrides[get_current_user] = lambda: make_user(
        "reader",
        permissions={
            capability.value: True
            for capability in (
                Capability.DEPARTMENTS_READ,
                Capability.MODULES_READ,
                Capability.FIELDS_READ,
                Capability.RELATIONSHIPS_READ,
            )
        },
    )
    response = TestClient(application).get("/api/sandbox/document")

    assert response.status_code == 200
    assert response.json()["document"]["schemaVersion"] == 2


def test_document_write_returns_route_local_stale_revision_conflict(monkeypatch) -> None:
    import app.systems.sandbox.designs.router as designs_router
    from tests.rbac.support import make_user

    database = Mock(spec=Session)
    application = create_app()
    application.dependency_overrides[get_db] = lambda: database
    application.dependency_overrides[get_current_user] = lambda: make_user(
        "writer",
        permissions={
            capability.value: True
            for capability in (
                Capability.DEPARTMENTS_WRITE,
                Capability.MODULES_WRITE,
                Capability.FIELDS_WRITE,
                Capability.RELATIONSHIPS_WRITE,
            )
        },
    )
    monkeypatch.setattr(
        designs_router,
        "replace_document",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            SandboxDesignError("stale_revision", "reload before saving", 409)
        ),
    )

    response = TestClient(application).put(
        "/api/sandbox/document",
        json={
            "expectedRevision": 1,
            "document": sample_document().model_dump(by_alias=True),
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_revision"
    database.rollback.assert_called_once()
