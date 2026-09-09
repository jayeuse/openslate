from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.common.listing import PaginationMetadata
from app.core.database import get_db
from app.main import create_app
from app.systems.relationships.schemas import RelationshipListResponse
from app.systems.relationships.service import relationship_response
from tests.test_relationships import (
    make_edge,
    make_module,
    make_record,
    make_relationship_field,
)


def _client(database: Session, *, role: str = "admin") -> TestClient:
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=uuid7(),
        role=SimpleNamespace(role=role, permissions={}),
    )
    app.dependency_overrides[get_db] = lambda: database
    return TestClient(app)


def _edge() -> object:
    module = make_module()
    field = make_relationship_field(module, module)
    source = make_record(module)
    target = make_record(module)
    return make_edge(field, source, target)


def test_registered_create_route_returns_created_relationship() -> None:
    database = Mock(spec=Session)
    edge = _edge()
    with patch(
        "app.systems.relationships.router.create_relationship_service",
        return_value=edge,
    ) as create:
        response = _client(database).post(
            "/api/relationships",
            json={
                "field_id": str(edge.field_id),
                "source_record_id": str(edge.source_record_id),
                "target_record_id": str(edge.target_record_id),
            },
        )

    assert response.status_code == 201
    assert response.json()["id"] == str(edge.id)
    create.assert_called_once_with(
        database, edge.field_id, edge.source_record_id, edge.target_record_id
    )


def test_registered_assign_route_supports_replace_and_clear() -> None:
    database = Mock(spec=Session)
    edge = _edge()
    with patch(
        "app.systems.relationships.router.assign_relationship_service",
        side_effect=[edge, None],
    ) as assign:
        replacement = _client(database).put(
            f"/api/relationships/fields/{edge.field_id}/sources/{edge.source_record_id}",
            json={"target_record_id": str(edge.target_record_id)},
        )
        cleared = _client(database).put(
            f"/api/relationships/fields/{edge.field_id}/sources/{edge.source_record_id}",
            json={"target_record_id": None},
        )

    assert replacement.status_code == 200
    assert replacement.json()["id"] == str(edge.id)
    assert cleared.status_code == 200
    assert cleared.json() is None
    assert assign.call_count == 2


def test_registered_unlink_route_returns_no_content() -> None:
    database = Mock(spec=Session)
    edge = _edge()
    with patch(
        "app.systems.relationships.router.unlink_relationship_service"
    ) as unlink:
        response = _client(database).delete(f"/api/relationships/{edge.id}")

    assert response.status_code == 204
    assert response.content == b""
    unlink.assert_called_once_with(database, edge.id)


def test_registered_list_route_serializes_visibility_and_requires_read_capability() -> None:
    database = Mock(spec=Session)
    edge = _edge()
    edge.field.is_deleted = True  # type: ignore[attr-defined]
    pagination = PaginationMetadata(limit=25, offset=0, count=1, total=1, has_more=False)
    with patch(
        "app.systems.relationships.router.list_relationships_service",
        return_value=([relationship_response(edge)], pagination),
    ):
        response = _client(database).get(
            f"/api/relationships?field_id={edge.field_id}&availability=hidden"
        )

    assert response.status_code == 200
    assert response.json()["items"][0]["visibility"] == "hidden"
    assert response.json()["items"][0]["hidden_reasons"] == ["field_archived"]
    assert RelationshipListResponse.model_fields.keys() >= {"items", "pagination"}

    denied = _client(database, role="staff").get("/api/relationships")
    assert denied.status_code == 403
