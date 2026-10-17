"""Canonical operational row locks for the publication transaction."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.membership import bound_organization
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.openview.charts.models import Chart
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.structure_mutations import lock_module_access
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


def lock_operational_rows(db: Session) -> None:
    """Use canonical class order, after group and access rows, before inspection and mutation."""

    lock_module_access(db)
    for model in (
        WorkspaceProfile,
        SandboxBinding,
        Department,
        Module,
        Chart,
        Field,
        Record,
        RelationshipEdge,
        RecordTrigger,
        RecordTriggerCondition,
        RecordTriggerAction,
    ):
        statement = select(model.id)
        if model is WorkspaceProfile:
            statement = statement.where(WorkspaceProfile.id == bound_organization(db))
        db.scalars(statement.order_by(model.id).with_for_update()).all()
