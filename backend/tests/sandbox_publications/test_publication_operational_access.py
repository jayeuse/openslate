"""A published module is operational without any separate schema step."""

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.openview.views.router import router as views_router
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.records.router import router as records_router
from tests.organization_scope_support import scoped_override
from tests.sandbox_publications.support import bound_field, bound_module, publish_structure

pytestmark = pytest.mark.integration


@pytest.fixture
def published(integration_owner_db: Session) -> Iterator[tuple[User, TestClient]]:
    publisher, _document = publish_structure(integration_owner_db)
    app = FastAPI()
    app.include_router(records_router, prefix="/api")
    app.include_router(views_router, prefix="/api")
    app.dependency_overrides[get_current_user] = scoped_override(lambda: publisher)
    app.dependency_overrides[get_db] = lambda: integration_owner_db
    with TestClient(app) as client:
        yield publisher, client
    app.dependency_overrides.clear()


def test_record_create_succeeds_right_after_the_publish_that_creates_the_module(
    integration_owner_db: Session, published: tuple[User, TestClient]
) -> None:
    _publisher, client = published
    module = bound_module(integration_owner_db, "sample-requests")
    request_number = bound_field(
        integration_owner_db,
        "field",
        "sample-requests:sample-field-requests-request-number",
    )

    response = client.post(
        "/api/records",
        json={"module_id": str(module.id), "data": {str(request_number.id): "REQ-001"}},
    )

    assert response.status_code == 201, response.text
    assert response.json()["module_id"] == str(module.id)
    assert response.json()["data"][str(request_number.id)] == "REQ-001"


def test_openview_data_sources_list_every_active_published_module(
    integration_owner_db: Session, published: tuple[User, TestClient]
) -> None:
    _publisher, client = published
    published_module_ids = set(
        integration_owner_db.scalars(
            select(Module.id)
            .join(SandboxBinding, SandboxBinding.module_id == Module.id)
            .where(SandboxBinding.kind == "module", Module.is_deleted.is_(False))
        ).all()
    )
    assert published_module_ids

    response = client.get("/api/views/data-sources", params={"limit": 100})

    assert response.status_code == 200, response.text
    listed = {item["id"] for item in response.json()["items"]}
    assert {str(module_id) for module_id in published_module_ids} <= listed
