"""Shared fixtures and model builders for RBAC route tests."""

from __future__ import annotations

from collections.abc import Generator, Iterable
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import (
    get_current_user,
)
from app.common.listing import ListQueryResult, PaginationMetadata
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.conftest import create_member, create_organization


def organization(db: Session) -> WorkspaceProfile:
    """The explicitly created organization shared by this test's RBAC builders."""
    if "rbac_organization" not in db.info:
        db.info["rbac_organization"] = create_organization(db)
    return db.info["rbac_organization"]


def _persisted(entity: Any, *, deleted: bool = False) -> Any:
    now = datetime.now(UTC)
    entity.id = uuid7()
    entity.created_at = now
    entity.updated_at = now
    entity.is_deleted = deleted
    entity.deleted_at = now if deleted else None
    entity.performed_by = None
    return entity


def make_user(
    name: str,
    *,
    role: str = UserRole.ADMIN,
    status: str = "active",
    deleted: bool = False,
    db: Session | None = None,
) -> tuple[User, Membership]:
    """Build an unpersisted user for route tests whose database is a mock.

    Route tests that use a mock session act as an administrator by default:
    the access function then needs no database. Tests that deny a member or a
    guest use the PostgreSQL builders below.
    """

    guest = role == UserRole.GUEST
    now = datetime.now(UTC)
    user, membership = create_member(
        db, organization(db) if db is not None else WorkspaceProfile(id=uuid7()), str(role),
        id=uuid7(),
        email=f"{name}@example.com",
        username=name,
        status=status,
        sponsor_user_id=uuid7() if guest else None,
        expires_at=datetime.now(UTC) + timedelta(days=30) if guest else None,
        is_deleted=deleted,
        created_at=now,
        updated_at=now,
        deleted_at=now if deleted else None,
    )
    membership.is_deleted = False
    return user, membership


def add_user(
    db: Session,
    name: str | None = None,
    *,
    role: str = UserRole.MEMBER,
    status: str = UserStatus.ACTIVE,
    sponsor: User | None = None,
    expires_at: datetime | None = None,
) -> User:
    """Persist a user. A guest gets a persisted member sponsor and an expiry."""

    label = name or f"user-{uuid7().hex[-12:]}"
    if role == UserRole.GUEST:
        sponsor = sponsor or add_user(db, role=UserRole.MEMBER)
        expires_at = expires_at or datetime.now(UTC) + timedelta(days=30)
    user, _membership = create_member(
        db, organization(db), str(role),
        email=f"{label}-{uuid7().hex[-12:]}@example.com",
        username=f"{label}-{uuid7().hex[-12:]}"[:100],
        status=str(status),
        sponsor_user_id=sponsor.id if sponsor is not None else None,
        expires_at=expires_at,
    )
    return user


def add_department(db: Session, name: str | None = None) -> Department:
    department = Department(org_id=organization(db).id,
                            department_name=name or f"Department {uuid7().hex[-12:]}")
    db.add(department)
    db.flush()
    return department


def add_module(db: Session, department: Department, name: str | None = None) -> Module:
    module = Module(org_id=department.org_id, department_id=department.id,
                    module_name=name or f"Module {uuid7().hex[-12:]}")
    db.add(module)
    db.flush()
    return module


def make_group_access(
    db: Session,
    members: Iterable[User],
    department: Department,
    module: Module | None = None,
    *,
    level: str = AccessLevel.READ,
    group: Group | None = None,
) -> GroupAccess:
    """Persist one group access row, creating the group and its members when needed."""

    if group is None:
        group = Group(org_id=department.org_id, name=f"Group {uuid7().hex}")
        db.add(group)
        db.flush()
    for member in members:
        db.add(GroupMember(org_id=department.org_id, group_id=group.id, user_id=member.id))
    grant = GroupAccess(
        org_id=department.org_id,
        group_id=group.id,
        department_id=department.id,
        module_id=module.id if module is not None else None,
        level=str(level),
    )
    db.add(grant)
    db.flush()
    return grant


_CAPABILITY_ACTORS_KEY = "rbac_capability_actors"


def capability_actor(
    db: Session,
    name: str,
    permissions: dict[str, bool] | None = None,
    *,
    role: str | None = None,
) -> User:
    """Translate a retired capability set of a test actor into the access model.

    ``records.write`` makes a member who writes every module that
    :func:`grant_capability_actors` later sees; ``records.read`` alone makes a
    guest who reads them; no capability makes a member in no group. An explicit
    ``role`` is used as given and gets no group.
    """

    granted = permissions or {}
    level: AccessLevel | None = None
    if role is None:
        if granted.get("records.write") is True:
            role, level = UserRole.MEMBER.value, AccessLevel.WRITE
        elif granted.get("records.read") is True:
            role, level = UserRole.GUEST.value, AccessLevel.READ
        else:
            role = UserRole.MEMBER.value
    user = add_user(db, name, role=role)
    if level is not None:
        db.info.setdefault(_CAPABILITY_ACTORS_KEY, []).append((user, level))
    return user


def grant_capability_actors(db: Session, department: Department, module: Module) -> None:
    """Give every registered capability actor its level on a new module."""

    for actor, level in db.info.get(_CAPABILITY_ACTORS_KEY, []):
        make_group_access(db, [actor], department, module, level=level)


def make_module(department_id=None) -> Module:
    module = Module(
        department_id=department_id or uuid7(),
        module_name="Assets",
    )
    return _persisted(module)


def make_field(module_id, *, position: int, name: str) -> Field:
    return _persisted(
        Field(
            module_id=module_id,
            name=name,
            type=FieldType.TEXT,
            required=False,
            position=position,
            config={},
        )
    )


def _empty_list_result() -> ListQueryResult[Any]:
    return ListQueryResult(
        items=[],
        pagination=PaginationMetadata(
            limit=25,
            offset=0,
            count=0,
            total=0,
            has_more=False,
        ),
    )


@pytest.fixture
def api() -> Generator[FastAPI, None, None]:
    from app.main import create_app

    application = create_app()
    yield application
    application.dependency_overrides.clear()


def _client(
    application: FastAPI, user: User | tuple[User, Membership], db: Session | None = None,
) -> TestClient:
    database = db or Mock(spec=Session)
    if isinstance(user, tuple):
        user, membership = user
        if isinstance(database, Mock):
            database.dirty = set()
            original = database.scalars.side_effect
            result = database.scalars.return_value
            database.scalars.side_effect = lambda query: (
                Mock(all=lambda: [membership], one=result.one, one_or_none=result.one_or_none)
                if query.column_descriptions[0]["entity"] is Membership
                else original(query) if callable(original) else result
            )
    application.dependency_overrides[get_current_user] = lambda: user
    application.dependency_overrides[get_db] = lambda: database
    return TestClient(application)
