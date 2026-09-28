"""Guarded fixtures confined to the parent-owned disposable file test stack."""

from uuid import uuid4

import pytest

from app.systems.access.users.models import User


@pytest.fixture
def guarded_db(request):
    # Central guard validates the isolated owner target before any fixture connection.
    return request.getfixturevalue("integration_owner_db")


@pytest.fixture
def actor(guarded_db):
    db = guarded_db
    identity = uuid4()
    user = User(
        id=identity,
        email=f"file-{identity}@example.com",
        username=f"file_{identity.hex[:12]}",
        role="admin",
        status="active",
    )
    db.add(user)
    db.commit()
    return user


@pytest.fixture
def file_request():
    from fastapi import Request

    from app.systems.platform.files.providers import transfer_slot

    with transfer_slot() as lease:
        request = Request({"type": "http", "state": {"file_transfer_lease": lease}})
        yield request
