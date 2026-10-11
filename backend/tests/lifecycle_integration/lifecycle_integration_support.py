from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


@pytest.fixture
def lifecycle_graph(integration_db: Session) -> dict[str, object]:
    token = str(uuid7())
    department_x = Department(department_name=f"Lifecycle X {token}")
    department_y = Department(department_name=f"Lifecycle Y {token}")
    module_x = Module(
        department=department_x,
        module_name=f"Module X {token}",
    )
    module_y = Module(
        department=department_y,
        module_name=f"Module Y {token}",
    )
    integration_db.add_all([department_x, department_y, module_x, module_y])
    integration_db.flush()
    field_same = Field(
        module=module_x,
        name="Same module relationship",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=module_x.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    field_external = Field(
        module=module_x,
        name="External relationship",
        type=FieldType.RELATIONSHIP,
        position=1,
        relationship_target_module_id=module_y.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    field_y = Field(
        module=module_y,
        name="Y relationship",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=module_y.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    source = Record(module=module_x)
    same_target = Record(module=module_x)
    external_target = Record(module=module_y)
    external_other = Record(module=module_y)
    deleted_target = Record(module=module_x)
    integration_db.add_all(
        [
            field_same,
            field_external,
            field_y,
            source,
            same_target,
            external_target,
            external_other,
            deleted_target,
        ]
    )
    integration_db.flush()
    same_edge = RelationshipEdge(
        field=field_same, source_record=source, target_record=same_target
    )
    external_edge = RelationshipEdge(
        field=field_external, source_record=source, target_record=external_target
    )
    unrelated_edge = RelationshipEdge(
        field=field_same, source_record=same_target, target_record=deleted_target
    )
    external_unrelated_edge = RelationshipEdge(
        field=field_y, source_record=external_target, target_record=external_other
    )
    integration_db.add_all([same_edge, external_edge, unrelated_edge, external_unrelated_edge])
    integration_db.flush()
    # Lifecycle services commit and roll back their own transactions. Commit
    # fixture setup into the outer test transaction so operation rollbacks do
    # not erase the graph being asserted.
    integration_db.commit()
    graph: dict[str, object] = {
        "department_x": department_x,
        "department_y": department_y,
        "module_x": module_x,
        "module_y": module_y,
        "field_same": field_same,
        "field_external": field_external,
        "field_y": field_y,
        "source": source,
        "same_target": same_target,
        "external_target": external_target,
        "external_other": external_other,
        "deleted_target": deleted_target,
        "same_edge": same_edge,
        "external_edge": external_edge,
        "unrelated_edge": unrelated_edge,
        "external_unrelated_edge": external_unrelated_edge,
    }
    return graph


def _item(graph: dict[str, object], key: str) -> object:
    return graph[key]


@pytest.fixture
def primitive_field_graph(integration_db: Session) -> dict[str, object]:
    token = str(uuid7())
    department = Department(department_name=f"Primitive purge {token}")
    module = Module(department=department, module_name=f"Primitive module {token}")
    field = Field(module=module, name="Retired primitive", type=FieldType.TEXT, position=0)
    integration_db.add_all([department, module, field])
    integration_db.flush()
    field_key = str(field.id)
    active = Record(module=module, data={"keep": {"nested": [1, 2]}, field_key: "active"})
    archived = Record(
        module=module,
        data={"keep": "archived", field_key: {"preserve": True}},
        is_deleted=True,
    )
    integration_db.add_all([active, archived])
    integration_db.flush()
    field.is_deleted = True
    field.deleted_at = datetime.now(UTC)
    integration_db.commit()
    graph = {
        "department": department,
        "module": module,
        "field": field,
        "active": active,
        "archived": archived,
    }
    return graph


def _close_rows(*rows: object) -> None:
    timestamp = datetime.now(UTC)
    for row in rows:
        row.is_deleted = True  # type: ignore[attr-defined]
        row.deleted_at = timestamp  # type: ignore[attr-defined]
