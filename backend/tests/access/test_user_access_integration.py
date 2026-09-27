"""An administrator reads a person's effective access and the groups that grant it."""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.router import router as users_router
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration

READ, WRITE, MANAGE = AccessLevel.READ, AccessLevel.WRITE, AccessLevel.MANAGE


class _Api:
    def __init__(self, db: Session, client: TestClient, actor: list[User]) -> None:
        self.db = db
        self._client = client
        self._actor = actor

    def get(self, caller: User, user_id: Any) -> Any:
        self._actor[:] = [caller]
        return self._client.get(f"/api/users/{user_id}/access")


@pytest.fixture
def api(integration_owner_db: Session) -> Iterator[_Api]:
    actor: list[User] = []
    app = FastAPI()
    app.include_router(users_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: integration_owner_db
    app.dependency_overrides[get_current_user] = lambda: actor[0]
    with TestClient(app) as client:
        yield _Api(integration_owner_db, client, actor)


@pytest.fixture
def admin(api: _Api) -> User:
    return add_user(api.db, role=UserRole.ADMIN)


def _group(row: GroupAccess, db: Session) -> Group:
    group = db.get(Group, row.group_id)
    assert group is not None
    return group


def _source(row: GroupAccess, db: Session, level: AccessLevel) -> dict[str, str]:
    return {"group_id": str(row.group_id), "name": _group(row, db).name, "level": level.value}


def test_administrator_has_unrestricted_access_and_no_entries(api: _Api, admin: User) -> None:
    other_admin = add_user(api.db, role=UserRole.ADMIN)

    response = api.get(admin, other_admin.id)

    assert response.status_code == 200
    assert response.json() == {
        "user_id": str(other_admin.id),
        "role": "admin",
        "unrestricted": True,
        "entries": [],
    }


def test_module_override_appears_beside_the_department_entry(api: _Api, admin: User) -> None:
    member = add_user(api.db)
    inventory = add_department(api.db)
    add_module(api.db, inventory)
    prices = add_module(api.db, inventory)
    readers = make_group_access(api.db, [member], inventory, level=READ)
    pricing = make_group_access(api.db, [member], inventory, prices, level=WRITE)

    body = api.get(admin, member.id).json()

    assert body["role"] == "member" and body["unrestricted"] is False
    assert body["entries"] == [
        {
            "department_id": str(inventory.id),
            "module_id": None,
            "level": "read",
            "groups": [_source(readers, api.db, READ)],
        },
        {
            "department_id": str(inventory.id),
            "module_id": str(prices.id),
            "level": "write",
            "groups": [_source(pricing, api.db, WRITE)],
        },
    ]


def test_highest_level_lists_every_group_that_grants_it(api: _Api, admin: User) -> None:
    member = add_user(api.db)
    inventory = add_department(api.db)
    add_module(api.db, inventory)
    first = make_group_access(api.db, [member], inventory, level=MANAGE)
    make_group_access(api.db, [member], inventory, level=READ)
    second = make_group_access(api.db, [member], inventory, level=MANAGE)

    entries = api.get(admin, member.id).json()["entries"]

    assert len(entries) == 1
    assert entries[0]["level"] == "manage" and entries[0]["module_id"] is None
    expected = [_source(first, api.db, MANAGE), _source(second, api.db, MANAGE)]
    assert sorted(entries[0]["groups"], key=lambda item: item["group_id"]) == sorted(
        expected, key=lambda item: item["group_id"]
    )


def test_guest_entry_is_capped_but_groups_show_their_own_level(api: _Api, admin: User) -> None:
    guest = add_user(api.db, role=UserRole.GUEST)
    inventory = add_department(api.db)
    prices = add_module(api.db, inventory)
    finance = add_department(api.db)
    ledger = add_module(api.db, finance)
    writers = make_group_access(api.db, [guest], inventory, level=WRITE)
    make_group_access(api.db, [guest], inventory, prices, level=MANAGE)
    ledger_row = make_group_access(api.db, [guest], finance, ledger, level=MANAGE)

    body = api.get(admin, guest.id).json()

    assert body["role"] == "guest" and body["unrestricted"] is False
    by_target = {(entry["department_id"], entry["module_id"]): entry for entry in body["entries"]}
    assert set(by_target) == {(str(inventory.id), None), (str(finance.id), str(ledger.id))}
    assert {entry["level"] for entry in body["entries"]} == {"read"}
    assert by_target[(str(inventory.id), None)]["groups"] == [_source(writers, api.db, WRITE)]
    assert by_target[(str(finance.id), str(ledger.id))]["groups"] == [
        _source(ledger_row, api.db, MANAGE)
    ]


def test_disabled_user_has_no_entries(api: _Api, admin: User) -> None:
    member = add_user(api.db, status=UserStatus.DISABLED)
    inventory = add_department(api.db)
    make_group_access(api.db, [member], inventory, level=MANAGE)

    response = api.get(admin, member.id)

    assert response.status_code == 200
    assert response.json()["unrestricted"] is False
    assert response.json()["entries"] == []


def test_non_administrator_is_forbidden(api: _Api) -> None:
    manager = add_user(api.db)
    inventory = add_department(api.db)
    make_group_access(api.db, [manager], inventory, level=MANAGE)
    member = add_user(api.db)
    make_group_access(api.db, [member], inventory, level=READ)

    assert api.get(manager, member.id).status_code == 403


def test_unknown_or_deleted_user_is_not_found(api: _Api, admin: User) -> None:
    deleted = add_user(api.db)
    deleted.is_deleted = True
    deleted.deleted_at = utc_now()
    api.db.flush()

    for user_id in (uuid7(), deleted.id):
        response = api.get(admin, user_id)
        assert response.status_code == 404
        assert response.json() == {"detail": "User not found"}
