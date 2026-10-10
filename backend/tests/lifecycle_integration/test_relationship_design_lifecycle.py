"""A relationship field closed through lifecycle stays closed across publications."""

import pytest
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.service import read_document
from app.systems.sandbox.lifecycle.service import close_lifecycle, reopen_lifecycle
from app.systems.sandbox.publications.planner import publication_plan
from tests.sandbox_publications.support import (
    bound_field,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration


def test_lifecycle_closed_relationship_is_not_reopened_by_the_next_publication(
    integration_owner_db: Session,
) -> None:
    # The draft has no closed flag for a relationship, so the planner and executor
    # used to treat the closed live field as a "reopen" on any later publication.
    db = integration_owner_db
    publisher, published = publish_structure(db, publishable_document())
    relationship = published.design.relationships[0]
    link = bound_field(db, "relationship", relationship.id)

    close_lifecycle(db, "field", link.id, publisher.id)
    db.refresh(link)
    marker = link.lifecycle_close_operation_id
    assert link.is_deleted and marker is not None

    draft = read_document(db).document
    plan = publication_plan(db, draft)
    assert not [
        change
        for change in plan.changes
        if change.sandbox_id == relationship.id and change.action == "reopen"
    ]
    publish_revision(db, publisher, draft, "after-relationship-lifecycle-close")
    db.refresh(link)
    assert link.is_deleted and link.lifecycle_close_operation_id == marker

    reopen_lifecycle(db, "field", link.id, publisher.id)
    db.refresh(link)
    assert not link.is_deleted
    publish_revision(db, publisher, read_document(db).document, "after-relationship-reopen")
    db.refresh(link)
    assert not link.is_deleted


def test_relationship_field_routes_close_reopen_and_purge_links_keep_records(
    integration_owner_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.main import create_app
    from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient
    from app.systems.sandbox.records.models import Record
    from app.systems.sandbox.relationships.models import RelationshipEdge
    from tests.rbac.support import _client

    db = integration_owner_db
    publisher, published = publish_structure(db, publishable_document())
    relationship = published.design.relationships[0]
    link = bound_field(db, "relationship", relationship.id)
    request_number = bound_field(
        db, "field", "sample-requests:sample-field-requests-request-number"
    )
    asset_tag = bound_field(db, "field", "sample-equipment:sample-field-equipment-asset-tag")
    source = Record(module_id=link.module_id, data={str(request_number.id): "Owned request 1"})
    target = Record(
        module_id=link.relationship_target_module_id, data={str(asset_tag.id): "Owned asset 1"}
    )
    db.add_all([source, target])
    db.flush()
    edge = RelationshipEdge(
        field_id=link.id, source_record_id=source.id, target_record_id=target.id
    )
    db.add(edge)
    db.commit()
    monkeypatch.setattr(ProviderPasswordGrantClient, "verify_password", lambda *_args: publisher.id)
    client = _client(create_app(), publisher, db)
    path = f"/api/fields/{link.id}"

    def close():
        response = client.post(path + "/close/preview")
        assert response.status_code == 200, response.text
        preview = response.json()
        assert preview["impact"]["target_type"] == "field"
        assert preview["impact"]["target_id"] == str(link.id)
        assert {row["edge_id"] for row in preview["impact"]["external_impacts"]} == {str(edge.id)}
        result = client.post(
            path + "/close",
            json={
                "token": preview["token"],
                "confirmation_name": preview["confirmation_name"],
                "password": "fixture-only",
            },
        )
        assert result.status_code == 200, result.text
        assert result.json()["impact"]["operation"] == "close"

    close()
    db.refresh(link)
    db.refresh(edge)
    assert link.is_deleted
    hidden = client.get(f"/api/relationships/{edge.id}")
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["visibility"] == "hidden"
    assert hidden.json()["hidden_reasons"] == ["field_archived"]
    available = client.get(
        "/api/relationships", params={"field_id": str(link.id), "availability": "available"}
    )
    assert available.status_code == 200, available.text
    assert available.json()["items"] == [] and available.json()["pagination"]["total"] == 0
    assert not source.is_deleted and not target.is_deleted
    result = client.post(path + "/reopen", json={"confirmed": True})
    assert result.status_code == 200, result.text
    assert result.json()["impact"]["target_type"] == "field"
    assert result.json()["impact"]["operation"] == "reopen"
    db.refresh(link)
    db.refresh(edge)
    assert not link.is_deleted
    available = client.get(
        "/api/relationships", params={"field_id": str(link.id), "availability": "available"}
    )
    assert available.status_code == 200, available.text
    assert [row["id"] for row in available.json()["items"]] == [str(edge.id)]
    assert available.json()["items"][0]["visibility"] == "available"
    close()
    preview = client.post(path + "/purge/preview")
    assert preview.status_code == 200, preview.text
    review = preview.json()
    purged = client.post(
        path + "/purge",
        json={
            "token": review["token"],
            "confirmation_name": review["confirmation_name"],
            "password": "fixture-only",
        },
    )
    assert purged.status_code == 200, purged.text
    assert purged.json()["impact"]["target_type"] == "field"
    assert purged.json()["impact"]["operation"] == "purge"
    assert db.get(type(link), link.id) is None
    assert db.get(RelationshipEdge, edge.id) is None
    assert client.get(f"/api/relationships/{edge.id}").status_code == 404
    assert db.get(Record, source.id) is not None and db.get(Record, target.id) is not None
    assert not any(
        row.id == relationship.id for row in read_document(db).document.design.relationships
    )
