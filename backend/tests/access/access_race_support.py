"""Shared steps of the Access race tests: one guarded action, a group's ETag, a user."""

from collections.abc import Callable
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.service as policy_service
from app.systems.access.policy.models import Group
from app.systems.access.users.models import User, UserStatus


def run_action(engine: Engine, action: Callable[[Session], object]) -> int:
    """Run ``action`` in its own session; return 200, or the refusal's HTTP status."""

    with Session(engine) as db:
        try:
            action(db)
        except HTTPException as error:
            db.rollback()
            return error.status_code
        return 200


def group_etag_of(engine: Engine, group_id: UUID) -> str:
    with Session(engine) as db:
        group = db.get(Group, group_id)
        assert group is not None
        return policy_service.group_etag(group)


def add_race_user(db: Session, prefix: str, role: str) -> UUID:
    user = User(
        email=f"{prefix}-{uuid7().hex}@example.com",
        username=f"{prefix}_{uuid7().hex[:20]}",
        role=role,
        status=UserStatus.ACTIVE.value,
    )
    db.add(user)
    db.flush()
    return user.id
