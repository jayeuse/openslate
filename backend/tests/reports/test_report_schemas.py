from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy.dialects.postgresql import JSONB
from uuid6 import uuid7

from app.systems.openview.reports.models import (
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.openview.reports.schemas import (
    ReportAudience,
    ReportCreate,
    ReportRecipe,
    ReportUpdate,
)
from app.systems.sandbox.fields.models import FieldType


def field_reference(field_id: UUID | None = None, kind: str = "text") -> dict[str, object]:
    return {"field_id": field_id or uuid7(), "expected_type": kind}


def test_report_recipe_preserves_order_and_query_intent() -> None:
    title = field_reference(kind="text")
    status = field_reference(kind="select")
    amount = field_reference(kind="decimal")
    recipe = ReportRecipe(
        fields=[title, status],
        filters=[{**status, "operator": "eq", "value": "Open"}],
        logic="or",
        sorts=[{**amount, "direction": "desc"}],
        group_by=status,
        include_row_count=True,
    )

    assert [item.field_id for item in recipe.fields] == [title["field_id"], status["field_id"]]
    assert recipe.logic == "or"
    assert recipe.sorts[0].direction.value == "desc"
    assert recipe.group_by is not None and recipe.group_by.field_id == status["field_id"]
    assert recipe.include_row_count is True
    serialized = recipe.model_dump(mode="json")
    assert serialized["version"] == 1
    assert serialized["fields"][0] == {
        "field_id": str(title["field_id"]),
        "expected_type": FieldType.TEXT.value,
    }


def test_report_recipe_requires_unique_selected_fields() -> None:
    reference = field_reference()

    with pytest.raises(ValidationError):
        ReportRecipe(fields=[])
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[reference, reference])
    with pytest.raises(ValidationError):
        ReportRecipe(
            fields=[reference],
            sorts=[
                {**reference, "direction": "asc"},
                {**reference, "direction": "desc"},
            ],
        )


def test_report_recipe_uses_bounded_query_field_filter_and_sort_counts() -> None:
    fields = [field_reference() for _ in range(100)]
    filters = [{**field_reference(), "operator": "eq", "value": "x"} for _ in range(11)]
    sorts = [field_reference() for _ in range(4)]

    assert len(ReportRecipe(fields=fields).fields) == 100
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[*fields, field_reference()])
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[field_reference()], filters=filters)
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[field_reference()], sorts=sorts)


def test_report_recipe_rejects_invalid_types_extras_and_non_boolean_total() -> None:
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[field_reference(kind="relationship")])
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[field_reference()], version=2)
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[field_reference()], include_row_count="true")
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[field_reference()], unexpected=True)
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[{"field_id": "not-a-uuid", "expected_type": "text"}])
    with pytest.raises(ValidationError):
        ReportRecipe(fields=[field_reference(kind="not-a-field-type")])


def test_report_create_trims_bounded_metadata_and_does_not_accept_owner_input() -> None:
    recipe = ReportRecipe(fields=[field_reference()])
    payload = ReportCreate(
        module_id=uuid7(),
        name="  Weekly operations  ",
        subtitle="  Open cases  ",
        recipe=recipe,
    )

    assert payload.name == "Weekly operations"
    assert payload.subtitle == "Open cases"
    assert payload.audience.kind == "private"
    with pytest.raises(ValidationError):
        ReportCreate(
            module_id=uuid7(),
            name="Private report",
            owner_id=uuid7(),
            recipe=recipe,
        )
    with pytest.raises(ValidationError):
        ReportCreate(module_id=uuid7(), name="x" * 81, recipe=recipe)
    with pytest.raises(ValidationError):
        ReportCreate(module_id=uuid7(), name="Valid", subtitle="x" * 161, recipe=recipe)


def test_report_audience_requires_exactly_the_matching_target() -> None:
    role_id, user_id = uuid7(), uuid7()
    assert ReportAudience(kind="role", role_id=role_id).role_id == role_id
    assert ReportAudience(kind="user", user_id=user_id).user_id == user_id
    for definition in (
        {"kind": "role"},
        {"kind": "user"},
        {"kind": "private", "user_id": user_id},
        {"kind": "everyone", "role_id": role_id},
        {"kind": "role", "role_id": role_id, "user_id": user_id},
        {"kind": "unknown"},
    ):
        with pytest.raises(ValidationError):
            ReportAudience.model_validate(definition)
    with pytest.raises(ValidationError):
        ReportUpdate(revision=1, audience=None)


