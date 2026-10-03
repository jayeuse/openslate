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
