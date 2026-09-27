"""Shared fixtures and model builders for RBAC route tests."""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime
from types import SimpleNamespace
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
from app.main import create_app
from app.systems.access.policy.models import AccessGroupMember, AccessPolicyVersion, AccessRule
from app.systems.access.users.models import IdentityKind, Role, User, UserRole
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module


def _persisted(entity: Any, *, deleted: bool = False) -> Any:
    now = datetime.now(UTC)
    entity.id = uuid7()
    entity.created_at = now
    entity.updated_at = now
    entity.is_deleted = deleted
    entity.deleted_at = now if deleted else None
    entity.performed_by = None
    return entity


def make_role(
    name: str = UserRole.MEMBER,
    permissions: object | None = None,
    *,
    deleted: bool = False,
) -> Role:
    role = Role(
        role=name,
        permissions={} if permissions is None else permissions,
        is_deleted=deleted,
    )
    return _persisted(role, deleted=deleted)


def make_user(
    name: str,
    *,
    role: Role | None = None,
    permissions: object | None = None,
    status: str = "active",
    deleted: bool = False,
) -> User:
    assigned_role = role or make_role(permissions=permissions)
    user = User(
        id=uuid7(),
        email=f"{name}@example.com",
        username=name,
        identity_kind=IdentityKind.INTERNAL.value,
        status=status,
        role_id=assigned_role.id,
        role=assigned_role,
        is_deleted=deleted,
    )
    return _persisted(user, deleted=deleted)


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


class _PolicySnapshotDatabase:
    """Supply route tests with the persisted policy baseline they do not exercise."""

    def __init__(self, delegate: Session, user: User) -> None:
        self._delegate = delegate
        self._user = user
        self._version = AccessPolicyVersion(singleton_key="workspace", revision=1)
        self._version.is_deleted = False

    def scalar(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        entity = _statement_entity(statement)
        if entity is AccessPolicyVersion:
            return self._version
        if entity is User:
            return self._user
        if entity is Role:
            return self._user.role
        return self._delegate.scalar(statement, *args, **kwargs)

    def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        entities = _statement_entities(statement)
        if AccessGroupMember in entities:
            return SimpleNamespace(all=lambda: [])
        return self._delegate.execute(statement, *args, **kwargs)

    def scalars(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        if _statement_entity(statement) is AccessRule:
            return SimpleNamespace(all=lambda: [])
        return self._delegate.scalars(statement, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


def _statement_entities(statement: Any) -> set[object]:
    descriptions = getattr(statement, "column_descriptions", ())
    return {description.get("entity") for description in descriptions if description.get("entity")}


def _statement_entity(statement: Any) -> object | None:
    entities = _statement_entities(statement)
    return next(iter(entities)) if len(entities) == 1 else None


@pytest.fixture
def api() -> Generator[FastAPI, None, None]:
    application = create_app()
    yield application
    application.dependency_overrides.clear()


def _client(application: FastAPI, user: User, db: Session | None = None) -> TestClient:
    database = db or Mock(spec=Session)
    application.dependency_overrides[get_current_user] = lambda: user
    application.dependency_overrides[get_db] = lambda: _PolicySnapshotDatabase(database, user)
    return TestClient(application)
