import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

from app.systems.openview.views.router import _validate_presentation
from app.systems.openview.views.schemas import ViewPresentation
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.query_schemas import FieldReference, QueryDefinition


def _field(field_id, module_id, field_type, *, deleted=False):
    return Field(
        id=field_id,
        module_id=module_id,
        name=f"Field {field_id}",
        type=field_type,
        required=False,
        position=0,
        config={},
        is_deleted=deleted,
    )


def _definition(fields):
    return QueryDefinition(
        columns=[FieldReference(field_id=item.id, expected_type=item.type) for item in fields]
    )


class _FieldRows:
    def __init__(self, fields):
        self.fields = fields

    def all(self):
        return self.fields


class _FieldSession:
    def __init__(self, fields):
        self.fields = fields
        self.statements = []

    def scalars(self, statement):
        self.statements.append(statement)
        return _FieldRows(self.fields)


def test_old_non_timeline_presentation_accepts_missing_timeline_keys():
    presentation = ViewPresentation.model_validate(
        {
            "version": 1,
            "layout": "table",
            "column_field_ids": [],
            "pinned_field_ids": [],
        }
    )

    assert presentation.timeline_start_field_id is None
    assert presentation.timeline_end_field_id is None
    assert presentation.timeline_deadline_field_id is None
    assert presentation.timeline_progress_field_id is None


