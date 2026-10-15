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
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.access.users.schemas import UserUpdate
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization, guarded_create_engine
from tests.race_support import backend_pid, wait_until_blocked_by

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
        organization = create_organization(db)
        org_id = organization.id
        for user_id in (first_id, second_id):
            create_member(
                    db, organization,
                    id=user_id,
                    email=f"admin-{user_id.hex}@example.com",
                    username=f"admin_{user_id.hex[:16]}",
                    role=UserRole.ADMIN.value,
                    status=UserStatus.ACTIVE.value,
            )
        db.commit()

    first_at_commit = Event()
    release_first = Event()
    second_projection_done = Event()
    holder: list[int] = []
    original_projection = account_operations.ensure_projected_admin_remains
    original_disable = account_operations._disable_user

    def observe_projection(
        db: Session, user: User, membership: Membership, **kwargs: object
    ) -> None:
        original_projection(db, user, membership, **kwargs)
        if user.id == second_id:
            second_projection_done.set()

    def pause_first_disable(
        db: Session, user: User, membership: Membership, **kwargs: object
    ) -> User:
        if user.id == first_id:
            holder.append(backend_pid(db))
            first_at_commit.set()
            assert release_first.wait(timeout=5)
        return original_disable(db, user, membership, **kwargs)

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
                wait_until_blocked_by(engine, holder[0])
                assert not second_projection_done.is_set()
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
                for membership in db.scalars(
                    select(Membership).where(Membership.user_id == user_id)
                ):
                    db.delete(membership)
                db.flush()
                user = db.get(User, user_id)
                if user is not None:
                    db.delete(user)
            db.flush()
            db.delete(db.get(WorkspaceProfile, org_id))
            db.commit()
        engine.dispose()
