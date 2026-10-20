"""Reuse committed Comms requests and controlled password proof; no mocked authorization."""

import pytest

from tests.comms.jobs.conftest import job_routes as job_routes
from tests.comms.routes.conftest import message_routes as message_routes
from tests.comms.routes.conftest import structure_routes as structure_routes


@pytest.fixture
def tools_routes(job_routes, structure_routes):
    assert job_routes is structure_routes
    return job_routes
