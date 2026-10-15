"""Shared search route builders: a client, a search call and a module titled by its values."""

from unittest.mock import Mock

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.main import create_app
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.rbac.support import add_department, add_module


def client(db: Session | Mock, actor: User | None) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    if actor is not None:
        app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app, base_url=get_settings().public_origin)


def search(api: TestClient, kind: str, text: str, **params: object) -> dict:
    response = api.get("/api/search", params={"kind": kind, "search": text, **params})
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    return response.json()


def ids(result: dict) -> set[str]:
    return {item["id"] for item in result["items"]}


def titled_module(
    db: Session, titles: list[object], *, kind: str = "text"
) -> tuple[Module, Field, list[Record]]:
    module = add_module(db, add_department(db), "Search assets")
    field = Field(org_id=module.org_id, module_id=module.id,
                  name="Title", type=kind, position=0, config={})
    db.add(field)
    db.flush()
    module.title_field_id = field.id
    rows = [Record(org_id=module.org_id, module_id=module.id, data={str(field.id): title})
            for title in titles]
    db.add_all(rows)
    db.flush()
    return module, field, rows
