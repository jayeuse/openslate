import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import EffectiveAccess
from app.systems.access.users.models import User
from app.systems.manage.audit.snapshots import REDACTED, build_update_snapshot
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.router import router as views_router
from app.systems.openview.views.schemas import ViewPresentation
from app.systems.platform.events.models import event_for_entity
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.query_schemas import FieldReference, QueryDefinition


def test_presentation_uses_bounded_field_id_wire_projection() -> None:
    field_id = uuid7()
    presentation = ViewPresentation.model_validate(
        {
            "version": 1,
            "layout": "table",
            "column_field_ids": [str(field_id)],
            "pinned_field_ids": [str(field_id)],
            "density": "compact",
            "wrap": True,
            "card_size": "comfortable",
            "primary_field_id": str(field_id),
            "secondary_field_id": None,
            "date_field_id": None,
            "date_range": "quarter",
            "scale": None,
            "group_by_field_id": None,
        }
    )

    assert presentation.model_dump(mode="json") == {
        "version": 1,
        "layout": "table",
        "column_field_ids": [str(field_id)],
        "pinned_field_ids": [str(field_id)],
        "density": "compact",
        "wrap": True,
        "card_size": "comfortable",
        "primary_field_id": str(field_id),
        "secondary_field_id": None,
        "date_field_id": None,
        "timeline_start_field_id": None,
        "timeline_end_field_id": None,
        "timeline_deadline_field_id": None,
        "timeline_progress_field_id": None,
        "date_range": "quarter",
        "scale": None,
        "group_by_field_id": None,
    }


def test_presentation_rejects_more_than_one_pinned_field() -> None:
    with pytest.raises(ValidationError):
        ViewPresentation(pinned_field_ids=[uuid7(), uuid7()])


def test_presentation_dependencies_must_be_query_columns_and_active_fields() -> None:
    from fastapi import HTTPException

    from app.systems.openview.views.router import _validate_presentation

    module_id, field_id = uuid7(), uuid7()
    presentation = ViewPresentation(column_field_ids=[field_id], primary_field_id=field_id)
    with pytest.raises(HTTPException) as missing_column:
        _validate_presentation(
            object(),  # type: ignore[arg-type]
            module_id,
            presentation,
            QueryDefinition(),
        )
    assert missing_column.value.status_code == 409

    class FieldRows:
        def all(self) -> list[Field]:
            return [
                Field(
                    id=field_id,
                    module_id=module_id,
                    name="Primary",
                    type=FieldType.TEXT,
                    required=False,
                    position=0,
                    config={},
                    is_deleted=True,
                )
            ]

    class FieldSession:
        def scalars(self, _statement: object) -> FieldRows:
            return FieldRows()

    with pytest.raises(HTTPException) as stale_field:
        _validate_presentation(
            FieldSession(),  # type: ignore[arg-type]
            module_id,
            presentation,
            QueryDefinition(columns=[FieldReference(field_id=field_id, expected_type="text")]),
        )
    assert stale_field.value.status_code == 409


def test_calendar_presentation_requires_a_live_date_or_datetime_query_column() -> None:
    from fastapi import HTTPException

    from app.systems.openview.views.router import _validate_presentation

    module_id, field_id = uuid7(), uuid7()
    date_field = Field(
        id=field_id,
        module_id=module_id,
        name="Start date",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
        is_deleted=False,
    )

    class FieldRows:
        def all(self) -> list[Field]:
            return [date_field]

    class FieldSession:
        def scalars(self, _statement: object) -> FieldRows:
            return FieldRows()

    definition = QueryDefinition(
        columns=[FieldReference(field_id=field_id, expected_type=FieldType.TEXT)]
    )
    with pytest.raises(HTTPException) as error:
        _validate_presentation(
            FieldSession(),  # type: ignore[arg-type]
            module_id,
            ViewPresentation(column_field_ids=[field_id], date_field_id=field_id),
            definition,
        )
    assert error.value.status_code == 409


@pytest.mark.parametrize(
    ("access", "expected"),
    [
        (EffectiveAccess(unrestricted=True), True),
        ("manage", True),
        ("write", False),
        ("read", False),
        (None, False),
    ],
)
def test_can_edit_requires_manage_on_the_view_module(
    access: EffectiveAccess | str | None, expected: bool
) -> None:
    from types import SimpleNamespace

    from app.systems.openview.views.router import _can_edit

    module_id = uuid7()
    if not isinstance(access, EffectiveAccess):
        access = EffectiveAccess(
            modules={} if access is None else {module_id: AccessLevel(access)},
        )
    view = SimpleNamespace(module_id=module_id)

    assert _can_edit(access, view) is expected  # type: ignore[arg-type]


def test_one_active_default_view_per_module_is_a_partial_unique_index() -> None:
    index = next(
        index
        for index in SavedView.__table__.indexes
        if index.name == "uq_saved_views_module_default"
    )

    assert index.unique is True
    assert [column.name for column in index.columns] == ["module_id"]
    assert str(index.dialect_options["postgresql"]["where"]) == "is_default AND NOT is_deleted"
    assert {"owner_id", "visibility", "audience_kind", "audience_user_id"}.isdisjoint(
        SavedView.__table__.c.keys()
    )


def test_saved_view_changes_keep_definitions_and_layouts_out_of_audit_snapshots() -> None:
    snapshot = build_update_snapshot(
        {
            "definition": ({"filters": []}, {"filters": [{"value": "private"}]}),
            "presentation": ({"layout": "table"}, {"layout": "calendar"}),
        },
        SavedView.__audit_redacted_fields__,
    )

    assert snapshot == {
        "before": {"definition": REDACTED, "presentation": REDACTED},
        "after": {"definition": REDACTED, "presentation": REDACTED},
    }


def test_saved_view_invalidation_omits_row_ids_and_carries_its_module() -> None:
    module_id = uuid7()
    event = event_for_entity("saved_views", uuid7(), module_id=module_id)

    assert event is not None
    assert event.to_payload() == {
        "entity": "saved_views",
        "module_id": str(module_id),
    }


def test_saved_view_routes_require_revision_for_archive_and_restore() -> None:
    app = FastAPI()
    app.include_router(views_router, prefix="/api")
    paths = app.openapi()["paths"]

    delete_parameters = paths["/api/views/{view_id}"]["delete"]["parameters"]
    revision_parameter = next(
        parameter for parameter in delete_parameters if parameter["name"] == "revision"
    )

    assert revision_parameter["in"] == "query"
    assert revision_parameter["required"] is True
    assert paths["/api/views/{view_id}/restore"]["post"]["requestBody"]["required"] is True


def test_stale_saved_view_conflict_includes_current_revision() -> None:
    from types import SimpleNamespace

    from app.systems.openview.views.router import update_view
    from app.systems.openview.views.schemas import ViewUpdate

    user_id = uuid7()
    view = SimpleNamespace(
        id=uuid7(),
        module_id=uuid7(),
        revision=9,
        is_deleted=False,
    )
    # An administrator needs no database lookup for the module level.
    user = User(
        id=user_id,
        status="active",
        role="admin",
        is_deleted=False,
    )

    class ViewResultSession:
        def scalar(self, _statement: object) -> object:
            return view

    with pytest.raises(HTTPException) as error:
        update_view(
            view.id,
            ViewUpdate(revision=7, name="Stale"),
            user,
            ViewResultSession(),  # type: ignore[arg-type]
        )

    assert error.value.status_code == 409
    assert error.value.detail == {
        "code": "stale_revision",
        "message": "View changed; reload before saving",
        "current_revision": 9,
    }
