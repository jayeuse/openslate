"""Library list contracts use authorized PostgreSQL queries and HTTP serialization."""

from datetime import UTC, datetime, timedelta

import pytest

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.membership import sole_active_membership
from tests.files.test_library_routes import library_file
from tests.files.test_workspace_policy_integration import _client, _Store
from tests.rbac.support import add_department, add_user, make_group_access

pytestmark = pytest.mark.integration


def test_library_list_preserves_its_envelope_scopes_creators_and_counts_confirmed_storage(
    guarded_db,
):
    db = guarded_db
    reader = add_user(db)
    creator = add_user(db)
    creator.display_name = "Guide author"
    inactive = add_user(db, status="disabled")
    other_creator = add_user(db)
    department = add_department(db)
    other_department = add_department(db)
    make_group_access(db, [reader], department, level=AccessLevel.READ)
    first = library_file(db, creator, department, size=7, name="Guide alpha.pdf")
    library_file(db, inactive, department, size=13, archived=True, name="Retained.pdf")
    library_file(db, creator, department, state="uploading", size=50, name="Guide pending.pdf")
    library_file(db, creator, department, state="awaiting_upload", size=20, name="Reserved.pdf")
    library_file(db, other_creator, other_department, size=101, name="Other.pdf")
    with _client(db, reader, _Store(db)) as client:
        response = client.get(
            "/api/files",
            params={
                "purpose": "library_document",
                "department_id": str(department.id),
                "search": "Guide alpha",
                "limit": 1,
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body) == {"items", "pagination", "creator_labels", "storage_used_bytes"}
        assert [item["id"] for item in body["items"]] == [str(first.id)]
        assert body["creator_labels"] == {str(creator.id): "Guide author"}
        assert body["storage_used_bytes"] == 20
        for filters in (
            {"deleted": "only"},
            {"deleted": "include", "offset": 100},
            {"search": "no match"},
        ):
            page = client.get(
                "/api/files",
                params={
                    "purpose": "library_document",
                    "department_id": str(department.id),
                    **filters,
                },
            )
            assert page.status_code == 200, page.text
            assert page.json()["storage_used_bytes"] == 20
            assert str(inactive.id) not in page.json()["creator_labels"]
            assert str(other_creator.id) not in page.json()["creator_labels"]


@pytest.mark.parametrize("ineligible", ["pending", "expired", "deleted", "unaccepted"])
def test_library_creator_labels_omit_ineligible_accounts(guarded_db, actor, ineligible):
    db = guarded_db
    creator = add_user(db)
    membership = sole_active_membership(db, creator.id)
    department = add_department(db)
    library_file(db, creator, department)
    if ineligible == "pending":
        creator.status = "pending"
    elif ineligible == "expired":
        membership.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    elif ineligible == "deleted":
        creator.is_deleted = True
    else:
        membership.invitation_sent_at = datetime.now(UTC)
        membership.invitation_accepted_at = None
    db.commit()
    with _client(db, actor, _Store(db)) as client:
        response = client.get(
            "/api/files",
            params={"purpose": "library_document", "department_id": str(department.id)},
        )
    assert response.status_code == 200, response.text
    assert response.json()["creator_labels"] == {}


def test_library_search_escapes_wildcards_and_sorts_paged_name_and_effective_size(
    guarded_db, actor
):
    db = guarded_db
    department = add_department(db)
    alpha = library_file(db, actor, department, name="Alpha.pdf", size=9)
    first = library_file(db, actor, department, name="Duplicate.pdf", size=7)
    second = library_file(db, actor, department, name="Duplicate.pdf", size=7)
    pending = library_file(db, actor, department, state="awaiting_upload", name="Zulu.pdf", size=20)
    literal = library_file(db, actor, department, name="100%_guide.pdf", size=5)
    library_file(db, actor, department, name="100XXguide.pdf", size=6)
    with _client(db, actor, _Store(db)) as client:
        base = {"purpose": "library_document", "department_id": str(department.id)}
        searched = client.get("/api/files", params={**base, "search": "100%_guide"})
        assert searched.status_code == 200, searched.text
        assert [item["id"] for item in searched.json()["items"]] == [str(literal.id)]
        ascending = client.get(
            "/api/files",
            params={**base, "search": ".pdf", "sort_by": "name", "limit": 2, "offset": 3},
        )
        assert ascending.status_code == 200, ascending.text
        assert [item["id"] for item in ascending.json()["items"]] == [str(first.id), str(second.id)]
        assert ascending.json()["pagination"] == {
            "limit": 2,
            "offset": 3,
            "count": 2,
            "total": 6,
            "has_more": True,
        }
        descending = client.get(
            "/api/files", params={**base, "sort_by": "size", "sort_order": "desc", "limit": 4}
        )
        assert descending.status_code == 200, descending.text
        assert [item["id"] for item in descending.json()["items"]] == [
            str(pending.id),
            str(alpha.id),
            str(second.id),
            str(first.id),
        ]
        for sort in ("digest", "object_key", "unknown"):
            assert client.get("/api/files", params={**base, "sort_by": sort}).status_code == 422
        empty_department = add_department(db)
        db.commit()
        empty = client.get(
            "/api/files",
            params={"purpose": "library_document", "department_id": str(empty_department.id)},
        )
        assert empty.status_code == 200 and empty.json()["storage_used_bytes"] == 0
        assert empty.json()["creator_labels"] == {}
