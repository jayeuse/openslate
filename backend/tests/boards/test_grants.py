"""Board grant management route contracts."""

from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Barrier
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.boards.grant_router import router
from app.systems.boards.models import Board, BoardGrant, BoardStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext, set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog


def _grant_request(
    revision: int,
    principal_type: str,
    permission: str,
    effect: str,
    *,
    user_id: UUID | None = None,
    role_id: UUID | None = None,
) -> dict[str, int | str]:
    body: dict[str, int | str] = {
        "revision": revision,
        "principal_type": principal_type,
        "permission": permission,
        "effect": effect,
    }
    if user_id is not None:
        body["principal_user_id"] = str(user_id)
    if role_id is not None:
        body["principal_role_id"] = str(role_id)
    return body


@pytest.mark.parametrize(
    ("principal_type", "user_id", "role_id"),
    [
        ("everyone", uuid7(), None),
        ("user", None, None),
        ("role", uuid7(), uuid7()),
    ],
    ids=["everyone-has-no-target", "user-needs-user-id", "role-has-one-target"],
)
def test_create_rejects_invalid_principal_shape_without_database_access(
    principal_type: str,
    user_id: UUID | None,
    role_id: UUID | None,
) -> None:
    database = Mock(spec=Session)
    assert _client(database, None).get(f"/api/boards/{uuid7()}/grants").status_code == 401
    actor = _actor(database, permissions={"records.write": True})

    response = _client(database, actor).post(
        f"/api/boards/{uuid7()}/grants",
        json=_grant_request(
            1,
            principal_type,
            "view",
            "allow",
            user_id=user_id,
            role_id=role_id,
        ),
    )

    assert response.status_code == 422
    database.scalar.assert_not_called()


def _actor(
    db: Session,
    *,
    permissions: dict[str, bool],
    role: Role | None = None,
    status: UserStatus = UserStatus.ACTIVE,
    invitation_sent_at: datetime | None = None,
    invitation_accepted_at: datetime | None = None,
    deleted: bool = False,
) -> User:
    if role is None:
        role = Role(role=f"board-grant-{uuid7().hex}", permissions=permissions)
        db.add(role)
        db.flush()

    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"board-grant-{user_id.hex}@example.test",
        username=f"board_grant_{user_id.hex[:20]}",
        status=status.value,
        role_id=role.id,
        role=role,
        invitation_sent_at=invitation_sent_at,
        invitation_accepted_at=invitation_accepted_at,
        is_deleted=deleted,
    )
    db.add(user)
    db.flush()
    return user


def _manager_board(db: Session) -> tuple[User, Board]:
    manager = _actor(
        db,
        permissions={"records.read": True, "records.write": True},
    )
    owner = _actor(db, permissions={}, role=manager.role)
    board = Board(owner_id=owner.id, name="Grant test board")
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


def _client(db: Session, actor: User | None) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _board_audit_rows(db: Session, board_id: UUID) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.entity_type == "boards", AuditLog.entity_id == board_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


@pytest.mark.integration
def test_read_only_board_manager_can_list_grants_but_cannot_mutate(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager = _actor(db, permissions={"records.read": True})
    owner = _actor(db, permissions={}, role=manager.role)
    board = Board(owner_id=owner.id, name="Read-only grant list")
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
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="everyone",
            permission="view",
            effect="deny",
        )
    )
    db.flush()
    set_audit_actor(db, manager.id)
    client = _client(db, manager)

    listed = client.get(f"/api/boards/{board.id}/grants?limit=1&offset=0")
    next_page = client.get(f"/api/boards/{board.id}/grants?limit=1&offset=1")
    denied = client.post(
        f"/api/boards/{board.id}/grants",
        json=_grant_request(1, "everyone", "view", "allow"),
    )

    assert listed.status_code == 200
    payload = listed.json()
    assert payload["board_revision"] == 1
    assert payload["pagination"]["total"] == 2
    assert payload["pagination"]["count"] == 1
    assert payload["pagination"]["has_more"] is True
    assert next_page.status_code == 200
    assert next_page.json()["items"][0]["principal_user_id"] == str(manager.id)
    assert set(next_page.json()["items"][0]) == {
        "id",
        "principal_type",
        "principal_user_id",
        "principal_role_id",
        "principal_label",
        "principal_available",
        "permission",
        "effect",
        "created_at",
        "updated_at",
    }
    assert denied.status_code == 403
    unchanged_board = db.get(Board, board.id)
    assert unchanged_board is not None and unchanged_board.revision == 1

    unmanaged = _actor(db, permissions={}, role=manager.role)
    hidden = _client(db, unmanaged).get(f"/api/boards/{board.id}/grants")
    missing = _client(db, unmanaged).get(f"/api/boards/{uuid7()}/grants")
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json() == missing.json() == {"detail": "Board not found"}


