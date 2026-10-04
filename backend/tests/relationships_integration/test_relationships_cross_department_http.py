"""Registered relationship API contracts for links between two departments."""

from __future__ import annotations

import os
from uuid import UUID

import pytest

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


def test_admin_creates_lists_replaces_and_deletes_a_cross_department_link(
    relationship_http_fixture,
) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    with relationship_http_fixture.client() as client:
        created = client.post(
            "/api/relationships",
            json=_payload(graph.cross_field_id, graph.source_id, graph.cross_target_id),
        )
        assert created.status_code == 201
        edge = created.json()
        assert edge["field_id"] == str(graph.cross_field_id)
        assert edge["source_record_id"] == str(graph.source_id)
        assert edge["target_record_id"] == str(graph.cross_target_id)
        assert edge["visibility"] == "available"
        assert edge["hidden_reasons"] == []
        assert relationship_http_fixture.active_edge_ids() == {UUID(edge["id"])}

        by_field = client.get(f"/api/relationships?field_id={graph.cross_field_id}")
        assert by_field.status_code == 200
        assert [item["id"] for item in by_field.json()["items"]] == [edge["id"]]
        # The target record's "Linked from" read finds the link from the other department.
        linked_from = client.get(f"/api/relationships?incident_record_id={graph.cross_target_id}")
        assert linked_from.status_code == 200
        assert [
            (item["id"], item["source_record_id"], item["visibility"])
            for item in linked_from.json()["items"]
        ] == [(edge["id"], str(graph.source_id), "available")]

        replaced = client.put(
            f"/api/relationships/fields/{graph.cross_field_id}/sources/{graph.source_id}",
            json={"target_record_id": str(graph.cross_replacement_id)},
        )
        assert replaced.status_code == 200
        replacement = replaced.json()
        assert replacement["id"] != edge["id"]
        assert replacement["field_id"] == str(graph.cross_field_id)
        assert replacement["source_record_id"] == str(graph.source_id)
        assert replacement["target_record_id"] == str(graph.cross_replacement_id)
        assert relationship_http_fixture.active_edge_ids() == {UUID(replacement["id"])}

        deleted = client.delete(f"/api/relationships/{replacement['id']}")
        assert deleted.status_code == 204

    assert relationship_http_fixture.active_edge_ids() == set()


def test_writer_without_access_to_the_other_department_cannot_see_or_change_its_links(
    relationship_http_fixture,
) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    writer = relationship_http_fixture.writer
    assert writer is not None
    with relationship_http_fixture.client(relationship_http_fixture.actor) as client:
        created = client.post(
            "/api/relationships",
            json=_payload(graph.cross_field_id, graph.source_id, graph.cross_target_id),
        )
        assert created.status_code == 201
    cross_edge_id = created.json()["id"]

    with relationship_http_fixture.client(writer) as client:
        # Control: the writer can change links inside its own department.
        own = client.post(
            "/api/relationships",
            json=_payload(graph.field_id, graph.source_id, graph.target_id),
        )
        assert own.status_code == 201
        for query in (
            f"field_id={graph.cross_field_id}",
            f"incident_record_id={graph.cross_target_id}",
        ):
            listed = client.get(f"/api/relationships?{query}")
            assert listed.status_code == 200
            assert listed.json()["items"] == []
            assert listed.json()["pagination"]["total"] == 0
        # The source record's own list shows only the readable link.
        incident = client.get(f"/api/relationships?incident_record_id={graph.source_id}")
        assert [item["id"] for item in incident.json()["items"]] == [own.json()["id"]]
        assert incident.json()["pagination"]["total"] == 1

        assert client.get(f"/api/relationships/{cross_edge_id}").status_code == 404
        linked = client.post(
            "/api/relationships",
            json=_payload(graph.cross_field_id, graph.source_id, graph.cross_replacement_id),
        )
        assert linked.status_code == 404
        assign_url = f"/api/relationships/fields/{graph.cross_field_id}/sources/{graph.source_id}"
        assert (
            client.put(
                assign_url, json={"target_record_id": str(graph.cross_replacement_id)}
            ).status_code
            == 404
        )
        # Clearing needs read on the field's target module, so it is refused too.
        assert client.put(assign_url, json={"target_record_id": None}).status_code == 404
        assert client.delete(f"/api/relationships/{cross_edge_id}").status_code == 404

    assert relationship_http_fixture.active_edge_ids() == {
        UUID(cross_edge_id),
        UUID(own.json()["id"]),
    }


def test_cardinality_conflict_with_a_hidden_cross_department_link_reveals_no_record(
    relationship_http_fixture,
) -> None:
    graph = relationship_http_fixture.graph
    assert graph is not None
    with relationship_http_fixture.client() as client:
        created = client.post(
            "/api/relationships",
            json=_payload(graph.cross_field_id, graph.source_id, graph.cross_target_id),
        )
        assert created.status_code == 201
    hidden_edge_id = created.json()["id"]
    relationship_http_fixture.archive_target(graph.cross_target_id)
    try:
        with relationship_http_fixture.client() as client:
            available = client.get(f"/api/relationships?field_id={graph.cross_field_id}")
            assert available.json()["items"] == []

            conflict = client.post(
                "/api/relationships",
                json=_payload(graph.cross_field_id, graph.source_id, graph.cross_replacement_id),
            )
    finally:
        relationship_http_fixture.restore_target(graph.cross_target_id)

    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "Source already has a relationship target"}
    assert str(graph.cross_target_id) not in conflict.text
    assert hidden_edge_id not in conflict.text
    assert relationship_http_fixture.active_edge_ids() == {UUID(hidden_edge_id)}
