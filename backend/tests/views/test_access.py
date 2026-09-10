import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError
from record_queries.test_database import setup_rows
from sqlalchemy import select, text
from uuid6 import uuid7

from app.systems.records.query_schemas import QueryDefinition
from app.systems.users.models import Role, User
from app.systems.views.models import SavedView
from app.systems.views.router import (
    ViewList,
    archive_view,
    create_view,
    get_view,
    list_views,
    update_view,
)
from app.systems.views.schemas import ViewCreate, ViewUpdate

pytestmark = pytest.mark.integration


def actor(db):
    actor_id = uuid7()
    db.connection().execute(
        text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
        {"id": actor_id, "email": f"p7-{actor_id}@example.com"},
    )
    user = db.scalar(select(User).where(User.id == actor_id))
    assert user is not None
    return user


def test_private_view_is_owner_only_even_for_admin(query_db):
    owner = actor(query_db)
    module, _, _ = setup_rows(query_db, "text", [])
    view = create_view(
        ViewCreate(module_id=module.id, name="Private", definition=QueryDefinition()),
        owner,
        query_db,
        Response(),
    )
    other = User(id=uuid7(), role=Role(role="admin"))
    with pytest.raises(HTTPException) as error:
        get_view(query_db, other, view.id)
    assert error.value.status_code == 404
    result = list_views(other, query_db, ViewList(module_id=module.id))
    assert result["items"] == []
    assert get_view(query_db, owner, view.id).owner_id == owner.id


def test_shared_creation_requires_literal_admin(query_db):
    module, _, _ = setup_rows(query_db, "text", [])
    other = User(id=uuid7(), role=Role(role="custom", permissions={"records.read": True}))
    with pytest.raises(HTTPException) as error:
        create_view(
            ViewCreate(
                module_id=module.id,
                name="Shared",
                visibility="workspace",
                definition=QueryDefinition(),
            ),
            other,
            query_db,
            Response(),
        )
    assert error.value.status_code == 403


def test_private_updates_revision_and_archives_without_exposing_predicates(query_db):
    owner = actor(query_db)
    module, field, _ = setup_rows(query_db, "text", [])
    definition = QueryDefinition(
        filters=[
            {"field_id": field.id, "expected_type": "text", "operator": "eq", "value": "sensitive"}
        ]
    )
    view = create_view(
        ViewCreate(module_id=module.id, name="Original", definition=definition),
        owner,
        query_db,
        Response(),
    )
    updated = update_view(view.id, ViewUpdate(revision=1, name="Renamed"), owner, query_db)
    assert updated.revision == 2 and updated.name == "Renamed"
    with pytest.raises(HTTPException) as error:
        update_view(view.id, ViewUpdate(revision=1, name="Stale"), owner, query_db)
    assert error.value.status_code == 409
    archive_view(view.id, owner, query_db)
    assert query_db.get(SavedView, view.id).is_deleted
    assert list_views(owner, query_db, ViewList(module_id=module.id))["items"] == []


def test_view_mutation_rejects_client_owner_visibility_and_empty_patch():
    with pytest.raises(ValidationError):
        ViewCreate(
            module_id=uuid7(), name="Private", definition=QueryDefinition(), owner_id=uuid7()
        )
    with pytest.raises(ValidationError):
        ViewUpdate(revision=1, visibility="workspace")
    with pytest.raises(ValidationError):
        ViewUpdate(revision=1)
