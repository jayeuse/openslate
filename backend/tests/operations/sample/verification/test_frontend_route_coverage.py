"""Every UI adapter operation needs a real API and explicit run coverage."""

from __future__ import annotations

import json
import re
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

import operations.sample.verification.route_coverage as coverage
from app.main import app
from operations.sample.client import SampleClient
from operations.sample.journal import append_event
from tests.repository import REPOSITORY_ROOT

# Fixed, so parametrized test IDs are the same in every process.
_PATH_ID = "0190a000-0000-7000-8000-000000000001"

MANIFEST = REPOSITORY_ROOT / "frontend" / "api-route-manifest.json"


def _shape(path: str) -> str:
    return re.sub(r"\{[^{}]+\}", "{id}", path)


def test_every_frontend_operation_exists_and_has_simulated_run_coverage() -> None:
    assert MANIFEST.is_file(), "The checked-in frontend route manifest is missing"
    from operations.sample.verification.route_coverage import DEFERRED_ROUTES, SEEDER_ROUTES

    entries = json.loads(MANIFEST.read_text())
    assert isinstance(entries, list) and entries, "The frontend route manifest must be nonempty"
    frontend = {(entry["method"], _shape(entry["path"])) for entry in entries}
    registered = {
        (method.upper(), _shape(path))
        for path, methods in app.openapi()["paths"].items()
        for method in methods
        if method in {"get", "post", "put", "patch", "delete", "head", "options"}
    }
    covered = {(method, _shape(path)) for method, path in SEEDER_ROUTES}
    deferred = {(method, _shape(path)) for method, path in DEFERRED_ROUTES}
    interactive_routes = getattr(coverage, "INTERACTIVE_ACCEPTANCE_ROUTES", {})
    assert interactive_routes == {}, "Owned MFA must execute in the sample run"
    interactive = {(method, _shape(path)) for method, path in interactive_routes}
    assert not (frontend - registered), f"UI routes absent from OpenAPI: {frontend - registered}"
    assert not (covered & deferred), "A deferred operation must not claim run coverage"
    assert not (interactive & (covered | deferred))
    uncovered = frontend - covered - deferred - interactive
    assert not uncovered, f"UI routes without simulated run coverage: {sorted(uncovered)}"
    assert DEFERRED_ROUTES == {}, "Implemented notification controls may not remain deferred"


def test_route_evidence_contains_templates_without_identifiers_or_payloads(tmp_path: Path) -> None:
    record_id = "ee38d267-cbf1-42f1-92d6-1c2757614a44"
    journal = tmp_path / "requests.jsonl"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"})
        return httpx.Response(200, json={"id": record_id})

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        journal,
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("operator@example.test", "fixture-password")
        client.request(
            "PATCH",
            f"/api/records/{record_id}",
            params={"search": "private-query"},
            json_body={"data": {"note": "private-payload"}},
        )
    contents = journal.read_text()
    started = [
        row
        for line in contents.splitlines()
        if (row := json.loads(line))["event"] == "request_started"
    ]
    assert started[0].get("route_template") == "/api/auth/login"
    assert started[1].get("route_template") == "/api/records/{record_id}"
    for private in (
        record_id,
        "operator@example.test",
        "fixture-password",
        "private-query",
        "private-payload",
    ):
        assert private not in contents


def test_route_coverage_reconciles_the_cookie_free_invitation_journal(tmp_path: Path) -> None:
    other_routes = coverage.SEEDER_ROUTES - {("POST", "/api/auth/invitations/complete")}
    for method, route in sorted(other_routes):
        attempt = str(uuid4())
        append_event(
            tmp_path / "requests.jsonl",
            {
                "event": "request_started",
                "attempt_id": attempt,
                "method": method,
                "route_template": route,
            },
        )
        append_event(
            tmp_path / "requests.jsonl",
            {"event": "request_finished", "attempt_id": attempt, "status_code": 200},
        )
    (tmp_path / "verification-requests.jsonl").touch(mode=0o600)

    def complete(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/auth/invitations/complete"
        assert "cookie" not in request.headers
        return httpx.Response(204)

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "invitation-requests.jsonl",
        transport=httpx.MockTransport(complete),
    ) as acceptance:
        assert acceptance.complete_invitation("a" * 56, "fixture-password").status_code == 204

    counts, issues = coverage.verify_route_coverage(tmp_path, host_acceptance=True)

    assert counts["ui_routes_covered"] == len(coverage.SEEDER_ROUTES)
    assert counts["ui_routes_uncovered"] == 0
    assert counts["ui_routes_interactive"] == 0
    assert issues == []


def test_host_only_routes_are_required_only_for_host_acceptance(tmp_path: Path) -> None:
    covered = coverage.SEEDER_ROUTES - coverage.HOST_ACCEPTANCE_ROUTES
    for name in ("requests.jsonl", "invitation-requests.jsonl", "verification-requests.jsonl"):
        (tmp_path / name).touch(mode=0o600)
    for method, route in sorted(covered):
        attempt = str(uuid4())
        append_event(
            tmp_path / "requests.jsonl",
            {
                "event": "request_started",
                "attempt_id": attempt,
                "method": method,
                "route_template": route,
            },
        )
        append_event(
            tmp_path / "requests.jsonl",
            {"event": "request_finished", "attempt_id": attempt, "status_code": 200},
        )

    plain_counts, plain_issues = coverage.verify_route_coverage(tmp_path)
    _, host_issues = coverage.verify_route_coverage(tmp_path, host_acceptance=True)

    assert plain_issues == []
    assert plain_counts["ui_routes_covered"] == len(covered)
    assert len(host_issues) == len(coverage.HOST_ACCEPTANCE_ROUTES)


@pytest.mark.parametrize(
    "route,path",
    [
        (("POST", "/api/users/{user_id}/mfa/reset"), "/api/users/" + _PATH_ID + "/mfa/reset"),
        (
            ("POST", "/api/auth/mfa/factors/{factor_id}/verification"),
            "/api/auth/mfa/factors/" + _PATH_ID + "/verification",
        ),
        (("POST", "/api/notifications/read-all"), "/api/notifications/read-all"),
        (
            ("POST", "/api/backups/exports/{export_id}/download-admission"),
            "/api/backups/exports/" + _PATH_ID + "/download-admission",
        ),
        (
            ("GET", "/api/backups/exports/{export_id}/content"),
            "/api/backups/exports/" + _PATH_ID + "/content",
        ),
    ],
)
def test_new_control_routes_require_actual_success_after_denial(tmp_path, route, path):
    assert route in coverage.SEEDER_ROUTES, "The route needs an executable control"
    journal = tmp_path / "requests.jsonl"
    status = 403

    def handler(request):
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"})
        return httpx.Response(status, json={"detail": "fixture"})

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        journal,
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("operator@example.test", "fixture-password")
        assert client.request(route[0], path).status_code == 403
        denied = coverage.read_route_evidence(journal)
        assert not any((row["method"], row["path"]) == route for row in denied["covered"])
        status = 200
        assert client.request(route[0], path).status_code == 200
    accepted = coverage.read_route_evidence(journal)
    assert [
        row["requests"] for row in accepted["covered"] if (row["method"], row["path"]) == route
    ] == [1]
