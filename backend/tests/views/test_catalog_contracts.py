import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

from app.common.listing import StandardListRequest
from app.common.listing.schemas import PaginationMetadata
from app.systems.access.users.models import User
from app.systems.openview.views.catalog import (
    DataSourceSort,
    FieldSort,
    list_data_source_fields,
    list_data_sources,
)
from app.systems.openview.views.schemas import ViewDataSourceResponse, ViewFieldResponse
from app.systems.sandbox.fields.models import Field, FieldType


def test_saved_view_catalog_responses_keep_their_wire_fields() -> None:
    module_id = uuid7()
    department_id = uuid7()
    field_id = uuid7()
    data_source = ViewDataSourceResponse.model_validate(
        {"id": module_id, "name": "Equipment", "department_id": department_id}
    )
    field = ViewFieldResponse.model_validate(
        {
            "id": field_id,
            "module_id": module_id,
            "name": "Status",
            "type": FieldType.SELECT,
            "required": True,
            "position": 2,
            "config": {"options": ["open", "closed"]},
        }
    )

    assert data_source.model_dump(mode="json") == {
        "id": str(module_id),
        "name": "Equipment",
        "department_id": str(department_id),
    }
    assert field.model_dump(mode="json") == {
        "id": str(field_id),
        "module_id": str(module_id),
        "name": "Status",
        "type": "select",
        "required": True,
        "position": 2,
        "config": {"options": ["open", "closed"]},
    }


def test_field_catalog_filters_relationship_fields_before_offset_pagination() -> None:
    module_id = uuid7()
    primitive = Field(
        id=uuid7(),
        module_id=module_id,
        name="Name",
        type=FieldType.TEXT,
        required=False,
        position=1,
        config={},
        is_deleted=False,
    )
    relationship = Field(
        id=uuid7(),
        module_id=module_id,
        name="Related item",
        type=FieldType.RELATIONSHIP,
        required=False,
        position=0,
        config={},
        is_deleted=False,
    )

    def excludes_relationship(statement: object) -> bool:
        compiled = statement.compile(dialect=postgresql.dialect())  # type: ignore[attr-defined]
        return FieldType.RELATIONSHIP in compiled.params.values()

    class Rows:
        def __init__(self, items: list[Field]) -> None:
            self.items = items

        def all(self) -> list[Field]:
            return self.items

    class CatalogSession:
        def __init__(self) -> None:
            self.list_statements: list[object] = []
            self.module_statement: object | None = None

        def scalar(self, statement: object) -> object:
            if "FROM modules" in str(statement):
                self.module_statement = statement
                return module_id
            self.list_statements.append(statement)
            return 1 if excludes_relationship(statement) else 2

        def scalars(self, statement: object) -> Rows:
            self.list_statements.append(statement)
            items = [primitive] if excludes_relationship(statement) else [relationship, primitive]
            return Rows(items)

    session = CatalogSession()
    result = list_data_source_fields(
        module_id,
        User(id=uuid7(), status="active", role="admin"),
        session,  # type: ignore[arg-type]
        StandardListRequest[FieldSort](limit=1, offset=0),
    )

    assert [item.id for item in result.items] == [primitive.id]
    assert result.pagination.total == 1
    assert result.pagination.has_more is False
    assert session.module_statement is not None
    assert "modules.is_deleted IS false" in str(
        session.module_statement.compile(dialect=postgresql.dialect())  # type: ignore[attr-defined]
    )


def test_data_source_catalog_lists_every_active_module(monkeypatch) -> None:
    from types import SimpleNamespace

    import app.systems.openview.views.catalog as catalog

    statements: list[object] = []

    def list_result(_db, statement, _params, _spec):
        statements.append(statement)
        return SimpleNamespace(
            items=[],
            pagination=PaginationMetadata(limit=25, offset=0, count=0, total=0, has_more=False),
        )

    monkeypatch.setattr(catalog, "execute_standard_list", list_result)
    user = User(id=uuid7(), status="active", role="admin")
    list_data_sources(
        user,
        object(),  # type: ignore[arg-type]
        StandardListRequest[DataSourceSort](),
    )

    compiled = str(statements[0].compile(dialect=postgresql.dialect()))
    assert "modules.is_deleted IS false" in compiled


def test_create_module_guard_rejects_an_inactive_module() -> None:
    from app.systems.openview.views.router import _active_module

    class RejectedModuleSession:
        def scalar(self, statement: object) -> None:
            compiled = str(statement.compile(dialect=postgresql.dialect()))  # type: ignore[attr-defined]
            assert "modules.is_deleted IS false" in compiled
            return None

    with pytest.raises(HTTPException) as error:
        _active_module(RejectedModuleSession(), uuid7())  # type: ignore[arg-type]

    assert error.value.status_code == 409