@pytest.mark.integration
def test_create_grants_targets_and_active_duplicate_conflict(integration_owner_db: Session) -> None:
    db = integration_owner_db
    manager, board = _manager_board(db)
    user_target = _actor(db, permissions={}, role=manager.role)
    role_target = Role(role=f"board-grantee-{uuid7().hex}", permissions={})
    db.add(role_target)
    db.flush()
    client = _client(db, manager)

    user_created = client.post(
        f"/api/boards/{board.id}/grants",
        json=_grant_request(1, "user", "edit", "allow", user_id=user_target.id),
    )
    assert user_created.status_code == 201
    user_grant_id = UUID(user_created.json()["grant"]["id"])
    duplicate = client.post(
        f"/api/boards/{board.id}/grants",
        json=_grant_request(2, "user", "edit", "allow", user_id=user_target.id),
    )
    role_created = client.post(
        f"/api/boards/{board.id}/grants",
        json=_grant_request(2, "role", "view", "deny", role_id=role_target.id),
    )
    assert user_created.json()["board_revision"] == 2
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "grant_exists"
    assert role_created.status_code == 201
    assert role_created.json()["board_revision"] == 3
    assert role_created.json()["grant"]["id"] != str(user_grant_id)
    current_board = db.get(Board, board.id)
    assert current_board is not None and current_board.revision == 3

    grants = db.scalars(
        select(BoardGrant).where(
            BoardGrant.board_id == board.id,
            BoardGrant.is_deleted.is_(False),
        )
    ).all()
    assert len(grants) == 3


