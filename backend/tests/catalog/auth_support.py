"""Helpers for isolating catalog behavior from the RBAC contract."""

from typing import Any, get_args

from fastapi import FastAPI

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


def override_catalog_authorization(application: FastAPI) -> None:
    """Allow endpoint contract tests to focus on catalog behavior, not RBAC."""

    actor = make_user("catalog-admin")
    for dependency in catalog_actor_dependencies():
        application.dependency_overrides[dependency] = lambda actor=actor: actor
