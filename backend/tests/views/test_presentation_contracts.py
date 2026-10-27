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


def test_valid_presentation_reads_its_fields_once_from_the_view_module():
    module_id = uuid7()
    fields = [
        _field(uuid7(), module_id, FieldType.TEXT),
        _field(uuid7(), module_id, FieldType.SELECT),
        _field(uuid7(), module_id, FieldType.DATE),
    ]
    presentation = ViewPresentation(
        layout="grid",
        column_field_ids=[fields[0].id],
        primary_field_id=fields[0].id,
        secondary_field_id=fields[1].id,
        group_by_field_id=fields[2].id,
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


_COLUMNS = "Presentation fields must be included in query columns"
_UNAVAILABLE = "A presentation field is unavailable"


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
    ],
)
def test_presentation_refuses_fields_it_cannot_show(
    presentation, fields, columns, message, queried
):
    module_id = uuid7()
    ids = {"primary": uuid7()}
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


def test_name_only_noop_preserves_legacy_presentation_without_newer_keys(monkeypatch):
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
    for key in ("secondary_field_id", "group_by_field_id"):
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
