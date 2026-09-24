import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError
from sqlalchemy import UniqueConstraint
from uuid6 import uuid7

from app.systems.access.users.models import Role, User
from app.systems.manage.audit.snapshots import REDACTED, build_update_snapshot
from app.systems.openview.views.models import AudienceKind, SavedView, SavedViewDefault
from app.systems.openview.views.router import router as views_router
from app.systems.openview.views.schemas import (
    ViewAudience,
    ViewCreate,
    ViewPresentation,
)
from app.systems.platform.events.models import event_for_entity
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.query_schemas import FieldReference, QueryDefinition


def test_legacy_workspace_visibility_resolves_to_everyone_audience() -> None:
    payload = ViewCreate(
        module_id=uuid7(),
        name="Workspace view",
        visibility="workspace",
        definition=QueryDefinition(),
    )

    assert payload.audience == ViewAudience(kind="everyone")
    assert payload.visibility == "workspace"


def test_legacy_orm_visibility_default_preserves_workspace_sharing() -> None:
    from types import SimpleNamespace

    audience_default = SavedView.__table__.c.audience_kind.default.arg
    assert callable(audience_default)
    context = SimpleNamespace(
        get_current_parameters=lambda: {"visibility": "workspace"}
    )

    assert audience_default(context) == AudienceKind.EVERYONE


def test_view_creation_rejects_audience_visibility_disagreement() -> None:
    with pytest.raises(ValidationError):
        ViewCreate(
            module_id=uuid7(),
            name="Private view",
            audience=ViewAudience(kind="private"),
            visibility="workspace",
            definition=QueryDefinition(),
        )


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


@pytest.mark.parametrize("kind", ["role", "user"])
def test_audience_target_validation_locks_rows_to_serialize_invalidation(kind: str) -> None:
    from app.systems.openview.views.router import _validate_audience

    target_id = uuid7()
    audience = ViewAudience(kind=kind, role_id=target_id if kind == "role" else None,
                            user_id=target_id if kind == "user" else None)
    statements: list[object] = []

    class TargetSession:
        def scalar(self, statement: object) -> object:
            statements.append(statement)
            return target_id

    _validate_audience(TargetSession(), audience)  # type: ignore[arg-type]
    assert len(statements) == 1
    assert statements[0]._for_update_arg is not None  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    ("owner", "write_permission", "expected"),
    [(True, False, False), (True, True, True), (False, True, False)],
)
def test_can_edit_requires_ownership_and_effective_records_write(
    owner: bool, write_permission: bool, expected: bool
) -> None:
    from datetime import UTC, datetime
    from types import SimpleNamespace

    from app.systems.openview.views.router import _view_response

    user_id = uuid7()
    user = User(
        id=user_id,
        status="active",
        role=Role(
            role="member",
            permissions={"records.read": True, "records.write": write_permission},
            is_deleted=False,
        ),
        role_id=uuid7(),
        is_deleted=False,
    )
    view = SimpleNamespace(
        id=uuid7(),
        module_id=uuid7(),
        owner_id=user_id if owner else uuid7(),
        name="View",
        visibility="private",
        audience_kind=AudienceKind.PRIVATE,
        audience_role_id=None,
        audience_user_id=None,
        definition=QueryDefinition().model_dump(mode="json"),
        presentation={"version": 1},
        revision=1,
        is_deleted=False,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )

    assert _view_response(view, user).can_edit is expected


def test_saved_view_lifecycle_scope_deletes_default_rows_before_parent_views() -> None:
    from datetime import UTC, datetime
    from types import SimpleNamespace

    from app.systems.sandbox.lifecycle.execution import _LOCK_MODELS, _purge_instances
    from app.systems.sandbox.lifecycle.schemas import LifecycleRowState

    view_id, default_id = uuid7(), uuid7()
    view = SavedView(id=view_id)
    default = SavedViewDefault(id=default_id)
    deleted: list[object] = []

    class PurgeSession:
        def get(self, model, object_id):
            if model is SavedViewDefault and object_id == default_id:
                return default
            if model is SavedView and object_id == view_id:
                return view
            return None

        def delete(self, instance):
            deleted.append(instance)

        def flush(self):
            pass

    timestamp = datetime.now(UTC)
    plan = SimpleNamespace(
        scope_ids={"relationship_edges": ()},
        key_strips=(),
        rows=[
            LifecycleRowState(
                entity_type="saved_view_defaults",
                entity_id=default_id,
                is_deleted=False,
                deleted_at=None,
                updated_at=timestamp,
            ),
            LifecycleRowState(
                entity_type="saved_views",
                entity_id=view_id,
                is_deleted=False,
                deleted_at=None,
                updated_at=timestamp,
            ),
        ],
    )
    _purge_instances(PurgeSession(), plan)  # type: ignore[arg-type]

    assert deleted == [default, view]
    lock_order = [key for key, _model in _LOCK_MODELS]
    assert lock_order.index("saved_views") < lock_order.index("saved_view_defaults")


def test_default_mapping_keeps_module_scope_and_cascades_with_view_delete() -> None:
    from app.systems.openview.views.models import SavedViewDefault

    view_module_fk = next(
        constraint
        for constraint in SavedViewDefault.__table__.foreign_key_constraints
        if constraint.name == "fk_saved_view_defaults_view_module"
    )
    user_module_unique = next(
        constraint
        for constraint in SavedViewDefault.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
        and constraint.name == "uq_saved_view_defaults_user_module"
    )

    assert [column.name for column in view_module_fk.columns] == ["view_id", "module_id"]
    assert [element.target_fullname for element in view_module_fk.elements] == [
        "saved_views.id",
        "saved_views.module_id",
    ]
    assert view_module_fk.ondelete == "CASCADE"
    assert [column.name for column in user_module_unique.columns] == ["user_id", "module_id"]


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


def test_saved_view_default_invalidation_omits_row_ids_and_requires_records_read() -> None:
    event = event_for_entity("saved_view_defaults", uuid7())

    assert event.to_payload() == {
        "entity": "saved_view_defaults",
        "capability": "records.read",
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


def test_admin_who_can_read_a_shared_view_still_cannot_mutate_it() -> None:
    from types import SimpleNamespace

    from app.systems.openview.views.router import get_view

    view = SimpleNamespace(id=uuid7(), owner_id=uuid7())
    user = User(
        id=uuid7(),
        status="active",
        role=Role(role="admin", is_deleted=False),
        role_id=uuid7(),
        is_deleted=False,
    )

    class ViewResultSession:
        def scalar(self, _statement: object) -> object:
            return view

    with pytest.raises(HTTPException) as error:
        get_view(ViewResultSession(), user, view.id, write=True)  # type: ignore[arg-type]

    assert error.value.status_code == 403


def test_stale_saved_view_conflict_includes_current_revision() -> None:
    from types import SimpleNamespace

    from app.systems.openview.views.router import update_view
    from app.systems.openview.views.schemas import ViewUpdate

    user_id = uuid7()
    view = SimpleNamespace(
        id=uuid7(),
        owner_id=user_id,
        module_id=uuid7(),
        revision=9,
        is_deleted=False,
    )
    user = User(
        id=user_id,
        status="active",
        role=Role(role="member", is_deleted=False),
        role_id=uuid7(),
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
