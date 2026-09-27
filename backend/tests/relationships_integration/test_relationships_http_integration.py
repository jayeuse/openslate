"""Registered relationship API contracts against PostgreSQL."""
from __future__ import annotations

import os
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import create_app

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]
pytest_plugins = ("tests.relationships_integration.relationship_http_support",)


def _payload(field_id: object, source_id: object, target_id: object) -> dict[str, str]:
    return {
        "field_id": str(field_id),
        "source_record_id": str(source_id),
        "target_record_id": str(target_id),
    }


def test_create_route_persists_and_rejects_duplicate_edge(relationship_http_fixture) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    with relationship_http_fixture.client() as client:
        created = client.post(
            "/api/relationships",
            json=_payload(graph.field_id, graph.source_id, graph.target_id),
        )
        assert created.status_code == 201
        body = created.json()
        assert "data" not in body
        assert body["field_id"] == str(graph.field_id)
        assert body["source_record_id"] == str(graph.source_id)
        assert body["target_record_id"] == str(graph.target_id)
        assert body["visibility"] == "available"

        duplicate = client.post(
            "/api/relationships",
            json=_payload(graph.field_id, graph.source_id, graph.target_id),
        )

    assert duplicate.status_code == 409
    assert len(relationship_http_fixture.active_edge_ids()) == 1


def test_assign_route_replaces_and_clears_using_fresh_request_sessions(
    relationship_http_fixture,
) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    with relationship_http_fixture.client() as client:
        created = client.post(
            "/api/relationships",
            json=_payload(graph.field_id, graph.source_id, graph.target_id),
        )
        assert created.status_code == 201
        original_id = created.json()["id"]

        replacement = client.put(
            f"/api/relationships/fields/{graph.field_id}/sources/{graph.source_id}",
            json={"target_record_id": str(graph.replacement_id)},
        )
        assert replacement.status_code == 200
        assert replacement.json()["target_record_id"] == str(graph.replacement_id)
        assert replacement.json()["id"] != original_id

        cleared = client.put(
            f"/api/relationships/fields/{graph.field_id}/sources/{graph.source_id}",
            json={"target_record_id": None},
        )
        assert cleared.status_code == 200
        assert cleared.json() is None

    assert relationship_http_fixture.active_edge_ids() == set()


def test_delete_route_unlinks_edge_without_deleting_domain_rows(relationship_http_fixture) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    with relationship_http_fixture.client() as client:
        created = client.post(
            "/api/relationships",
            json=_payload(graph.field_id, graph.source_id, graph.target_id),
        )
        assert created.status_code == 201
        edge_id = created.json()["id"]
        deleted = client.delete(f"/api/relationships/{edge_id}")
        assert deleted.status_code == 204
        assert deleted.content == b""

    assert relationship_http_fixture.active_edge_ids() == set()
    with relationship_http_fixture.owner_engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT is_deleted FROM public.relationship_edges "
                "WHERE field_id = :field_id"
            ),
            {"field_id": graph.field_id},
        ).scalars().all()
    assert rows == [True]


def test_relationship_validation_returns_contract_statuses_without_mutation(
    relationship_http_fixture,
) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    relationship_http_fixture.archive_target()
    with relationship_http_fixture.client() as client:
        inactive = client.post(
            "/api/relationships",
            json=_payload(graph.field_id, graph.source_id, graph.target_id),
        )
        assert inactive.status_code == 409
        assert "not active" in inactive.json()["detail"]

        cross_department = client.post(
            "/api/relationships",
            json=_payload(graph.cross_field_id, graph.source_id, graph.cross_target_id),
        )
        assert cross_department.status_code == 409
        assert "same department" in cross_department.json()["detail"]

        relationship_http_fixture.restore_target()
        self_link = client.post(
            "/api/relationships",
            json=_payload(graph.self_field_id, graph.source_id, graph.source_id),
        )
        assert self_link.status_code == 422
        assert "differ" in self_link.json()["detail"]

    assert relationship_http_fixture.active_edge_ids() == set()


def test_visibility_projection_hides_archived_target_from_available_list(
    relationship_http_fixture,
) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    with relationship_http_fixture.client() as client:
        created = client.post(
            "/api/relationships",
            json=_payload(graph.field_id, graph.source_id, graph.target_id),
        )
        assert created.status_code == 201
        edge_id = created.json()["id"]
    relationship_http_fixture.archive_target()

    with relationship_http_fixture.client() as client:
        available = client.get(f"/api/relationships?field_id={graph.field_id}")
        assert available.status_code == 200
        assert available.json()["items"] == []

        hidden = client.get(
            f"/api/relationships?field_id={graph.field_id}&availability=hidden"
        )
        assert hidden.status_code == 200
        assert hidden.json()["items"][0]["id"] == edge_id
        assert hidden.json()["items"][0]["visibility"] == "hidden"
        assert hidden.json()["items"][0]["hidden_reasons"] == ["target_record_archived"]


def test_member_without_a_group_for_the_department_sees_and_changes_no_relationship(
    relationship_http_fixture,
) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    member = relationship_http_fixture.member
    assert member is not None
    with relationship_http_fixture.client(relationship_http_fixture.actor) as client:
        payload = _payload(graph.field_id, graph.source_id, graph.target_id)
        created = client.post("/api/relationships", json=payload)
        assert created.status_code == 201
    edge_id = created.json()["id"]
    with relationship_http_fixture.client(member) as client:
        listed = client.get(f"/api/relationships?field_id={graph.field_id}")
        assert listed.status_code == 200
        assert listed.json()["items"] == []
        assert client.get(f"/api/relationships/{edge_id}").status_code == 404
        assert client.post("/api/relationships", json=payload).status_code == 404
        assert (
            client.put(
                f"/api/relationships/fields/{graph.field_id}/sources/{graph.source_id}",
                json={"target_record_id": str(graph.target_id)},
            ).status_code
            == 404
        )
        assert client.delete(f"/api/relationships/{edge_id}").status_code == 404

    assert relationship_http_fixture.active_edge_ids() == {UUID(edge_id)}


def test_registered_route_requires_bearer_credentials() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/relationships")
    assert response.status_code == 401
