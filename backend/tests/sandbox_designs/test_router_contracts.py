from unittest.mock import Mock

from sqlalchemy.orm import Session

from app.main import create_app
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


def test_document_read_is_administrator_only(monkeypatch) -> None:
    import app.systems.sandbox.designs.router as designs_router
    from tests.rbac.support import _client, make_user

    application = create_app()
    database = Mock(spec=Session)
    monkeypatch.setattr(designs_router, "read_document", lambda _db: _document_response())
    partial = make_user("partial", role="member")

    assert _client(application, partial, database).get("/api/sandbox/document").status_code == 403

    reader = make_user("reader")
    response = _client(application, reader, database).get("/api/sandbox/document")

    assert response.status_code == 200
    assert response.json()["document"]["schemaVersion"] == 4


def test_document_write_returns_route_local_stale_revision_conflict(monkeypatch) -> None:
    import app.systems.sandbox.designs.router as designs_router
    from tests.rbac.support import _client, make_user

    database = Mock(spec=Session)
    application = create_app()
    writer = make_user("writer")
    monkeypatch.setattr(
        designs_router,
        "replace_document",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            SandboxDesignError("stale_revision", "reload before saving", 409)
        ),
    )

    response = _client(application, writer, database).put(
        "/api/sandbox/document",
        json={
            "expectedRevision": 1,
            "document": sample_document().model_dump(by_alias=True),
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_revision"
    database.rollback.assert_called_once()


def test_document_write_refuses_an_older_format_with_a_clear_422(monkeypatch) -> None:
    import app.systems.sandbox.designs.router as designs_router
    from tests.rbac.support import _client, make_user

    database = Mock(spec=Session)
    application = create_app()
    writer = make_user("writer")
    replace = Mock()
    monkeypatch.setattr(designs_router, "replace_document", replace)
    older = {
        "kind": "openslate-sandbox",
        "schemaVersion": 2,
        "design": {"departments": [], "modules": [], "relationships": [], "layout": {}},
        "automations": [],
        "scenarios": [],
    }

    response = _client(application, writer, database).put(
        "/api/sandbox/document", json={"expectedRevision": 1, "document": older}
    )

    assert response.status_code == 422
    assert [error["msg"] for error in response.json()["detail"]] == [
        "This design uses an older format and cannot be opened."
    ]
    replace.assert_not_called()
