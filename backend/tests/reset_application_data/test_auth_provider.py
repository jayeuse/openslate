"""Pinned Auth admin deletion behavior for the guarded reset."""

from uuid import UUID, uuid4

import httpx
import pytest

from operations.reset_auth import ResetAuth
from operations.reset_models import ResetError


def test_reset_auth_deletes_only_confirmed_provider_subjects() -> None:
    admin_id, member_id = uuid4(), uuid4()
    existing = {admin_id, member_id}
    deleted: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["apikey"] == "server-secret"
        assert request.url.path.startswith("/auth/v1/admin/users/")
        user_id = request.url.path.rsplit("/", 1)[-1]
        if request.method == "GET":
            return (
                httpx.Response(200, json={"id": user_id})
                if any(str(item) == user_id for item in existing)
                else httpx.Response(404)
            )
        if request.method == "DELETE":
            deleted.append(user_id)
            existing.remove(member_id)
            return httpx.Response(200, json={})
        raise AssertionError("Unexpected Auth request")

    client = httpx.Client(transport=httpx.MockTransport(respond))
    auth = ResetAuth("http://provider.local", "server-secret", 2, client=client)
    auth.require_present(admin_id)
    auth.delete_and_verify_missing((member_id,))

    assert existing == {admin_id}
    assert deleted == [str(member_id)]
    # Retrying the exact pinned subject after partial cleanup is safe.
    auth.delete_and_verify_missing((member_id,))
    assert deleted == [str(member_id)]


def test_reset_auth_inventories_unlinked_accounts_across_pages() -> None:
    admin_id, linked_id, orphan_id = uuid4(), uuid4(), uuid4()
    pages = [
        [{"id": str(admin_id), "email": "admin@example.test"},
         {"id": str(linked_id), "email": "linked@example.test"}],
        [{"id": str(orphan_id), "email": "orphan@example.test"}],
    ]

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth/v1/admin/users"
        assert request.url.params["per_page"] == "2"
        return httpx.Response(200, json={"users": pages[int(request.url.params["page"]) - 1]})

    auth = ResetAuth("http://provider.local", "server-secret", 2,
                     client=httpx.Client(transport=httpx.MockTransport(respond)))
    assert auth.list_account_ids(admin_id, "ADMIN@example.test", page_size=2) == tuple(
        sorted((linked_id, orphan_id), key=str)
    )


def test_reset_auth_rejects_ambiguous_or_incomplete_inventory() -> None:
    admin_id, orphan_id = uuid4(), uuid4()

    def duplicate(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"users": [
            {"id": str(admin_id), "email": "admin@example.test"},
            {"id": str(orphan_id), "email": "orphan@example.test"},
            {"id": str(orphan_id), "email": "orphan@example.test"},
        ]})

    auth = ResetAuth("http://provider.local", "server-secret", 2,
                     client=httpx.Client(transport=httpx.MockTransport(duplicate)))
    with pytest.raises(ResetError, match="inventory"):
        auth.list_account_ids(admin_id, "admin@example.test")

    def wrong_admin(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"users": [
            {"id": str(admin_id), "email": "wrong@example.test"},
        ]})

    auth = ResetAuth("http://provider.local", "server-secret", 2,
                     client=httpx.Client(transport=httpx.MockTransport(wrong_admin)))
    with pytest.raises(ResetError, match="administrator"):
        auth.list_account_ids(admin_id, "admin@example.test")

    def full_pages(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        user_id = admin_id if page == 1 else UUID(int=page)
        email = "admin@example.test" if page == 1 else "other@example.test"
        return httpx.Response(200, json={"users": [{"id": str(user_id), "email": email}]})

    auth = ResetAuth("http://provider.local", "server-secret", 2,
                     client=httpx.Client(transport=httpx.MockTransport(full_pages)))
    with pytest.raises(ResetError, match="incomplete"):
        auth.list_account_ids(admin_id, "admin@example.test", page_size=1)


def test_reset_auth_rejects_wrong_admin_identity_and_unconfirmed_delete() -> None:
    admin_id, other_id = uuid4(), uuid4()
    seen: list[tuple[str, str]] = []

    def wrong_identity(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(200, json={"id": str(other_id)})

    client = httpx.Client(transport=httpx.MockTransport(wrong_identity))
    auth = ResetAuth("http://provider.local", "server-secret", 2, client=client)
    with pytest.raises(ResetError, match="provider account identity"):
        auth.require_present(admin_id)
    assert seen == [("GET", f"/auth/v1/admin/users/{admin_id}")]


@pytest.mark.parametrize("delete_status", [503, 200])
def test_reset_auth_requires_verified_absence_after_delete(delete_status: int) -> None:
    admin_id, member_id = uuid4(), uuid4()

    def respond(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(delete_status, json={})
        return httpx.Response(200, json={"id": request.url.path.rsplit("/", 1)[-1]})

    client = httpx.Client(transport=httpx.MockTransport(respond))
    auth = ResetAuth("http://provider.local", "server-secret", 2, client=client)
    auth.require_present(admin_id)
    with pytest.raises(ResetError, match="provider account"):
        auth.delete_and_verify_missing((member_id,))
    with pytest.raises(ResetError, match="preserved administrator"):
        auth.delete_and_verify_missing((admin_id,))
