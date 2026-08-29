from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.listing import DeletedFilter, ListQueryResult, PaginationMetadata
from app.systems.fields.models import Field, FieldType
from app.systems.fields.schemas import FieldCreate
from app.systems.fields.validation import validate_record_data
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.schemas import (
    RelationshipAssignment,
    RelationshipAvailability,
    RelationshipCreate,
    RelationshipListRequest,
    RelationshipResponse,
)
from app.systems.relationships.service import (
    RelationshipConflict,
    RelationshipInvalid,
    _active_edge_statement,
    _nowait,
    assign_relationship,
    create_relationship,
    list_relationships,
    lock_row,
    relationship_response,
    unlink_relationship,
)


def make_module(*, department_id: UUID | None = None, deleted: bool = False) -> Module:
    module = Module(
        department_id=department_id or uuid7(),
        module_name="Assets",
        is_deleted=deleted,
    )
    module.id = uuid7()
    return module


def make_relationship_field(
    module: Module,
    target_module: Module,
    *,
    multiple_targets: bool = False,
    multiple_sources: bool = False,
    deleted: bool = False,
) -> Field:
    field = Field(
        module_id=module.id,
        name="Related asset",
        type=FieldType.RELATIONSHIP,
        required=False,
        position=0,
        config={},
        relationship_target_module_id=target_module.id,
        relationship_multiple_targets=multiple_targets,
        relationship_multiple_sources=multiple_sources,
        is_deleted=deleted,
    )
    field.id = uuid7()
    field.module = module
    field.relationship_target_module = target_module
    return field


def make_record(module: Module, *, deleted: bool = False) -> Record:
    record = Record(module_id=module.id, data={}, is_deleted=deleted)
    record.id = uuid7()
    record.module = module
    return record


def make_edge(
    field: Field,
    source: Record,
    target: Record,
    *,
    deleted: bool = False,
) -> RelationshipEdge:
    edge = RelationshipEdge(
        field_id=field.id,
        source_record_id=source.id,
        target_record_id=target.id,
        field=field,
        source_record=source,
        target_record=target,
        is_deleted=deleted,
    )
    edge.id = uuid7()
    edge.created_at = datetime.now(UTC)
    edge.updated_at = edge.created_at
    return edge


def locked_dependencies(
    field: Field, source: Record, target: Record | None
) -> tuple[Field, Record, Record | None]:
    return field, source, target


def test_lock_row_requests_authoritative_refresh() -> None:
    db = Mock(spec=Session)
    object_id = uuid7()

    lock_row(db, Module, object_id)

    db.get.assert_called_once_with(
        Module,
        object_id,
        populate_existing=True,
        with_for_update={"nowait": True},
    )


def test_locking_selects_refresh_existing_entities() -> None:
    for model in (Module, Field, Record, RelationshipEdge):
        statement = _nowait(select(model))
        assert statement.get_execution_options()["populate_existing"] is True

    assert _active_edge_statement(uuid7(), for_update=False).get_execution_options() == {}


def test_relationship_field_schema_requires_complete_metadata_and_excludes_record_data() -> None:
    target_module_id = uuid7()
    payload = FieldCreate(
        module_id=uuid7(),
        name="  Related asset  ",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=target_module_id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=False,
    )
    assert payload.name == "Related asset"
    assert payload.config == {}
    assert RelationshipCreate(
        field_id=uuid7(), source_record_id=uuid7(), target_record_id=uuid7()
    ).field_id

    with pytest.raises(ValueError):
        FieldCreate(
            module_id=uuid7(),
            name="Related asset",
            type=FieldType.RELATIONSHIP,
            position=0,
            relationship_target_module_id=target_module_id,
        )

    field_names = RelationshipResponse.model_fields
    assert "data" not in field_names
    assert {"visibility", "hidden_reasons"} <= field_names.keys()
    with pytest.raises(ValueError):
        RelationshipAssignment.model_validate({})


def test_relationship_field_rejects_relationship_ids_in_record_data() -> None:
    source_module = make_module()
    target_module = make_module(department_id=source_module.department_id)
    field = make_relationship_field(source_module, target_module)
    with pytest.raises(ValueError):
        validate_record_data({str(field.id): str(uuid7())}, [field])


def test_router_contract_is_admin_only_and_uses_nested_assignment_path() -> None:
    from app.systems.relationships.router import router

    app = FastAPI()
    app.include_router(router, prefix="/api")
    paths = TestClient(app).get("/openapi.json").json()["paths"]
    assert set(paths["/api/relationships"]) == {"get", "post"}
    assert set(paths["/api/relationships/{relationship_id}"]) == {"get", "delete"}
    assert set(paths["/api/relationships/fields/{field_id}/sources/{source_record_id}"]) == {"put"}

    from app.common.dependencies.auth import get_current_user
    from app.core.database import get_db

    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        role=SimpleNamespace(role="member")
    )
    app.dependency_overrides[get_db] = lambda: Mock(spec=Session)
    assert TestClient(app).get("/api/relationships").status_code == 403


