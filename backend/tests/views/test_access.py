from unittest.mock import patch

import pytest
from fastapi import HTTPException, Response
from pydantic import ValidationError
from record_queries.test_database import setup_rows
from sqlalchemy import func, select
from uuid6 import uuid7

from app.systems.access.users.models import Role, User
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.router import (
    ViewList,
    archive_view,
    create_view,
    get_view,
    list_views,
    update_view,
)
from app.systems.openview.views.schemas import ViewAudience, ViewCreate, ViewUpdate
from app.systems.sandbox.records.query_schemas import QueryDefinition

pytestmark = pytest.mark.integration


def actor(db, role: Role | None = None):
    actor_id = uuid7()
    if role is None:
        role = db.scalar(select(Role).where(Role.role == "member"))
        assert role is not None
    user = User(
        id=actor_id,
        email=f"p7-{actor_id}@example.com",
        username=f"p7_{actor_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    db.add(user)
    db.flush()
    return user


def accepted_rows(db, kind: str, values: list[object]):
    module, field, rows = setup_rows(db, kind, values)
    module.is_schema_accepted = True
    db.flush()
    return module, field, rows


def test_private_view_is_owner_only_even_for_admin(query_db):
    owner = actor(query_db)
    module, _, _ = accepted_rows(query_db, "text", [])
    view = create_view(
        ViewCreate(module_id=module.id, name="Private", definition=QueryDefinition()),
        owner,
        query_db,
        Response(),
    )
    other = User(id=uuid7(), status="active", role=Role(role="admin"))
    with pytest.raises(HTTPException) as error:
        get_view(query_db, other, view.id)
    assert error.value.status_code == 404
    result = list_views(other, query_db, ViewList(module_id=module.id))
    assert result.items == []
    assert get_view(query_db, owner, view.id).owner_id == owner.id


def test_role_audience_is_visible_but_not_mutable_to_another_member(query_db):
    role = Role(
        role="viewers",
        permissions={"records.read": True, "records.write": True},
    )
    query_db.add(role)
    query_db.flush()
    owner = actor(query_db, role)
    viewer = actor(query_db, role)
    module, _, _ = accepted_rows(query_db, "text", [])
    view = create_view(
        ViewCreate(
            module_id=module.id,
            name="Shared with viewers",
            audience=ViewAudience(kind="role", role_id=role.id),
            definition=QueryDefinition(),
        ),
        owner,
        query_db,
        Response(),
    )

    assert get_view(query_db, viewer, view.id).id == view.id
    with pytest.raises(HTTPException) as error:
        update_view(view.id, ViewUpdate(revision=1, name="Changed"), viewer, query_db)
    assert error.value.status_code == 403


def test_private_updates_revision_and_archives_without_exposing_predicates(query_db):
    owner = actor(query_db)
    module, field, _ = accepted_rows(query_db, "text", [])
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
    archive_view(view.id, 2, owner, query_db)
    assert query_db.get(SavedView, view.id).is_deleted
    assert list_views(owner, query_db, ViewList(module_id=module.id)).items == []


def test_same_normalized_view_patch_does_not_commit_or_bump_revision(query_db):
    owner = actor(query_db)
    module, _, _ = accepted_rows(query_db, "text", [])
    view = create_view(
        ViewCreate(module_id=module.id, name="Original", definition=QueryDefinition()),
        owner,
        query_db,
        Response(),
    )
    before_events = query_db.scalar(
        select(func.count()).select_from(AuditLog).where(AuditLog.entity_id == view.id)
    )

    import app.systems.openview.views.router as views_router

    with patch.object(views_router, "commit", wraps=views_router.commit) as commit_view:
        unchanged = update_view(
            view.id,
            ViewUpdate(revision=1, name=" Original ", definition=QueryDefinition()),
            owner,
            query_db,
        )

    assert unchanged.name == "Original"
    assert unchanged.revision == 1
    commit_view.assert_not_called()
    after_events = query_db.scalar(
        select(func.count()).select_from(AuditLog).where(AuditLog.entity_id == view.id)
    )
    assert after_events == before_events


def test_view_mutation_rejects_client_owner_visibility_and_empty_patch():
    with pytest.raises(ValidationError):
        ViewCreate(
            module_id=uuid7(), name="Private", definition=QueryDefinition(), owner_id=uuid7()
        )
    assert ViewUpdate(revision=1, visibility="workspace").visibility == "workspace"
    with pytest.raises(ValidationError):
        ViewUpdate(revision=1)