@pytest.mark.integration
def test_inactive_or_unaccepted_grantees_are_rejected_without_revision_bump(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _manager_board(db)
    disabled_user = _actor(db, permissions={}, role=manager.role, status=UserStatus.DISABLED)
    unaccepted_user = _actor(
        db,
        permissions={},
        role=manager.role,
        invitation_sent_at=datetime.now(UTC),
    )
    deleted_user = _actor(db, permissions={}, role=manager.role, deleted=True)
    deleted_role = Role(
        role=f"board-grantee-deleted-{uuid7().hex}",
        permissions={},
        is_deleted=True,
    )
    db.add(deleted_role)
    db.flush()
    client = _client(db, manager)

    for principal_type, target_id in (
        ("user", disabled_user.id),
        ("user", unaccepted_user.id),
        ("user", deleted_user.id),
        ("role", deleted_role.id),
    ):
        body = _grant_request(
            1,
            principal_type,
            "view",
            "allow",
            user_id=target_id if principal_type == "user" else None,
            role_id=target_id if principal_type == "role" else None,
        )
        rejected = client.post(f"/api/boards/{board.id}/grants", json=body)
        assert rejected.status_code == 409
        assert rejected.json()["detail"]["code"] == "grantee_unavailable"

    accepted_user = _actor(
        db,
        permissions={},
        role=manager.role,
        invitation_sent_at=datetime.now(UTC),
        invitation_accepted_at=datetime.now(UTC),
    )
    accepted = client.post(
        f"/api/boards/{board.id}/grants",
        json=_grant_request(1, "user", "view", "allow", user_id=accepted_user.id),
    )

    assert accepted.status_code == 201
    assert accepted.json()["board_revision"] == 2
    current_board = db.get(Board, board.id)
    assert current_board is not None and current_board.revision == 2


@pytest.mark.integration
def test_revoke_soft_deletes_and_revision_checks_board_and_grant_audit(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _manager_board(db)
    client = _client(db, manager)
    created = client.post(
        f"/api/boards/{board.id}/grants",
        json=_grant_request(1, "everyone", "view", "allow"),
    )
    grant_id = UUID(created.json()["grant"]["id"])
    before_board_audit = len(_board_audit_rows(db, board.id))
    stale = client.delete(f"/api/boards/{board.id}/grants/{grant_id}?revision=1")
    revoked = client.delete(f"/api/boards/{board.id}/grants/{grant_id}?revision=2")

    grant = db.get(BoardGrant, grant_id)
    current_board = db.get(Board, board.id)
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_revision"
    assert revoked.status_code == 204 and revoked.headers["Cache-Control"] == "private, no-store"
    assert grant is not None and grant.is_deleted is True and grant.deleted_at is not None
    assert grant.principal_user_id is None and grant.principal_role_id is None
    assert current_board is not None and current_board.revision == 3
    assert len(_board_audit_rows(db, board.id)) == before_board_audit + 1
    grant_audit = list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.entity_type == "board_grants", AuditLog.entity_id == grant_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )
    assert len(grant_audit) == 2
    assert [row.action for row in grant_audit[-2:]] == [AuditAction.CREATE, AuditAction.DELETE]
    assert all(row.performed_by == manager.id for row in grant_audit[-2:])
    listing = client.get(f"/api/boards/{board.id}/grants")
    assert listing.status_code == 200
    assert grant_id not in {UUID(item["id"]) for item in listing.json()["items"]}


@pytest.mark.integration
def test_archived_boards_reject_grant_mutations_and_deleted_boards_stay_hidden(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, board = _manager_board(db)
    client = _client(db, manager)
    manager_grant = db.scalar(
        select(BoardGrant).where(
            BoardGrant.board_id == board.id,
            BoardGrant.principal_user_id == manager.id,
        )
    )
    assert manager_grant is not None
    board.status = BoardStatus.ARCHIVED
    db.flush()

    body = _grant_request(1, "everyone", "view", "allow")
    archived_create = client.post(f"/api/boards/{board.id}/grants", json=body)
    archived_revoke = client.delete(f"/api/boards/{board.id}/grants/{manager_grant.id}?revision=1")

    assert archived_create.status_code == archived_revoke.status_code == 409
    assert archived_create.json()["detail"]["code"] == "board_archived"
    assert archived_revoke.json()["detail"]["code"] == "board_archived"
    assert manager_grant.is_deleted is False
    assert board.revision == 1

    board.is_deleted = True
    board.deleted_at = datetime.now(UTC)
    db.flush()
    deleted_create = client.post(f"/api/boards/{board.id}/grants", json=body)
    deleted_revoke = client.delete(f"/api/boards/{board.id}/grants/{manager_grant.id}?revision=1")
    assert deleted_create.status_code == deleted_revoke.status_code == 404
    assert deleted_create.json() == deleted_revoke.json() == {"detail": "Board not found"}


def _concurrent_client(engine: Engine, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")

    def database_session() -> Generator[Session, None, None]:
        with AuditSession(bind=engine, expire_on_commit=False) as session:
            session.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=actor.id,
                request_id=uuid7(),
            )
            yield session

    app.dependency_overrides[get_db] = database_session
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


@pytest.mark.integration
def test_concurrent_grant_mutations_serialize_on_board_revision(
    integration_owner_db: Session,
) -> None:
    engine = integration_owner_db.connection().engine
    with AuditSession(bind=engine, expire_on_commit=False) as setup:
        manager_role = Role(
            role=f"board-race-{uuid7().hex}",
            permissions={"records.read": True, "records.write": True},
        )
        setup.add(manager_role)
        setup.flush()
        first_manager = _actor(setup, permissions={}, role=manager_role)
        second_manager = _actor(setup, permissions={}, role=manager_role)
        owner = _actor(setup, permissions={}, role=manager_role)
        board = Board(owner_id=owner.id, name="Concurrent grants")
        setup.add(board)
        setup.flush()
        board_id = board.id
        for manager in (first_manager, second_manager):
            setup.add(
                BoardGrant(
                    board_id=board_id,
                    principal_type="user",
                    principal_user_id=manager.id,
                    permission="manage",
                    effect="allow",
                )
            )
        setup.commit()
        manager_ids = (first_manager.id, second_manager.id)
        owner_id, role_id = owner.id, manager_role.id
        managers = setup.scalars(
            select(User).options(joinedload(User.role)).where(User.id.in_(manager_ids))
        ).all()
        actors = {manager.id: manager for manager in managers}
        setup.expunge_all()

    barrier = Barrier(2)

    def add_different_grant(actor_id: UUID, permission: str) -> tuple[int, dict[str, object]]:
        actor = actors[actor_id]
        with _concurrent_client(engine, actor) as client:
            barrier.wait(timeout=10)
            response = client.post(
                f"/api/boards/{board_id}/grants",
                json={
                    "revision": 1,
                    "principal_type": "everyone",
                    "permission": permission,
                    "effect": "allow",
                },
            )
            return response.status_code, response.json() if response.content else {}

    try:
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(
                workers.map(
                    lambda args: add_different_grant(*args),
                    ((manager_ids[0], "view"), (manager_ids[1], "edit")),
                )
            )

        assert sorted(status for status, _ in results) == [201, 409]
        stale_payload = next(payload for code, payload in results if code == 409)
        detail = stale_payload.get("detail")
        assert isinstance(detail, dict)
        assert detail.get("code") == "stale_revision"
        assert detail.get("current_revision") == 2
        with AuditSession(bind=engine) as verify:
            current_board = verify.get(Board, board_id)
            active_grants = verify.scalars(
                select(BoardGrant).where(
                    BoardGrant.board_id == board_id,
                    BoardGrant.is_deleted.is_(False),
                    BoardGrant.deleted_at.is_(None),
                )
            ).all()
            assert current_board is not None and current_board.revision == 2
            assert len(active_grants) == 3
    finally:
        # Independent sessions are needed for the race; remove only their committed rows.
        with AuditSession(bind=engine) as cleanup:
            grants = cleanup.scalars(
                select(BoardGrant).where(BoardGrant.board_id == board_id)
            ).all()
            for grant in grants:
                cleanup.delete(grant)
            cleanup.flush()
            retained_board = cleanup.get(Board, board_id)
            if retained_board is not None:
                cleanup.delete(retained_board)
                cleanup.flush()
            for user_id in (*manager_ids, owner_id):
                user = cleanup.get(User, user_id)
                if user is not None:
                    cleanup.delete(user)
            cleanup.flush()
            role = cleanup.get(Role, role_id)
            if role is not None:
                cleanup.delete(role)
            cleanup.commit()
