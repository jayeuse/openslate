"""Lifecycle graphs for the PostgreSQL lifecycle tests, committed into the test transaction."""

from collections.abc import Callable, Collection, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, bindparam, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import BaseModel
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


@dataclass(frozen=True)
class LifecycleGraph:
    """Two departments; module X links to itself and to module Y."""

    department_x: Department
    department_y: Department
    module_x: Module
    module_y: Module
    field_same: Field
    field_external: Field
    field_y: Field
    source: Record
    same_target: Record
    external_target: Record
    external_other: Record
    deleted_target: Record
    same_edge: RelationshipEdge
    external_edge: RelationshipEdge
    unrelated_edge: RelationshipEdge
    external_unrelated_edge: RelationshipEdge


@dataclass(frozen=True)
class PrimitiveFieldGraph:
    """A closed text field whose key is in one active and one archived record."""

    department: Department
    module: Module
    field: Field
    active: Record
    archived: Record


@pytest.fixture
def lifecycle_graph(integration_db: Session) -> LifecycleGraph:
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
    same_edge = RelationshipEdge(field=field_same, source_record=source, target_record=same_target)
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
    return LifecycleGraph(
        department_x=department_x,
        department_y=department_y,
        module_x=module_x,
        module_y=module_y,
        field_same=field_same,
        field_external=field_external,
        field_y=field_y,
        source=source,
        same_target=same_target,
        external_target=external_target,
        external_other=external_other,
        deleted_target=deleted_target,
        same_edge=same_edge,
        external_edge=external_edge,
        unrelated_edge=unrelated_edge,
        external_unrelated_edge=external_unrelated_edge,
    )


@pytest.fixture
def primitive_field_graph(integration_db: Session) -> PrimitiveFieldGraph:
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
    return PrimitiveFieldGraph(
        department=department, module=module, field=field, active=active, archived=archived
    )


def close_rows(*rows: BaseModel) -> None:
    """Soft-delete *rows* with one shared timestamp, as a lifecycle close would."""

    timestamp = datetime.now(UTC)
    for row in rows:
        row.is_deleted = True
        row.deleted_at = timestamp


PASSWORD_CLIENT = "app.systems.sandbox.lifecycle.challenge_verification.ProviderPasswordGrantClient"


def patch_password_boundary(
    monkeypatch: pytest.MonkeyPatch,
    verify: Callable[[], UUID],
    *,
    purge_enabled: bool | None = None,
) -> None:
    """Replace the provider password grant with *verify*; optionally set purge on or off."""

    class PasswordClient:
        def __init__(self, _db: object) -> None:
            pass

        def verify_password(self, _email: str, _password: str) -> UUID:
            return verify()

    if purge_enabled is not None:
        monkeypatch.setattr(
            "app.systems.sandbox.lifecycle.router.get_settings",
            lambda: SimpleNamespace(lifecycle_purge_enabled=purge_enabled),
        )
    monkeypatch.setattr(PASSWORD_CLIENT, PasswordClient)


@contextmanager
def password_boundary(
    verify: Callable[[], UUID], *, purge_enabled: bool | None = None
) -> Iterator[None]:
    """``patch_password_boundary`` for the duration of a ``with`` block."""

    with pytest.MonkeyPatch.context() as monkeypatch:
        patch_password_boundary(monkeypatch, verify, purge_enabled=purge_enabled)
        yield


def _delete_ids(connection: Connection, table: str, ids: Collection[UUID]) -> None:
    if ids:
        connection.execute(
            text(f"DELETE FROM public.{table} WHERE id IN :ids").bindparams(
                bindparam("ids", expanding=True)
            ),
            {"ids": list(ids)},
        )


def delete_committed_scope(
    connection: Connection,
    *,
    actor_id: UUID | None = None,
    audit_entity_ids: Collection[UUID] = (),
    audit_request_ids: Collection[UUID] = (),
    audit_by_actor: bool = False,
    field_ids: Collection[UUID] = (),
    module_ids: Collection[UUID] = (),
    department_ids: Collection[UUID] = (),
) -> None:
    """Delete rows that a lifecycle test committed, on an owner *connection*.

    With *actor_id*, the actor's lifecycle failures, challenges and rate-limit buckets go
    first. Audit rows go when they match an entity id, a request id or, with
    *audit_by_actor*, the actor. Fields, modules and departments go last, in that order.
    """

    if actor_id is not None:
        for table in (
            "lifecycle_rate_limit_failures",
            "lifecycle_confirmation_challenges",
            "lifecycle_rate_limit_buckets",
        ):
            connection.execute(
                text(f"DELETE FROM public.{table} WHERE actor_id = :actor_id"),
                {"actor_id": actor_id},
            )
    predicates: list[str] = []
    expanding = []
    values: dict[str, object] = {}
    if audit_by_actor:
        if actor_id is None:
            raise ValueError("audit_by_actor needs actor_id")
        predicates.append("performed_by = :actor_id")
        values["actor_id"] = actor_id
    for column, name, ids in (
        ("entity_id", "entity_ids", audit_entity_ids),
        ("request_id", "request_ids", audit_request_ids),
    ):
        if ids:
            predicates.append(f"{column} IN :{name}")
            expanding.append(bindparam(name, expanding=True))
            values[name] = list(ids)
    if predicates:
        connection.execute(
            text("DELETE FROM public.audit_logs WHERE " + " OR ".join(predicates)).bindparams(
                *expanding
            ),
            values,
        )
    _delete_ids(connection, "fields", field_ids)
    _delete_ids(connection, "modules", module_ids)
    _delete_ids(connection, "departments", department_ids)


def close_field(client: TestClient, field: Field) -> None:
    """Close *field* through its preview and confirmed close routes."""

    preview = client.post(f"/api/fields/{field.id}/close/preview")
    assert preview.status_code == 200, preview.text
    response = client.post(
        f"/api/fields/{field.id}/close",
        json={
            "token": preview.json()["token"],
            "confirmation_name": field.name,
            "password": "owned chart lifecycle password",
        },
    )
    assert response.status_code == 200, response.text
