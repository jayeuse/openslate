"""Helpers for isolating catalog behavior from the RBAC contract."""

from typing import Any, get_args
from unittest.mock import Mock

from fastapi import FastAPI
from sqlalchemy.orm import Session

from app.systems.access.users.models import Membership
from app.systems.sandbox.departments.router import DepartmentReadUser
from app.systems.sandbox.fields.router import FieldReadUser
from app.systems.sandbox.modules.router import ModuleReadUser
from app.systems.sandbox.records.router import RecordReadUser, RecordWriteUser
from tests.rbac.support import make_user

_CATALOG_ACTOR_DEPENDENCIES = (
    DepartmentReadUser,
    FieldReadUser,
    ModuleReadUser,
    RecordReadUser,
    RecordWriteUser,
)


def catalog_actor_dependencies() -> tuple[Any, ...]:
    """Return the exact user dependencies attached to catalog routes."""

    dependencies: list[Any] = []
    for annotated_user in _CATALOG_ACTOR_DEPENDENCIES:
        dependency = get_args(annotated_user)[1].dependency
        if dependency is None:
            raise TypeError("Catalog actor annotation must declare a dependency")
        dependencies.append(dependency)
    return tuple(dependencies)


def override_catalog_authorization(application: FastAPI, db: Session | None = None) -> None:
    """Allow endpoint contract tests to focus on catalog behavior, not RBAC."""

    actor, membership = make_user("catalog-admin", db=None if isinstance(db, Mock) else db)
    if isinstance(db, Mock):
        db.dirty = set()
        result, original = db.scalars.return_value, db.scalars.side_effect
        db.scalars.side_effect = lambda query: (
            Mock(all=lambda: [membership])
            if query.column_descriptions[0]["entity"] is Membership
            else original(query) if callable(original) else result
        )
    for dependency in catalog_actor_dependencies():
        application.dependency_overrides[dependency] = lambda: actor
