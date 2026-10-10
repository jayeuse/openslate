"""Owned HTTP fixtures for single-field record batch journeys."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from uuid6 import uuid7

from app.common.dependencies import CurrentIdentity, get_current_identity
from app.systems.access.identity.models import IdentitySession
from tests.catalog.test_record_import_integration import _World
from tests.catalog.test_record_import_integration import world as world


@pytest.fixture
def batch_world(world: _World) -> Iterator[_World]:
    sessions = {}
    for actor in (world.admin, world.reader, world.outsider, world.guest):
        session = IdentitySession(
            user_id=actor.id,
            refresh_token_digest=uuid7().hex * 2,
            csrf_token_digest=uuid7().hex * 2,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        world.db.add(session)
        world.db.flush()
        sessions[actor.id] = session.id
    world.db.commit()
    world.client.app.dependency_overrides[get_current_identity] = lambda: CurrentIdentity(
        world.actor[0], sessions[world.actor[0].id], False, False
    )
    try:
        yield world
    finally:
        world.client.app.dependency_overrides.pop(get_current_identity, None)


def create(world: _World, title: str, **values: Any) -> dict[str, Any]:
    data = {str(world.fields["title"].id): title, str(world.fields["int"].id): 7}
    data.update({str(world.fields[name].id): value for name, value in values.items()})
    response = world.client.post(
        "/api/records", json={"module_id": str(world.module.id), "data": data}
    )
    assert response.status_code == 201, response.text
    return response.json()


def item(row: dict[str, Any], field_id: UUID, value: Any) -> dict[str, Any]:
    return {
        "record_id": row["id"],
        "revision": row["updated_at"],
        "field_id": str(field_id),
        "value": value,
    }


def submit(world: _World, items: list[dict[str, Any]]):
    return world.client.post(
        "/api/records/batch-update", json={"module_id": str(world.module.id), "items": items}
    )
