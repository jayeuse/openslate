"""Boards integration-test resource cleanup."""

from collections.abc import Generator

import pytest
from sqlalchemy.orm import Session

from tests.boards.provider_accounts import cleanup_password_accounts


@pytest.fixture(autouse=True)
def _cleanup_provider_accounts(request: pytest.FixtureRequest) -> Generator[None, None, None]:
    yield
    database = request.node.funcargs.get("integration_owner_db")
    if isinstance(database, Session):
        cleanup_password_accounts(database)