def test_create_validates_exact_membership_and_department_from_attached_modules() -> None:
    department_id = uuid7()
    source_module = make_module(department_id=department_id)
    target_module = make_module(department_id=uuid7())
    field = make_relationship_field(source_module, target_module)
    source = make_record(source_module)
    target = make_record(target_module)
    db = Mock(spec=Session)

    with (
        patch(
            "app.systems.relationships.service._load_create_dependencies",
            return_value=(field, source, target),
        ),
        patch(
            "app.systems.relationships.service._lock_relationship_rows",
            return_value=locked_dependencies(field, source, target),
        ),
    ):
        with pytest.raises(RelationshipConflict, match="same department"):
            create_relationship(db, field.id, source.id, target.id)
    db.add.assert_not_called()


def test_create_rejects_self_links_and_duplicate_edges() -> None:
    module = make_module()
    field = make_relationship_field(module, module)
    record = make_record(module)
    db = Mock(spec=Session)

    with patch(
        "app.systems.relationships.service._load_create_dependencies",
        return_value=(field, record, record),
    ):
        with pytest.raises(RelationshipInvalid, match="must differ"):
            create_relationship(db, field.id, record.id, record.id)

    target = make_record(module)
    duplicate = make_edge(field, record, target)
    with (
        patch(
            "app.systems.relationships.service._load_create_dependencies",
            return_value=(field, record, target),
        ),
        patch(
            "app.systems.relationships.service._find_active_edge",
            return_value=duplicate,
        ),
    ):
        with pytest.raises(RelationshipConflict, match="already exists"):
            create_relationship(db, field.id, record.id, target.id)


@pytest.mark.parametrize(
    ("multiple_targets", "multiple_sources"),
    [(False, False), (False, True), (True, False), (True, True)],
)
def test_create_accepts_all_four_cardinalities(
    multiple_targets: bool, multiple_sources: bool
) -> None:
    module = make_module()
    field = make_relationship_field(
        module,
        module,
        multiple_targets=multiple_targets,
        multiple_sources=multiple_sources,
    )
    source, target = make_record(module), make_record(module)
    db = Mock(spec=Session)
    with (
        patch(
            "app.systems.relationships.service._load_create_dependencies",
            return_value=(field, source, target),
        ),
        patch("app.systems.relationships.service._find_active_edge", return_value=None),
    ):
        edge = create_relationship(db, field.id, source.id, target.id)
    assert (edge.field_id, edge.source_record_id, edge.target_record_id) == (
        field.id,
        source.id,
        target.id,
    )
    db.commit.assert_called_once()


@pytest.mark.parametrize(
    ("multiple_targets", "multiple_sources", "existing_side"),
    [(False, True, "source"), (True, False, "target"), (False, False, "source")],
)
def test_create_enforces_both_cardinalities(
    multiple_targets: bool, multiple_sources: bool, existing_side: str
) -> None:
    module = make_module()
    field = make_relationship_field(
        module,
        module,
        multiple_targets=multiple_targets,
        multiple_sources=multiple_sources,
    )
    source, target = make_record(module), make_record(module)
    existing = make_edge(
        field,
        source if existing_side == "source" else make_record(module),
        target if existing_side == "target" else make_record(module),
    )
    db = Mock(spec=Session)
    with (
        patch(
            "app.systems.relationships.service._load_create_dependencies",
            return_value=(field, source, target),
        ),
        patch(
            "app.systems.relationships.service._find_active_edge",
            side_effect=[None, existing],
        ),
    ):
        with pytest.raises(RelationshipConflict):
            create_relationship(db, field.id, source.id, target.id)
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    "deleted_dependency",
    ["field", "source", "target", "source_module", "target_module"],
)
def test_visibility_contains_all_hidden_reasons_as_plural_archived_names(
    deleted_dependency: str,
) -> None:
    source_module = make_module(deleted=deleted_dependency == "source_module")
    target_module = make_module(
        department_id=source_module.department_id,
        deleted=deleted_dependency == "target_module",
    )
    field = make_relationship_field(
        source_module,
        target_module,
        deleted=deleted_dependency == "field",
    )
    source = make_record(source_module, deleted=deleted_dependency == "source")
    target = make_record(target_module, deleted=deleted_dependency == "target")
    edge = make_edge(field, source, target)
    response = relationship_response(edge)
    assert response.visibility == "hidden"
    assert len(response.hidden_reasons) == 1
    expected = {
        "field": "field_archived",
        "source": "source_record_archived",
        "target": "target_record_archived",
        "source_module": "source_module_archived",
        "target_module": "target_module_archived",
    }
    assert response.hidden_reasons[0].value == expected[deleted_dependency]


