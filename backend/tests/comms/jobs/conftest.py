"""S23 shares the committed route world; only external password proof is controlled here."""

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import User
from app.systems.sandbox.lifecycle.exceptions import LifecycleInvalidCredentials
from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient
from tests.comms.routes.conftest import message_routes as message_routes
from tests.comms.routes.files.conftest import file_routes as file_routes
from tests.comms.routes.files.conftest import live_provider_storage as live_provider_storage


@pytest.fixture
def job_routes(message_routes, monkeypatch):
    case = message_routes

    def verify(_client, email, password):
        if password != "owned-test-password":
            raise LifecycleInvalidCredentials("Invalid confirmation")
        with Session(case.world.owner) as db:
            identity = db.scalar(select(User.id).where(User.email == email))
            assert identity is not None
            return identity

    monkeypatch.setattr(ProviderPasswordGrantClient, "verify_password", verify)
    return case
