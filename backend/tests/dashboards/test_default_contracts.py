from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy import ForeignKeyConstraint, UniqueConstraint
from uuid6 import uuid7

import app.systems.openview.dashboards.models as dashboard_models
import app.systems.openview.dashboards.schemas as dashboard_schemas
from app.systems.openview.dashboards.models import Dashboard


def test_dashboard_default_is_owner_scoped_and_removed_with_dashboard() -> None:
    default_model = getattr(dashboard_models, "DashboardDefault", None)
    assert default_model is not None, "DashboardDefault must exist"

    dashboard_table = Dashboard.__table__
    default_table = default_model.__table__

    owner_target = next(
        constraint
        for constraint in dashboard_table.constraints
        if isinstance(constraint, UniqueConstraint)
        and list(constraint.columns.keys()) == ["id", "owner_id"]
    )
    assert owner_target.name == "uq_dashboards_id_owner"

    owner_fk = next(
        constraint
        for constraint in default_table.constraints
        if isinstance(constraint, ForeignKeyConstraint)
        and constraint.name == "fk_dashboard_defaults_dashboard_owner"
    )
    assert list(owner_fk.columns.keys()) == ["dashboard_id", "user_id"]
    assert [element.target_fullname for element in owner_fk.elements] == [
        "dashboards.id",
        "dashboards.owner_id",
    ]
    assert owner_fk.ondelete == "CASCADE"

    assert any(
        isinstance(constraint, UniqueConstraint)
        and list(constraint.columns.keys()) == ["user_id"]
        for constraint in default_table.constraints
    )
    assert any(
        index.name == "ix_dashboard_defaults_dashboard_id"
        for index in default_table.indexes
    )


def test_dashboard_default_wire_contract_requires_explicit_nullable_uuid() -> None:
    default_set = getattr(dashboard_schemas, "DashboardDefaultSet", None)
    default_response = getattr(dashboard_schemas, "DashboardDefaultResponse", None)
    assert default_set is not None, "DashboardDefaultSet must exist"
    assert default_response is not None, "DashboardDefaultResponse must exist"

    dashboard_id = uuid7()

    assert default_set.model_validate({"dashboard_id": dashboard_id}).dashboard_id == dashboard_id
    string_id = str(dashboard_id)
    assert default_set.model_validate({"dashboard_id": string_id}).dashboard_id == dashboard_id
    assert default_set.model_validate({"dashboard_id": None}).dashboard_id is None
    assert default_response.model_validate({"dashboard_id": None}).dashboard_id is None
    response = default_response.model_validate({"dashboard_id": dashboard_id})
    assert response.dashboard_id == dashboard_id

    with pytest.raises(ValidationError):
        default_set.model_validate({})
    with pytest.raises(ValidationError):
        default_set.model_validate({"dashboard_id": str(UUID(int=0)), "extra": True})
    with pytest.raises(ValidationError):
        default_response.model_validate({})
    with pytest.raises(ValidationError):
        default_response.model_validate({"dashboard_id": "not-a-uuid"})
    with pytest.raises(ValidationError):
        default_response.model_validate({"dashboard_id": None, "extra": True})
