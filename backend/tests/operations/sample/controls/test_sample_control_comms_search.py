"""Search requires coupled backend, sample and source-derived frontend registration."""

import json

from app.main import create_app
from operations.sample.verification.route_coverage import SEEDER_ROUTES
from tests.repository import REPOSITORY_ROOT


def test_search_has_coupled_api_sample_and_frontend_registration():
    path = "/api/comms/search"
    assert "get" in create_app().openapi()["paths"][path]
    assert ("GET", path) in SEEDER_ROUTES
    manifest = json.loads((REPOSITORY_ROOT / "frontend/api-route-manifest.json").read_text())
    assert any(row["method"] == "GET" and row["path"] == path for row in manifest)
