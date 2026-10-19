"""S18 routes must couple actual API implementation, sample execution and frontend calls."""

import json

from app.main import create_app
from operations.sample.verification.route_coverage import SEEDER_ROUTES
from tests.operations.sample.verification.test_frontend_route_coverage import _shape
from tests.repository import REPOSITORY_ROOT

C = "/api/comms/conversations/{conversation_id}"
T = C + "/threads/{root_message_id}"
M = C + "/messages/{message_id}"
CONTENT_ROUTES = {
    ("GET", T),
    ("POST", T),
    ("PATCH", T),
    ("GET", T + "/replies"),
    ("POST", T + "/replies"),
    ("PUT", T + "/follow"),
    ("GET", "/api/comms/threads"),
    ("POST", M + "/reactions"),
    ("DELETE", M + "/reactions"),
    ("PUT", M + "/pin"),
    ("GET", C + "/pins"),
    ("POST", C + "/files"),
    ("PUT", C + "/files/{file_id}/content"),
    ("GET", C + "/files/{file_id}/content"),
    ("GET", C + "/record-references/{reference_id}"),
    ("GET", "/api/comms/record-references"),
}


def test_content_routes_have_coupled_api_sample_and_frontend_registration():
    expected = {(method, _shape(path)) for method, path in CONTENT_ROUTES}
    api = {
        (method.upper(), _shape(path))
        for path, methods in create_app().openapi()["paths"].items()
        for method in methods
        if method in {"get", "post", "put", "patch", "delete"}
    }
    manifest = json.loads((REPOSITORY_ROOT / "frontend/api-route-manifest.json").read_text())
    assert len(expected) == 16 and expected <= api
    assert expected <= {(method, _shape(path)) for method, path in SEEDER_ROUTES}
    assert expected <= {(row["method"], _shape(row["path"])) for row in manifest}
