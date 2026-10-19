"""The S17 settings/preference surface is coupled to real sample execution and the frontend."""

import json

from app.main import create_app
from operations.sample.verification.route_coverage import SEEDER_ROUTES
from tests.operations.sample.verification.test_frontend_route_coverage import _shape
from tests.repository import REPOSITORY_ROOT

C = "/api/comms/conversations/{conversation_id}"
SETTINGS_ROUTES = {
    ("GET", "/api/comms/preferences"),
    ("PUT", "/api/comms/preferences"),
    ("GET", C + "/preferences"),
    ("PATCH", C + "/preferences"),
    ("GET", "/api/comms/categories/{category_id}/preferences"),
    ("PUT", "/api/comms/categories/{category_id}/preferences"),
    ("PUT", "/api/comms/settings/workspace/locks"),
    ("GET", "/api/comms/settings/workspace/capability-locks"),
    ("PUT", "/api/comms/settings/workspace/capability-locks"),
    ("GET", C + "/capabilities"),
    ("GET", C + "/capabilities/{user_id}"),
    ("GET", "/api/comms/capabilities/channel-creation"),
    *(
        (method, "/api/comms/settings/" + scope + suffix)
        for scope in ("workspace", "category/{category_id}", "channel/{conversation_id}")
        for method, suffix in (
            ("GET", ""),
            ("PATCH", ""),
            ("POST", "/reset"),
            ("GET", "/capabilities"),
            ("PUT", "/capabilities"),
        )
    ),
}


def test_settings_routes_have_coupled_api_sample_and_frontend_registration():
    expected = {(method, _shape(path)) for method, path in SETTINGS_ROUTES}
    api = {
        (method.upper(), _shape(path))
        for path, methods in create_app().openapi()["paths"].items()
        for method in methods
        if method in {"get", "post", "put", "patch", "delete"}
    }
    manifest = json.loads((REPOSITORY_ROOT / "frontend/api-route-manifest.json").read_text())
    assert len(expected) == 27 and expected <= api
    assert expected <= {(method, _shape(path)) for method, path in SEEDER_ROUTES}
    assert expected <= {(row["method"], _shape(row["path"])) for row in manifest}
