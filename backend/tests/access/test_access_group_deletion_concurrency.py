"""Concurrent rule creation cannot target a group being deleted."""

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy import rules_service, service
from app.systems.access.policy.models import AccessGroup, AccessRule
from app.systems.access.policy.schemas import AccessRuleCreate
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.access.users.permissions import Capability
from tests.conftest import guarded_create_engine


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("TEST_DATABASE_URL") is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_group_delete_winning_lock_rejects_concurrent_rule_creation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=2, max_overflow=0)
    group_id, actor_id = uuid7(), uuid7()
    with Session(engine) as db:
        role = db.scalar(
            select(Role).where(Role.role == UserRole.MEMBER.value, Role.is_deleted.is_(False))
        )
        assert isinstance(role, Role)
        db.add(
            User(
                id=actor_id,
                email=f"group-race-{uuid7().hex}@example.com",
                username=f"group-race-{uuid7().hex[:12]}",
                role_id=role.id,
                status=UserStatus.ACTIVE.value,
                identity_kind=IdentityKind.INTERNAL.value,
            )
        )
        db.add(AccessGroup(id=group_id, name=f"Race {uuid7().hex}", description="", revision=1))
        db.commit()

    group_locked = Event()
    allow_delete = Event()
    rule_attempted = Event()
    original_check = service.ensure_group_deletable
    original_validate = rules_service.validate_references

    def pause_after_group_lock(db: Session, group: AccessGroup) -> None:
        original_check(db, group)
        group_locked.set()
        assert allow_delete.wait(timeout=5)

    def observe_rule_reference(
        db: Session, payload: AccessRuleCreate, *, lock: bool = True
    ) -> None:
        rule_attempted.set()
        original_validate(db, payload, lock=lock)

    monkeypatch.setattr(service, "ensure_group_deletable", pause_after_group_lock)
    monkeypatch.setattr(rules_service, "validate_references", observe_rule_reference)

    def delete_group() -> None:
        with Session(engine) as db:
            service.delete_group(db, group_id, f'"{group_id}:1"', actor_id)

    def create_rule() -> int:
        with Session(engine) as db:
            try:
                rules_service.create_rule(
                    db,
                    AccessRuleCreate(
                        subject_kind="group",
                        subject_id=group_id,
                        scope_kind="workspace",
                        permission_id=Capability.RECORDS_READ,
                        decision="deny",
                    ),
                    actor_id,
                )
            except HTTPException as error:
                return error.status_code
        return 201

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            deletion = executor.submit(delete_group)
            assert group_locked.wait(timeout=5)
            creation = executor.submit(create_rule)
            assert rule_attempted.wait(timeout=5)
            allow_delete.set()
            deletion.result(timeout=10)
            assert creation.result(timeout=10) == 409
        with Session(engine) as db:
            group = db.get(AccessGroup, group_id)
            assert group is not None and group.is_deleted is True
            assert db.scalars(
                select(AccessRule).where(
                    AccessRule.subject_kind == "group",
                    AccessRule.subject_id == group_id,
                    AccessRule.is_deleted.is_(False),
                )
            ).first() is None
    finally:
        allow_delete.set()
        with Session(engine) as db:
            for rule in db.scalars(
                select(AccessRule).where(AccessRule.subject_id == group_id)
            ).all():
                db.delete(rule)
            group = db.get(AccessGroup, group_id)
            if group is not None:
                db.delete(group)
            actor = db.get(User, actor_id)
            if actor is not None:
                db.delete(actor)
            db.commit()
        engine.dispose()
