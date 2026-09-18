"""Shared fixtures and model builders for RBAC route tests."""
from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime
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
from app.systems.access.users.models import Role, User, UserRole
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
        status=status,
        role_id=assigned_role.id,
        role=assigned_role,
        is_deleted=deleted,
    )
    return _persisted(user, deleted=deleted)


def make_module(department_id=None, *, accepted: bool = False) -> Module:
    module = Module(
        department_id=department_id or uuid7(),
        module_name="Assets",
        is_schema_accepted=accepted,
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
    application = create_app()
    yield application
    application.dependency_overrides.clear()


def _client(application: FastAPI, user: User, db: Session | None = None) -> TestClient:
    database = db or Mock(spec=Session)
    application.dependency_overrides[get_current_user] = lambda: user
    application.dependency_overrides[get_db] = lambda: database
    return TestClient(application)