def test_visibility_reports_all_reasons_together() -> None:
    source_module = make_module(deleted=True)
    target_module = make_module(department_id=source_module.department_id, deleted=True)
    field = make_relationship_field(source_module, target_module, deleted=True)
    source = make_record(source_module, deleted=True)
    target = make_record(target_module, deleted=True)
    response = relationship_response(make_edge(field, source, target))
    assert {reason.value for reason in response.hidden_reasons} == {
        "field_archived",
        "source_record_archived",
        "target_record_archived",
        "source_module_archived",
        "target_module_archived",
    }


def test_unlink_allows_closed_target_but_requires_live_source_side() -> None:
    department_id = uuid7()
    module = make_module(department_id=department_id)
    target_module = make_module(department_id=department_id, deleted=True)
    field = make_relationship_field(module, target_module)
    source, target = make_record(module), make_record(target_module, deleted=True)
    edge = make_edge(field, source, target)
    db = Mock(spec=Session)
    db.get.return_value = edge
    unlink_relationship(db, edge.id)
    assert edge.is_deleted is True
    assert edge.deleted_at is not None
    db.commit.assert_called_once()


def test_unlink_rejects_closed_field_or_source_side() -> None:
    module = make_module()
    field = make_relationship_field(module, module, deleted=True)
    source, target = make_record(module), make_record(module)
    edge = make_edge(field, source, target)
    db = Mock(spec=Session)
    db.get.return_value = edge

    with pytest.raises(RelationshipConflict, match="Relationship field is not active"):
        unlink_relationship(db, edge.id)
    db.commit.assert_not_called()


def test_assignment_replaces_atomically_and_clear_soft_deletes_old_edge() -> None:
    module = make_module()
    field = make_relationship_field(module, module)
    source = make_record(module)
    old_target, new_target = make_record(module), make_record(module)
    old_edge = make_edge(field, source, old_target)
    db = Mock(spec=Session)
    clear_payload = RelationshipAssignment(target_record_id=None)
    assert clear_payload.target_record_id is None
    with (
        patch(
            "app.systems.relationships.service._find_active_edge",
            side_effect=[old_edge, old_edge, None],
        ),
        patch(
            "app.systems.relationships.service._lock_relationship_rows",
            return_value=locked_dependencies(field, source, new_target),
        ),
    ):
        replacement = assign_relationship(db, field.id, source.id, new_target.id)
        assert replacement is not None
        assert replacement.target_record_id == new_target.id
        assert old_edge.is_deleted is True
    with (
        patch(
            "app.systems.relationships.service._find_active_edge",
            return_value=replacement,
        ),
        patch(
            "app.systems.relationships.service._lock_relationship_rows",
            return_value=locked_dependencies(field, source, old_target),
        ),
    ):
        db.reset_mock()
        cleared = assign_relationship(db, field.id, source.id, None)

    assert cleared is None
    assert replacement.is_deleted is True
    db.commit.assert_called_once()


def test_assignment_clear_and_no_edge_reject_multi_target_fields() -> None:
    module = make_module()
    field = make_relationship_field(module, module, multiple_targets=True)
    source = make_record(module)
    db = Mock(spec=Session)
    with patch(
        "app.systems.relationships.service._lock_relationship_rows",
        return_value=locked_dependencies(field, source, None),
    ):
        with pytest.raises(RelationshipConflict, match="single-target"):
            assign_relationship(db, field.id, source.id, None)
    db.commit.assert_not_called()


def test_assignment_counts_target_side_edges_excluding_replaced_edge() -> None:
    module = make_module()
    field = make_relationship_field(module, module, multiple_sources=False)
    source, old_target, new_target = (make_record(module) for _ in range(3))
    current = make_edge(field, source, old_target)
    conflicting = make_edge(field, make_record(module), new_target)
    db = Mock(spec=Session)
    with (
        patch(
            "app.systems.relationships.service._find_active_edge",
            side_effect=[current, current, conflicting],
        ),
        patch(
            "app.systems.relationships.service._lock_relationship_rows",
            return_value=locked_dependencies(field, source, new_target),
        ),
    ):
        with pytest.raises(RelationshipConflict, match="already has"):
            assign_relationship(db, field.id, source.id, new_target.id)


def test_list_filters_before_count_and_pagination_and_returns_response_items() -> None:
    module = make_module()
    field = make_relationship_field(module, module)
    source, target = make_record(module), make_record(module)
    edge = make_edge(field, source, target)
    pagination = PaginationMetadata(limit=25, offset=0, count=1, total=1, has_more=False)
    with patch(
        "app.systems.relationships.service.execute_standard_list",
        return_value=ListQueryResult(items=[edge], pagination=pagination),
    ) as execute:
        result = list_relationships(
            Mock(spec=Session),
            RelationshipListRequest(
                field_id=field.id,
                source_record_id=source.id,
                target_record_id=target.id,
                incident_record_id=source.id,
                source_module_id=field.module_id,
                target_module_id=field.relationship_target_module_id,
                availability=RelationshipAvailability.ALL,
                deleted=DeletedFilter.INCLUDE,
            ),
        )
    assert result[0][0].id == edge.id
    execute.assert_called_once()
