from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import EffectiveAccess
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.snapshots import REDACTED, build_update_snapshot
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.schemas import ViewCreate, ViewPresentation, ViewUpdate
from app.systems.platform.events.models import event_for_entity
from tests.rbac.support import make_user


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
    user, membership = make_user("view-admin")
    user.id = user_id
    membership.user_id = user_id

    class ViewResultSession:
        dirty = set()
        def scalars(self, _statement):
            return SimpleNamespace(all=lambda: [membership])
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


def test_view_mutation_rejects_owner_audience_and_empty_patch():
    for extra in ({"owner_id": uuid7()}, {"visibility": "workspace"}, {"audience": {}}):
        with pytest.raises(ValidationError):
            ViewCreate.model_validate(
                {"module_id": uuid7(), "name": "Shared", "definition": {}, **extra}
            )
    assert ViewUpdate(revision=1, is_default=True).is_default is True
    with pytest.raises(ValidationError):
        ViewUpdate(revision=1)
    with pytest.raises(ValidationError):
        ViewUpdate.model_validate({"revision": 1, "visibility": "workspace"})


def _admin() -> tuple[User, Membership]:
    # An administrator needs no database lookup for the module level.
    return make_user("view-admin")


class _NoRowSession:
    def __init__(self, membership=None):
        self.dirty = set()
        self.membership = membership

    def scalars(self, _statement):
        return SimpleNamespace(all=lambda: [self.membership])

    def scalar(self, _statement: object) -> None:
        return None


def test_missing_or_hidden_view_reads_as_not_found() -> None:
    from app.systems.openview.views.router import read_view

    admin, membership = _admin()
    with pytest.raises(HTTPException) as error:
        read_view(uuid7(), admin, _NoRowSession(membership))

    assert error.value.status_code == 404
    assert error.value.detail == "View not found"


def test_view_change_on_an_unavailable_module_is_refused() -> None:
    from app.systems.openview.views.router import _active_module

    with pytest.raises(HTTPException) as error:
        _active_module(_NoRowSession(), uuid7())

    assert error.value.status_code == 409
    assert error.value.detail == {"code": "view_invalid", "message": "The module is unavailable"}


def test_constraint_failure_on_save_rolls_back_and_reports_view_invalid() -> None:
    from sqlalchemy.exc import IntegrityError

    from app.systems.openview.views.router import commit

    class RefusingSession:
        rolled_back = False

        def commit(self) -> None:
            raise IntegrityError("INSERT", {}, Exception("uq_saved_views_module_default"))

        def rollback(self) -> None:
            self.rolled_back = True

    session = RefusingSession()
    with pytest.raises(HTTPException) as error:
        commit(session)

    assert session.rolled_back is True
    assert error.value.status_code == 409
    assert error.value.detail == {"code": "view_invalid", "message": "Unable to save view"}


@pytest.mark.parametrize(
    ("column_deleted", "refused"),
    [
        pytest.param(False, False, id="every referenced field is active"),
        pytest.param(True, True, id="a query column names a deleted field"),
    ],
)
def test_saved_view_definition_refuses_a_deleted_field(column_deleted: bool, refused: bool) -> None:
    from app.systems.openview.views.router import _validate_definition
    from app.systems.sandbox.fields.models import Field, FieldType
    from app.systems.sandbox.modules.models import Module
    from app.systems.sandbox.records.query_schemas import FieldReference, QueryDefinition

    module = Module(id=uuid7())
    active = Field(id=uuid7(), module_id=module.id, type=FieldType.TEXT, is_deleted=False)
    column = Field(id=uuid7(), module_id=module.id, type=FieldType.TEXT, is_deleted=column_deleted)

    class ModuleFieldSession:
        dirty = set()
        def get(self, model: type, ident: object) -> object:
            return module if model is Module and ident == module.id else None

        def scalars(self, _statement: object) -> list[Field]:
            if _statement.column_descriptions[0]["entity"] is Membership:
                return SimpleNamespace(all=lambda: [membership])
            return [active, column]

    definition = QueryDefinition(
        columns=[FieldReference(field_id=column.id, expected_type="text")],
        sort=[{"field_id": active.id, "expected_type": "text", "direction": "asc"}],
    )

    session = ModuleFieldSession()
    admin, membership = _admin()
    if not refused:
        _validate_definition(session, admin, module.id, definition)
        return
    with pytest.raises(HTTPException) as error:
        _validate_definition(session, admin, module.id, definition)
    assert error.value.status_code == 409
    assert error.value.detail == {
        "code": "view_invalid",
        "message": "A referenced field is no longer active",
    }
