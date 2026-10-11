"""Saved-view selection remains complete after switching to bounded list pages."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.router import router
from tests.record_queries.support import route_actor, setup_rows

pytestmark = pytest.mark.integration


@pytest.fixture
def view_list(query_db):
    module, _, _ = setup_rows(query_db, "text", [])
    actor = route_actor(query_db)
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: query_db
    app.dependency_overrides[get_current_user] = lambda: actor
    with TestClient(app) as client:
        yield SimpleNamespace(db=query_db, module=module, client=client)
    app.dependency_overrides.clear()


def make_view(world, name, **values):
    view = SavedView(module_id=world.module.id, name=name, definition={}, **values)
    world.db.add(view)
    world.db.flush()
    return view


def read_page(world, **params):
    response = world.client.get("/api/views", params={"module_id": str(world.module.id), **params})
    assert response.status_code == 200, response.text
    return response.json()


def test_implicit_order_discovers_off_page_default_before_pagination(view_list):
    world = view_list
    ordinary = [make_view(world, f"A view {index:03}") for index in range(102)]
    default = make_view(world, "Z default", is_default=True)
    world.db.commit()

    first = read_page(world, limit=100)
    assert first["items"][0]["id"] == str(default.id)
    assert [row["id"] for row in first["items"][1:]] == [str(view.id) for view in ordinary[:99]]
    assert first["pagination"] == {
        "limit": 100,
        "offset": 0,
        "count": 100,
        "total": 103,
        "has_more": True,
    }
    second = read_page(world, limit=100, offset=100)
    assert [row["id"] for row in second["items"]] == [str(view.id) for view in ordinary[99:]]
    assert second["pagination"] == {
        "limit": 100,
        "offset": 100,
        "count": 3,
        "total": 103,
        "has_more": False,
    }


@pytest.mark.parametrize(
    ("sorting", "expected"),
    [
        ({"sort_by": "name"}, ["A", "M", "Z"]),
        ({"sort_by": "name", "sort_order": "desc"}, ["Z", "M", "A"]),
        ({"sort_order": "asc"}, ["A", "M", "Z"]),
        ({"sort_order": "desc"}, ["Z", "M", "A"]),
        ({"sort_by": "created_at"}, ["A", "Z", "M"]),
        ({"sort_by": "created_at", "sort_order": "desc"}, ["M", "Z", "A"]),
        ({"sort_by": "updated_at"}, ["Z", "A", "M"]),
        ({"sort_by": "updated_at", "sort_order": "desc"}, ["M", "A", "Z"]),
    ],
)
def test_explicit_sort_parameter_keeps_requested_order(view_list, sorting, expected):
    world = view_list
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for name, created_day, updated_day in (("A", 0, 5), ("M", 2, 6), ("Z", 1, 4)):
        make_view(
            world,
            name,
            is_default=name == "M",
            created_at=start + timedelta(days=created_day),
            updated_at=start + timedelta(days=updated_day),
        )
    world.db.commit()

    pages = [read_page(world, limit=1, offset=offset, **sorting) for offset in range(3)]
    assert [page["items"][0]["name"] for page in pages] == expected
    assert all(page["pagination"]["total"] == 3 for page in pages)


def test_implicit_order_keeps_name_ties_and_filters_before_pages(view_list):
    world = view_list
    repeated = [make_view(world, "Match same") for _ in range(2)]
    default = make_view(world, "Match Z default", is_default=True)
    archived = make_view(world, "Match archived default", is_default=True, is_deleted=True)
    make_view(world, "Other view")
    other_module, _, _ = setup_rows(world.db, "text", [])
    world.db.add(SavedView(module_id=other_module.id, name="Match hidden module", definition={}))
    world.db.commit()

    pages = [read_page(world, search="Match", limit=1, offset=offset) for offset in range(3)]
    assert [page["items"][0]["id"] for page in pages] == [
        str(default.id),
        *[str(view.id) for view in sorted(repeated, key=lambda view: view.id)],
    ]
    assert all(page["pagination"]["total"] == 3 for page in pages)
    deleted = read_page(world, search="Match", deleted="only", limit=1)
    assert [row["id"] for row in deleted["items"]] == [str(archived.id)]
    assert deleted["pagination"]["total"] == 1


def test_implicit_order_without_default_keeps_name_order(view_list):
    world = view_list
    for name in ("Z", "A", "M"):
        make_view(world, name)
    world.db.commit()

    assert [row["name"] for row in read_page(world)["items"]] == ["A", "M", "Z"]
