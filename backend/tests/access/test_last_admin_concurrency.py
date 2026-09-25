"""Concurrent administrator changes cannot remove the final usable account."""

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as account_operations
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.access.users.schemas import UserUpdate
from tests.conftest import guarded_create_engine

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def test_concurrent_self_disable_leaves_one_usable_administrator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=3)
    first_id, second_id = uuid7(), uuid7()
    with Session(engine) as db:
        admin_role = db.scalar(select(Role).where(Role.role == UserRole.ADMIN.value))
        assert admin_role is not None
        for user_id in (first_id, second_id):
            db.add(
                User(
                    id=user_id,
                    email=f"admin-{user_id.hex}@example.com",
                    username=f"admin_{user_id.hex[:16]}",
                    role_id=admin_role.id,
                    status=UserStatus.ACTIVE.value,
                    identity_kind=IdentityKind.INTERNAL.value,
                )
            )
        db.commit()

    first_at_commit = Event()
    release_first = Event()
    second_projection_done = Event()
    original_projection = account_operations.ensure_projected_admin_remains
    original_disable = account_operations._disable_user

    def observe_projection(db: Session, user: User, **kwargs: object) -> None:
        original_projection(db, user, **kwargs)
        if user.id == second_id:
            second_projection_done.set()

    def pause_first_disable(db: Session, user: User, **kwargs: object) -> User:
        if user.id == first_id:
            first_at_commit.set()
            assert release_first.wait(timeout=5)
        return original_disable(db, user, **kwargs)

    monkeypatch.setattr(account_operations, "ensure_projected_admin_remains", observe_projection)
    monkeypatch.setattr(account_operations, "_disable_user", pause_first_disable)
    monkeypatch.setattr(account_operations, "_record_outcome", lambda *_args, **_kwargs: None)

    def disable_self(user_id):
        with Session(engine) as db:
            try:
                account_operations.update_user(
                    user_id,
                    UserUpdate(status=UserStatus.DISABLED),
                    User(id=user_id),
                    db,
                )
            except HTTPException as error:
                db.rollback()
                return error.status_code
            return 200

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(disable_self, first_id)
            assert first_at_commit.wait(timeout=5)
            second = executor.submit(disable_self, second_id)
            try:
                assert not second_projection_done.wait(timeout=0.5)
            finally:
                release_first.set()
            assert first.result(timeout=5) == 200
            assert second.result(timeout=5) == 409
        with Session(engine) as db:
            states = [db.get(User, user_id).status for user_id in (first_id, second_id)]
            assert states.count(UserStatus.ACTIVE.value) == 1
    finally:
        release_first.set()
        with Session(engine) as db:
            for user_id in (first_id, second_id):
                user = db.get(User, user_id)
                if user is not None:
                    db.delete(user)
            db.commit()
        engine.dispose()
