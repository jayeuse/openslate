"""Board grant principal labels resolve only currently available identities."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.boards.grant_router import router
from app.systems.boards.models import Board, BoardGrant
from app.systems.manage.audit.context import set_audit_actor

pytestmark = pytest.mark.integration


def _user(
    db: Session,
    *,
    role: Role | None = None,
    permissions: dict[str, bool] | None = None,
    status: UserStatus = UserStatus.ACTIVE,
    deleted: bool = False,
    invitation_sent_at: datetime | None = None,
) -> User:
    if role is None:
        role = Role(role=f"grant-label-role-{uuid7().hex}", permissions=permissions or {})
        db.add(role)
        db.flush()
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"grant-label-{user_id.hex}@example.test",
        username=f"grant_label_{user_id.hex[:20]}",
        role_id=role.id,
        role=role,
        status=status.value,
        is_deleted=deleted,
        invitation_sent_at=invitation_sent_at,
    )
    db.add(user)
    db.flush()
    return user


def _manager_board(db: Session) -> tuple[User, Board]:
    manager = _user(db, permissions={"records.read": True, "records.write": True})
    owner = _user(db, role=manager.role)
    board = Board(owner_id=owner.id, name="Grant principal labels")
    db.add(board)
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=manager.id,
            permission="manage",
            effect="allow",
        )
    )
    db.flush()
    set_audit_actor(db, manager.id)
    return manager, board


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _create(
    client: TestClient,
    board: Board,
    *,
    revision: int,
    principal_type: str,
    target_id: UUID | None = None,
) -> dict[str, object]:
    body: dict[str, object] = {
        "revision": revision,
        "principal_type": principal_type,
        "permission": "view",
        "effect": "allow",
    }
    if principal_type == "user":
        body["principal_user_id"] = str(target_id)
    if principal_type == "role":
        body["principal_role_id"] = str(target_id)
    response = client.post(f"/api/boards/{board.id}/grants", json=body)
    assert response.status_code == 201
    return response.json()["grant"]


def test_create_and_list_use_same_minimal_labels_for_active_principals(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _manager_board(db)
    person = _user(db)
    role = Role(role=f"grant-label-target-{uuid7().hex}", permissions={"records.read": True})
    db.add(role)
    db.flush()
    client = _client(db, manager)

    created = [
        _create(client, board, revision=1, principal_type="user", target_id=person.id),
        _create(client, board, revision=2, principal_type="role", target_id=role.id),
        _create(client, board, revision=3, principal_type="everyone"),
    ]
    listed = client.get(f"/api/boards/{board.id}/grants?limit=10")

    assert listed.status_code == 200
    by_id = {grant["id"]: grant for grant in listed.json()["items"]}
    expected = [(person.username, True), (role.role, True), ("Everyone", True)]
    for grant, (label, available) in zip(created, expected, strict=True):
        assert by_id[grant["id"]] == grant
        assert grant["principal_label"] == label
        assert grant["principal_available"] is available
        assert "email" not in grant and "permissions" not in grant


def test_unavailable_user_and_role_grants_have_generic_labels_without_identity_leak(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _manager_board(db)
    disabled = _user(db, status=UserStatus.DISABLED)
    unaccepted = _user(db, invitation_sent_at=datetime.now(UTC))
    deleted = _user(db, deleted=True)
    inactive_role = Role(role=f"grant-label-inactive-{uuid7().hex}", permissions={})
    db.add(inactive_role)
    db.flush()
    inactive_user = _user(db, role=inactive_role)
    inactive_role.is_deleted = True
    inactive_role.deleted_at = datetime.now(UTC)
    db.add_all(
        [
            BoardGrant(
                board_id=board.id,
                principal_type="user",
                principal_user_id=user.id,
                permission="view",
                effect="allow",
            )
            for user in (disabled, unaccepted, deleted, inactive_user)
        ]
    )
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="role",
            principal_role_id=inactive_role.id,
            permission="view",
            effect="allow",
        )
    )
    db.flush()

    response = _client(db, manager).get(f"/api/boards/{board.id}/grants?limit=10")

    assert response.status_code == 200
    grants = response.json()["items"]
    for user in (disabled, unaccepted, deleted, inactive_user):
        grant = next(item for item in grants if item["principal_user_id"] == str(user.id))
        assert (grant["principal_label"], grant["principal_available"]) == (
            "Unavailable user",
            False,
        )
    role_grant = next(item for item in grants if item["principal_role_id"] == str(inactive_role.id))
    assert (role_grant["principal_label"], role_grant["principal_available"]) == (
        "Unavailable role",
        False,
    )
    assert all(
        user.username not in response.text
        for user in (disabled, unaccepted, deleted, inactive_user)
    )
    assert inactive_role.role not in response.text