@pytest.mark.parametrize(
    ("start_field_id", "end_field_id"),
    [(None, uuid7()), (uuid7(), None)],
)
def test_timeline_requires_both_interval_bounds(start_field_id, end_field_id):
    presentation = ViewPresentation(
        layout="timeline",
        timeline_start_field_id=start_field_id,
        timeline_end_field_id=end_field_id,
    )

    with pytest.raises(HTTPException) as error:
        _validate_presentation(
            _FieldSession([]),  # type: ignore[arg-type]
            uuid7(),
            presentation,
            QueryDefinition(),
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "view_invalid"


def test_timeline_accepts_mixed_date_types_and_optional_deadline_progress():
    module_id = uuid7()
    fields = [
        _field(uuid7(), module_id, FieldType.DATE),
        _field(uuid7(), module_id, FieldType.DATETIME),
        _field(uuid7(), module_id, FieldType.DATE),
        _field(uuid7(), module_id, FieldType.DECIMAL),
    ]
    presentation = ViewPresentation(
        layout="timeline",
        timeline_start_field_id=fields[0].id,
        timeline_end_field_id=fields[1].id,
        timeline_deadline_field_id=fields[2].id,
        timeline_progress_field_id=fields[3].id,
    )
    session = _FieldSession(fields)

    _validate_presentation(
        session,  # type: ignore[arg-type]
        module_id,
        presentation,
        _definition(fields),
    )

    assert len(session.statements) == 1
    compiled = str(session.statements[0].compile(dialect=postgresql.dialect()))
    assert "fields.module_id =" in compiled


def test_timeline_bounds_are_valid_without_optional_deadline_or_progress():
    module_id = uuid7()
    fields = [
        _field(uuid7(), module_id, FieldType.DATE),
        _field(uuid7(), module_id, FieldType.DATETIME),
    ]
    presentation = ViewPresentation(
        layout="timeline",
        timeline_start_field_id=fields[0].id,
        timeline_end_field_id=fields[1].id,
    )

    _validate_presentation(
        _FieldSession(fields),  # type: ignore[arg-type]
        module_id,
        presentation,
        _definition(fields),
    )


@pytest.mark.parametrize(
    ("role", "invalid_type"),
    [
        ("timeline_start_field_id", FieldType.TEXT),
        ("timeline_end_field_id", FieldType.BOOLEAN),
        ("timeline_deadline_field_id", FieldType.SELECT),
        ("timeline_progress_field_id", FieldType.DATE),
    ],
)
def test_timeline_roles_reject_incompatible_field_types(role, invalid_type):
    module_id = uuid7()
    fields = [
        _field(uuid7(), module_id, FieldType.DATE),
        _field(uuid7(), module_id, FieldType.DATETIME),
        _field(uuid7(), module_id, FieldType.DATE),
        _field(uuid7(), module_id, FieldType.DECIMAL),
    ]
    presentation = ViewPresentation(
        layout="timeline",
        timeline_start_field_id=fields[0].id,
        timeline_end_field_id=fields[1].id,
        timeline_deadline_field_id=fields[2].id,
        timeline_progress_field_id=fields[3].id,
    )
    role_field_id = getattr(presentation, role)
    fields = [
        _field(item.id, module_id, invalid_type if item.id == role_field_id else item.type)
        for item in fields
    ]

    with pytest.raises(HTTPException) as error:
        _validate_presentation(
            _FieldSession(fields),  # type: ignore[arg-type]
            module_id,
            presentation,
            _definition(fields),
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "view_invalid"


def test_timeline_rejects_presentation_fields_missing_from_query_columns():
    module_id = uuid7()
    start = _field(uuid7(), module_id, FieldType.DATE)
    end = _field(uuid7(), module_id, FieldType.DATETIME)
    presentation = ViewPresentation(
        layout="timeline",
        timeline_start_field_id=start.id,
        timeline_end_field_id=end.id,
    )

    with pytest.raises(HTTPException) as error:
        _validate_presentation(
            _FieldSession([start, end]),  # type: ignore[arg-type]
            module_id,
            presentation,
            _definition([start]),
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "view_invalid"


def test_timeline_rejects_a_deleted_role_field():
    module_id = uuid7()
    start = _field(uuid7(), module_id, FieldType.DATE, deleted=True)
    end = _field(uuid7(), module_id, FieldType.DATETIME)
    fields = [start, end]
    presentation = ViewPresentation(
        layout="timeline",
        timeline_start_field_id=start.id,
        timeline_end_field_id=end.id,
    )

    with pytest.raises(HTTPException) as error:
        _validate_presentation(
            _FieldSession(fields),  # type: ignore[arg-type]
            module_id,
            presentation,
            _definition(fields),
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "view_invalid"


def test_name_only_noop_preserves_legacy_presentation_without_timeline_keys(monkeypatch):
    from datetime import UTC, datetime
    from unittest.mock import Mock

    import app.systems.openview.views.router as views_router
    from app.systems.access.users.models import Role, User
    from app.systems.openview.views.models import AudienceKind, SavedView
    from app.systems.openview.views.router import update_view
    from app.systems.openview.views.schemas import ViewUpdate

    user_id = uuid7()
    module_id = uuid7()
    legacy_presentation = ViewPresentation().model_dump(mode="json")
    for key in (
        "timeline_start_field_id",
        "timeline_end_field_id",
        "timeline_deadline_field_id",
        "timeline_progress_field_id",
    ):
        legacy_presentation.pop(key)
    now = datetime.now(UTC)
    view = SavedView(
        id=uuid7(),
        module_id=module_id,
        owner_id=user_id,
        name="Legacy",
        visibility="private",
        audience_kind=AudienceKind.PRIVATE,
        revision=1,
        definition=QueryDefinition().model_dump(mode="json"),
        presentation=legacy_presentation.copy(),
        is_deleted=False,
        deleted_at=None,
        created_at=now,
        updated_at=now,
    )
    user = User(
        id=user_id,
        status="active",
        role=Role(
            role="member",
            permissions={"records.write": True},
            is_deleted=False,
        ),
        role_id=uuid7(),
        is_deleted=False,
    )
    database = Mock()

    monkeypatch.setattr(views_router, "get_view", lambda *_args, **_kwargs: view)
    monkeypatch.setattr(views_router, "_active_module", lambda *_args: None)
    monkeypatch.setattr(views_router, "_validate_definition", lambda *_args: None)
    monkeypatch.setattr(views_router, "_validate_presentation", lambda *_args: None)
    save = Mock()
    monkeypatch.setattr(views_router, "commit", save)

    result = update_view(
        view.id,
        ViewUpdate(revision=1, name="Legacy"),
        user,
        database,
    )

    assert result.revision == 1
    assert view.presentation == legacy_presentation
    save.assert_not_called()
    database.refresh.assert_not_called()