def test_report_update_requires_revision_and_a_nonempty_valid_change() -> None:
    clear_subtitle = ReportUpdate(revision=3, subtitle=None)

    assert clear_subtitle.revision == 3
    assert clear_subtitle.model_fields_set == {"revision", "subtitle"}
    with pytest.raises(ValidationError):
        ReportUpdate(revision=3)
    with pytest.raises(ValidationError):
        ReportUpdate(revision=0, name="Updated")
    with pytest.raises(ValidationError):
        ReportUpdate(revision=3, name=None)


def test_report_update_accepts_source_switch_with_nonempty_recipe_contract() -> None:
    module_id = uuid7()
    switched = ReportUpdate(revision=4, module_id=module_id)

    assert switched.module_id == module_id
    assert switched.model_fields_set == {"revision", "module_id"}
    with pytest.raises(ValidationError):
        ReportUpdate(revision=4, module_id=None)
    with pytest.raises(ValidationError):
        ReportUpdate(revision=4, module_id=module_id, recipe={"fields": []})


def test_report_mapping_is_private_revisioned_and_module_scoped() -> None:
    columns = Report.__table__.columns
    assert isinstance(columns["recipe"].type, JSONB)
    assert columns["recipe"].nullable is False
    assert {foreign_key.target_fullname for foreign_key in columns["owner_id"].foreign_keys} == {
        "users.id"
    }
    assert {foreign_key.target_fullname for foreign_key in columns["module_id"].foreign_keys} == {
        "modules.id"
    }
    assert columns["revision"].nullable is False
    assert columns["subtitle"].nullable is True
    assert columns["audience_kind"].nullable is False
    assert columns["audience_kind"].server_default is not None
    assert str(columns["audience_kind"].server_default.arg) == "'private'"
    assert columns["audience_role_id"].nullable is True
    assert columns["audience_user_id"].nullable is True
    assert {key.target_fullname for key in columns["audience_role_id"].foreign_keys} == {"roles.id"}
    assert {key.ondelete for key in columns["audience_role_id"].foreign_keys} == {"RESTRICT"}
    assert {key.target_fullname for key in columns["audience_user_id"].foreign_keys} == {"users.id"}
    assert {key.ondelete for key in columns["audience_user_id"].foreign_keys} == {"RESTRICT"}
    assert not {"audience", "cadence", "timezone"}.intersection(columns.keys())
    assert Report.__audit_redacted_fields__ == frozenset({"recipe"})


def test_report_run_mapping_freezes_output_and_restricts_source_purge() -> None:
    run_columns = ReportRun.__table__.columns
    row_columns = ReportRunRow.__table__.columns

    assert {key for key in ("recipe", "headings", "csv_bytes", "row_count")} <= set(
        run_columns.keys()
    )
    assert all(
        not run_columns[key].nullable
        for key in ("report_id", "module_id", "idempotency_key", "recipe_revision")
    )
    assert ReportRun.__audit_redacted_fields__ == frozenset({"recipe", "headings", "csv_bytes"})
    assert ReportRunRow.__audit_redacted_fields__ == frozenset({"cells"})
    assert not row_columns["record_id"].nullable
    assert {key.target_fullname for key in row_columns["record_id"].foreign_keys} == {"records.id"}
    assert {key.ondelete for key in row_columns["record_id"].foreign_keys} == {"RESTRICT"}
    assert {key.target_fullname for key in run_columns["report_id"].foreign_keys} == {"reports.id"}
    assert {key.ondelete for key in run_columns["report_id"].foreign_keys} == {"RESTRICT"}


def test_report_run_eligible_user_mapping_is_immutable_and_restrictive() -> None:
    table = ReportRunEligibleUser.__table__
    assert set(table.columns.keys()) == {"run_id", "user_id"}
    assert {column.name for column in table.primary_key.columns} == {"run_id", "user_id"}
    assert {key.target_fullname for key in table.columns["run_id"].foreign_keys} == {
        "report_runs.id"
    }
    assert {key.target_fullname for key in table.columns["user_id"].foreign_keys} == {"users.id"}
    assert all(
        key.ondelete == "RESTRICT" for column in table.columns for key in column.foreign_keys
    )
    assert ReportRunEligibleUser.__audit_enabled__ is False
    assert any(
        tuple(column.name for column in index.columns) == ("user_id", "run_id")
        for index in table.indexes
    )
