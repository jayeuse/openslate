"""Request-local live rows reused while building a publication plan."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from itertools import islice
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding

_ID_CHUNK_SIZE = 10_000


@dataclass(slots=True)
class PublicationSnapshot:
    departments: dict[UUID, Department] = field(default_factory=dict)
    modules: dict[UUID, Module] = field(default_factory=dict)
    fields: dict[UUID, Field] = field(default_factory=dict)
    automations: dict[UUID, PublishedAutomationDefinition] = field(default_factory=dict)
    conditions: dict[UUID, list[PublishedAutomationCondition]] = field(default_factory=dict)
    actions: dict[UUID, list[PublishedAutomationAction]] = field(default_factory=dict)

    def target(self, kind: str, target_id: UUID | None) -> Any | None:
        if target_id is None:
            return None
        if kind == "department":
            return self.departments.get(target_id)
        if kind == "module":
            return self.modules.get(target_id)
        if kind in {"field", "relationship"}:
            return self.fields.get(target_id)
        if kind == "automation":
            return self.automations.get(target_id)
        return None

    def binding_target(self, binding: SandboxBinding) -> Any | None:
        target_id = {
            "department": binding.department_id,
            "module": binding.module_id,
            "field": binding.field_id,
            "relationship": binding.field_id,
            "automation": binding.automation_id,
        }.get(binding.kind)
        return self.target(binding.kind, target_id)


def load_publication_snapshot(db: Session, bindings: list[SandboxBinding]) -> PublicationSnapshot:
    """Load bound targets and active automation children in bounded table queries."""

    department_ids = {
        binding.department_id for binding in bindings if binding.department_id is not None
    }
    module_ids = {binding.module_id for binding in bindings if binding.module_id is not None}
    field_ids = {binding.field_id for binding in bindings if binding.field_id is not None}
    automation_ids = {
        binding.automation_id for binding in bindings if binding.automation_id is not None
    }
    snapshot = PublicationSnapshot()

    for identifiers in _chunks(department_ids):
        for department_row in db.scalars(select(Department).where(Department.id.in_(identifiers))):
            snapshot.departments[department_row.id] = department_row
    for identifiers in _chunks(module_ids):
        for module_row in db.scalars(select(Module).where(Module.id.in_(identifiers))):
            snapshot.modules[module_row.id] = module_row
    for identifiers in _chunks(field_ids):
        for field_row in db.scalars(select(Field).where(Field.id.in_(identifiers))):
            snapshot.fields[field_row.id] = field_row
    for identifiers in _chunks(automation_ids):
        for automation_row in db.scalars(
            select(PublishedAutomationDefinition).where(
                PublishedAutomationDefinition.id.in_(identifiers)
            )
        ):
            snapshot.automations[automation_row.id] = automation_row
        for condition_row in db.scalars(
            select(PublishedAutomationCondition)
            .where(
                PublishedAutomationCondition.automation_id.in_(identifiers),
                PublishedAutomationCondition.is_deleted.is_(False),
            )
            .order_by(
                PublishedAutomationCondition.automation_id,
                PublishedAutomationCondition.position,
            )
        ):
            snapshot.conditions.setdefault(condition_row.automation_id, []).append(condition_row)
        for action_row in db.scalars(
            select(PublishedAutomationAction)
            .where(
                PublishedAutomationAction.automation_id.in_(identifiers),
                PublishedAutomationAction.is_deleted.is_(False),
            )
            .order_by(
                PublishedAutomationAction.automation_id,
                PublishedAutomationAction.position,
            )
        ):
            snapshot.actions.setdefault(action_row.automation_id, []).append(action_row)

    return snapshot


def _chunks(identifiers: set[UUID]) -> Iterator[list[UUID]]:
    values = iter(identifiers)
    while chunk := list(islice(values, _ID_CHUNK_SIZE)):
        yield chunk
