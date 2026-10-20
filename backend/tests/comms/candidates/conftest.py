"""Candidate routes reuse the existing guarded, committed two-organization world."""

import pytest

from tests.comms.routes.conftest import message_routes as message_routes


@pytest.fixture
def candidate_routes(message_routes):
    # Uses the real application aggregate; no endpoint is mounted just for this fixture.
    return message_routes
