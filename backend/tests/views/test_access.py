from unittest.mock import patch

import pytest
from fastapi import HTTPException, Request, Response
from sqlalchemy import func, select

from app.systems.access.policy.models import AccessLevel
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
from app.systems.openview.views.schemas import ViewCreate, ViewUpdate
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.records.query_schemas import QueryDefinition
from tests.rbac.support import add_user, make_group_access
from tests.record_queries.support import setup_rows

pytestmark = pytest.mark.integration


def actor(db, role: str = "member"):
    return add_user(db, "p7", role=role)


def grant(db, module, *users, level: str = AccessLevel.MANAGE) -> None:
    """Give the users ``level`` on the module through one new group."""

    make_group_access(db, users, db.get(Department, module.department_id), module, level=level)


def test_view_is_shared_with_every_module_reader_and_hidden_from_others(query_db):
    manager = actor(query_db)
    viewer = actor(query_db)
    writer = actor(query_db)
    no_group = actor(query_db)
    module, _, _ = setup_rows(query_db, "text", [])
    grant(query_db, module, manager)
    grant(query_db, module, viewer, level=AccessLevel.READ)
    grant(query_db, module, writer, level=AccessLevel.WRITE)
    view = create_view(
        ViewCreate(module_id=module.id, name="Shared", definition=QueryDefinition()),
        manager,
        query_db,
        Response(),
    )
    admin = actor(query_db, role="admin")

    assert get_view(query_db, viewer, view.id).id == view.id
    assert [
        item.id
        for item in list_views(
            admin,
            query_db,
            ViewList(module_id=module.id),
            Request({"type": "http", "query_string": b""}),
        ).items
    ] == [view.id]
    for reader in (viewer, writer):
        with pytest.raises(HTTPException) as error:
            update_view(view.id, ViewUpdate(revision=1, name="Changed"), reader, query_db)
        assert error.value.status_code == 403
    # A user in no group cannot read the module, so the shared view is hidden.
    with pytest.raises(HTTPException) as hidden:
        get_view(query_db, no_group, view.id)
    assert hidden.value.status_code == 404
    assert (
        list_views(
            no_group,
            query_db,
            ViewList(module_id=module.id),
            Request({"type": "http", "query_string": b""}),
        ).items
        == []
    )


def test_guest_with_module_read_cannot_create_a_view(query_db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.common.dependencies import get_current_user
    from app.core.database import get_db
    from app.systems.openview.views.router import router

    guest = actor(query_db, role="guest")
    module, _, _ = setup_rows(query_db, "text", [])
    grant(query_db, module, guest, level=AccessLevel.WRITE)
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: query_db
    app.dependency_overrides[get_current_user] = lambda: guest

    response = TestClient(app).post(
        "/api/views",
        json={"module_id": str(module.id), "name": "Guest view", "definition": {}},
    )

    assert response.status_code == 403
    assert (
        query_db.scalar(
            select(func.count()).select_from(SavedView).where(SavedView.module_id == module.id)
        )
        == 0
    )


def test_manager_updates_revision_and_archives_without_exposing_predicates(query_db):
    owner = actor(query_db)
    module, field, _ = setup_rows(query_db, "text", [])
    grant(query_db, module, owner)
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
    assert (
        list_views(
            owner,
            query_db,
            ViewList(module_id=module.id),
            Request({"type": "http", "query_string": b""}),
        ).items
        == []
    )


def test_same_normalized_view_patch_does_not_commit_or_bump_revision(query_db):
    owner = actor(query_db)
    module, _, _ = setup_rows(query_db, "text", [])
    grant(query_db, module, owner)
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
