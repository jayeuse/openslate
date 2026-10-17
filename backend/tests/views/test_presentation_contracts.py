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


_COLUMNS = "Presentation fields must be included in query columns"
_UNAVAILABLE = "A presentation field is unavailable"
_CALENDAR = "Calendar presentation requires a date or datetime field"
_BOUNDS = "Timeline presentation requires start and end fields"
_INTERVAL = "Timeline interval roles must be date or datetime fields"
_PROGRESS = "Timeline progress must use a numeric field"
_TIMELINE = {
    "layout": "timeline",
    "timeline_start_field_id": "start",
    "timeline_end_field_id": "end",
    "timeline_deadline_field_id": "deadline",
    "timeline_progress_field_id": "progress",
}
_TIMELINE_FIELDS = {
    "start": FieldType.DATE,
    "end": FieldType.DATETIME,
    "deadline": FieldType.DATE,
    "progress": FieldType.DECIMAL,
}
_INTERVAL_ONLY = {
    "layout": "timeline",
    "timeline_start_field_id": "start",
    "timeline_end_field_id": "end",
}


# Each row: the presentation (field roles by name), the module fields the session returns
# (a type, or a type and True for a deleted field), the query columns, the refusal message,
# and whether the check reads the module fields at all.
@pytest.mark.parametrize(
    ("presentation", "fields", "columns", "message", "queried"),
    [
        pytest.param(
            {"column_field_ids": ["primary"], "primary_field_id": "primary"},
            {},
            [],
            _COLUMNS,
            False,
            id="primary field outside the query columns",
        ),
        pytest.param(
            {"column_field_ids": ["primary"], "primary_field_id": "primary"},
            {"primary": (FieldType.TEXT, True)},
            ["primary"],
            _UNAVAILABLE,
            True,
            id="deleted primary field",
        ),
        pytest.param(
            {"column_field_ids": ["primary"], "date_field_id": "primary"},
            {"primary": FieldType.TEXT},
            ["primary"],
            _CALENDAR,
            True,
            id="calendar on a text field",
        ),
        pytest.param(
            {"layout": "timeline", "timeline_end_field_id": "end"},
            {},
            [],
            _BOUNDS,
            False,
            id="timeline without a start",
        ),
        pytest.param(
            {"layout": "timeline", "timeline_start_field_id": "start"},
            {},
            [],
            _BOUNDS,
            False,
            id="timeline without an end",
        ),
        pytest.param(
            _TIMELINE,
            _TIMELINE_FIELDS | {"start": FieldType.TEXT},
            list(_TIMELINE_FIELDS),
            _INTERVAL,
            True,
            id="text timeline start",
        ),
        pytest.param(
            _TIMELINE,
            _TIMELINE_FIELDS | {"end": FieldType.BOOLEAN},
            list(_TIMELINE_FIELDS),
            _INTERVAL,
            True,
            id="boolean timeline end",
        ),
        pytest.param(
            _TIMELINE,
            _TIMELINE_FIELDS | {"deadline": FieldType.SELECT},
            list(_TIMELINE_FIELDS),
            _INTERVAL,
            True,
            id="select timeline deadline",
        ),
        pytest.param(
            _TIMELINE,
            _TIMELINE_FIELDS | {"progress": FieldType.DATE},
            list(_TIMELINE_FIELDS),
            _PROGRESS,
            True,
            id="date timeline progress",
        ),
        pytest.param(
            _INTERVAL_ONLY,
            {"start": FieldType.DATE, "end": FieldType.DATETIME},
            ["start"],
            _COLUMNS,
            False,
            id="timeline end outside the query columns",
        ),
        pytest.param(
            _INTERVAL_ONLY,
            {"start": (FieldType.DATE, True), "end": FieldType.DATETIME},
            ["start", "end"],
            _UNAVAILABLE,
            True,
            id="deleted timeline start",
        ),
    ],
)
def test_presentation_refuses_fields_it_cannot_show(
    presentation, fields, columns, message, queried
):
    module_id = uuid7()
    ids = {role: uuid7() for role in ("primary", "start", "end", "deadline", "progress")}
    settings = {
        name: [ids[role] for role in value] if isinstance(value, list) else ids.get(value, value)
        for name, value in presentation.items()
    }
    rows = [
        _field(ids[role], module_id, spec[0], deleted=spec[1])
        if isinstance(spec, tuple)
        else _field(ids[role], module_id, spec)
        for role, spec in fields.items()
    ]
    types = {row.id: row.type for row in rows}
    definition = QueryDefinition(
        columns=[
            FieldReference(field_id=ids[role], expected_type=types[ids[role]]) for role in columns
        ]
    )
    session = _FieldSession(rows)

    with pytest.raises(HTTPException) as error:
        _validate_presentation(
            session,  # type: ignore[arg-type]  # a stub with only scalars()
            module_id,
            ViewPresentation(**settings),
            definition,
        )

    assert error.value.status_code == 409
    assert error.value.detail == {"code": "view_invalid", "message": message}
    assert bool(session.statements) is queried


def test_name_only_noop_preserves_legacy_presentation_without_timeline_keys(monkeypatch):
    from datetime import UTC, datetime
    from unittest.mock import Mock

    import app.systems.openview.views.router as views_router
    from app.systems.access.users.models import User
    from app.systems.openview.views.models import SavedView
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
        name="Legacy",
        is_default=False,
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
        is_deleted=False,
    )
    database = Mock()

    monkeypatch.setattr(views_router, "get_view", lambda *_args, **_kwargs: view)
    monkeypatch.setattr(views_router, "require_module_access", lambda *_args: None)
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
