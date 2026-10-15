"""Version history filters keep complete totals, descending order and admin access."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.sandbox.designs.models import SandboxDocument
from app.systems.sandbox.designs.service import _append_version, read_document
from tests.rbac.support import make_user
from tests.route_app_support import route_app

pytestmark = pytest.mark.integration


@pytest.fixture
def version_page(integration_owner_db):
    db = integration_owner_db
    document = read_document(db).document
    row = db.scalar(select(SandboxDocument))
    definitions = (
        ("checkpoint", "Needle first", None),
        ("checkpoint", "Other title", "Contains needle in its note"),
        ("published", "Needle publication", None),
        ("imported", "Imported label", "needle"),
        ("checkpoint", "Needle deleted", None),
        ("checkpoint", "literal_%", None),
        ("checkpoint", "literalXY", None),
    )
    versions = []
    for kind, label, note in definitions:
        version = _append_version(
            db,
            row=row,
            document=document,
            kind=kind,
            label=label,
            note=note,
            actor_id=None,
        )
        versions.append(version)
    versions[4].is_deleted = True
    db.commit()
    actor = [make_user("version-paging")]
    app = route_app()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor[0]
    try:
        with TestClient(app) as client:
            yield client, actor, versions
    finally:
        app.dependency_overrides.clear()


def test_versions_search_label_and_note_before_kind_filtered_paging(version_page):
    client, _actor, versions = version_page
    for offset, expected in enumerate((versions[1], versions[0])):
        response = client.get(
            "/api/sandbox/versions",
            params={"search": "  NEEDLE  ", "kind": "checkpoint", "limit": 1, "offset": offset},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert [item["id"] for item in body["items"]] == [str(expected.id)]
        assert {key: value for key, value in body.items() if key != "items"} == {
            "limit": 1,
            "offset": offset,
            "count": 1,
            "total": 2,
            "hasMore": offset == 0,
            "mutableCount": 5,
            "versionCap": 50,
        }
    for kind, expected in (("published", versions[2]), ("imported", versions[3])):
        response = client.get("/api/sandbox/versions", params={"search": "needle", "kind": kind})
        assert response.status_code == 200
        assert [item["id"] for item in response.json()["items"]] == [str(expected.id)]
        assert response.json()["total"] == 1


def test_version_search_is_literal_and_blank_search_keeps_existing_order(version_page):
    client, _actor, versions = version_page
    literal = client.get("/api/sandbox/versions", params={"search": "literal_%"})
    assert literal.status_code == 200
    assert [item["id"] for item in literal.json()["items"]] == [str(versions[5].id)]
    assert literal.json()["total"] == 1
    blank = client.get("/api/sandbox/versions", params={"search": "   ", "limit": 100})
    assert blank.status_code == 200
    expected = [versions[index] for index in (6, 5, 3, 2, 1, 0)]
    assert [item["id"] for item in blank.json()["items"]] == [str(item.id) for item in expected]
    assert blank.json()["total"] == 6


@pytest.mark.parametrize("params", [{"kind": "unknown"}, {"search": "x" * 101}])
def test_version_filter_validation_is_bounded(version_page, params):
    client, _actor, _versions = version_page
    response = client.get("/api/sandbox/versions", params=params)
    assert response.status_code == 422, response.text


def test_version_filters_do_not_change_administrator_only_access(version_page):
    client, actor, _versions = version_page
    for role in ("member", "guest"):
        actor[0] = make_user(f"version-{role}", role=role)
        response = client.get("/api/sandbox/versions", params={"kind": "checkpoint"})
        assert response.status_code == 403
