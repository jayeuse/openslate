"""A sample organization's people cannot read another sample organization's records."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.verification import isolation
from operations.sample.verification.isolation import roster_logins, verify_isolation

HARBOR = "0190a000-0000-7000-8000-0000000000aa"
SCHOOL = "0190a000-0000-7000-8000-0000000000bb"
PARTNER = "0190a000-0000-7000-8000-0000000000ab"
SLUGS = {HARBOR: "sample-harbor", SCHOOL: "sample-school", PARTNER: "sample-harbor-partner"}
SCHOOL_MODULE = "0190a000-0000-7000-8000-0000000000c1"
SCHOOL_RECORD = "0190a000-0000-7000-8000-0000000000d1"
ADMIN = ("administrator@harbor-ops.example", "admin-fixture")
OPERATOR = ("owner@install.example", "operator-fixture")
MEMBER = ("lead@harbor-ops.example", "member-fixture")


class _Wire:
    """Two organizations; the operator runs both, the pack administrator only Harbor."""

    def __init__(
        self, *, leaky: bool = False, school: bool = True, operator_login: bool = True
    ) -> None:
        self.leaky = leaky
        self.operator_login = operator_login
        # The operator also runs the pack's partner organization, which is not probed.
        operator = {HARBOR, PARTNER, SCHOOL} if school else {HARBOR, PARTNER}
        self.memberships = {
            ADMIN[0]: {HARBOR},
            OPERATOR[0]: operator,
            MEMBER[0]: {HARBOR, PARTNER},
        }
        self.logins: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path, org = request.url.path, request.headers.get("x-org")
        if path == "/api/auth/login":
            email = json.loads(request.content)["email"]
            self.logins.append(email)
            if email == OPERATOR[0] and not self.operator_login:
                return httpx.Response(401, json={"authenticated": False})
            cookies = [f"openslate_access={email}; Path=/", "openslate_csrf=csrf; Path=/"]
            return httpx.Response(200, headers=[("set-cookie", value) for value in cookies])
        if path == "/api/auth/logout":
            return httpx.Response(204)
        user = request.headers["cookie"].split("openslate_access=")[1].split(";")[0]
        member_of = self.memberships[user]
        if path == "/api/auth/me":
            rows = [{"org_id": org_id, "slug": SLUGS[org_id]} for org_id in sorted(member_of)]
            return httpx.Response(
                200, json={"memberships": rows, "current_organization": {"org_id": org}}
            )
        if org not in member_of:
            return httpx.Response(403, json={"detail": {"code": "organization_required"}})
        visible = self.leaky or org == SCHOOL
        if path == "/api/records":
            module = request.url.params.get("module_id")
            listed = visible and module in {None, SCHOOL_MODULE}
            rows = [{"id": SCHOOL_RECORD, "module_id": SCHOOL_MODULE}] if listed else []
            return httpx.Response(200, json={"items": rows})
        if path in {f"/api/records/{SCHOOL_RECORD}", f"/api/modules/{SCHOOL_MODULE}"}:
            return httpx.Response(200, json={"id": "x"}) if visible else httpx.Response(404)
        raise AssertionError(f"unexpected request {path}")


def _verify(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, wire: _Wire) -> Any:
    transport = httpx.MockTransport(wire.handle)
    journal = tmp_path / "verification-requests.jsonl"

    def client(*args: Any) -> SampleClient:
        return SampleClient(*args, transport=transport)

    monkeypatch.setattr(isolation, "SampleClient", client)
    with client("http://api.example.test", "http://ui.example.test", journal, HARBOR) as admin:
        admin.login(*ADMIN)
        return verify_isolation(
            admin,
            organization_id=HARBOR,
            api_url="http://api.example.test",
            origin="http://ui.example.test",
            journal=journal,
            operator_login=OPERATOR,
            member_logins=[MEMBER],
        )


def test_another_sample_organization_refuses_this_organizations_people(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed, issues = _verify(tmp_path, monkeypatch, _Wire())

    assert issues == []
    assert observed == {"isolation_organizations": 1, "isolation_refusals": 5}


def test_peer_discovery_uses_the_operator_and_fails_without_its_login(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The pack administrator belongs to Harbor only; its memberships would find no peer.
    wire = _Wire(operator_login=False)

    observed, issues = _verify(tmp_path, monkeypatch, wire)

    assert issues == ["isolation: the operator could not sign in for peer discovery"]
    assert observed == {"isolation_organizations": 0, "isolation_refusals": 0}
    assert wire.logins == [ADMIN[0], OPERATOR[0]]


def test_a_cross_organization_read_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed, issues = _verify(tmp_path, monkeypatch, _Wire(leaky=True))

    assert issues == ["isolation: another sample organization's data was readable"]
    assert observed["isolation_refusals"] == 1  # Membership still refused the named organization.


def test_a_single_sample_organization_needs_no_member_sign_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wire = _Wire(school=False)

    observed, issues = _verify(tmp_path, monkeypatch, wire)

    assert (observed, issues) == ({"isolation_organizations": 0, "isolation_refusals": 0}, [])
    assert wire.logins == [ADMIN[0], OPERATOR[0]]


@pytest.mark.parametrize("response", [
    httpx.Response(500, json={"memberships": []}),
    httpx.Response(403, json={"memberships": []}),
    httpx.Response(200, content=b"not json"),
    httpx.Response(200, json=[]),
    httpx.Response(200, json={}),
    httpx.Response(200, json={"memberships": {}}),
    httpx.Response(200, json={"memberships": [None]}),
    httpx.Response(200, json={"memberships": [{"slug": "sample-school"}]}),
    httpx.Response(200, json={"memberships": [{"org_id": SCHOOL}]}),
    httpx.Response(200, json={"memberships": [{"org_id": "bad", "slug": "sample-school"}]}),
])
def test_failed_or_malformed_peer_discovery_is_incomplete(tmp_path, monkeypatch, response):
    wire = _Wire(school=False)
    handle = wire.handle

    def fail_discovery(request):
        if request.url.path == "/api/auth/me":
            return response
        return handle(request)

    wire.handle = fail_discovery
    observed, issues = _verify(tmp_path, monkeypatch, wire)
    assert issues == ["isolation: peer organization discovery failed"]
    assert observed == {"isolation_organizations": 0, "isolation_refusals": 0}
    assert wire.logins == [ADMIN[0], OPERATOR[0]]


def test_roster_logins_return_only_named_people_with_passwords(tmp_path: Path) -> None:
    roster = tmp_path / "credentials.json"
    roster.write_text(json.dumps({"accounts": [
        {"key": "b", "email": "b@harbor-ops.example", "password": "b-fixture"},
        {"key": "a", "email": "a@harbor-ops.example", "password": "a-fixture"},
        {"key": "pending", "email": "p@harbor-ops.example"},
        {"key": "other", "email": "o@harbor-ops.example", "password": "o-fixture"},
    ]}))

    assert roster_logins(roster, ["b", "a", "pending"]) == [
        ("a@harbor-ops.example", "a-fixture"),
        ("b@harbor-ops.example", "b-fixture"),
    ]
