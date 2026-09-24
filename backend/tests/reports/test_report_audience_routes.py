"""Report audience management and owner run denial on runner-owned PostgreSQL."""

from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.security.tokens import TokenType, decode_token
from app.systems.access.users.models import Role, User
from app.systems.openview.reports.models import Report, ReportRun
from tests.reports.test_report_routes import _actor, _client, _module, _recipe
from tests.reports.test_report_run_routes import _RunFixture

pytest_plugins = ("tests.reports.test_report_run_routes",)
pytestmark = pytest.mark.integration


def test_report_owner_manages_recipe_when_role_or_user_audience_excludes_them(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, permissions={"records.read": True, "records.write": True})
    recipient = _actor(db, permissions={"records.read": True, "records.write": True})
    module, field = _module(db)

    with _client(db, owner) as client:
        created = client.post(
            "/api/reports",
            json={
                "module_id": str(module.id),
                "name": "Audience report",
                "recipe": _recipe(field),
                "audience": {"kind": "role", "role_id": str(recipient.role_id)},
            },
        )
        assert created.status_code == 201, created.text
        report_id = created.json()["id"]
        assert created.json()["audience"] == {
            "kind": "role",
            "role_id": str(recipient.role_id),
            "user_id": None,
        }
        assert client.get(f"/api/reports/{report_id}").status_code == 200
        assert client.get("/api/reports").json()["pagination"]["total"] == 1

        renamed = client.patch(
            f"/api/reports/{report_id}", json={"revision": 1, "name": "Renamed"}
        )
        assert renamed.status_code == 200
        assert renamed.json()["revision"] == 2
        changed = client.patch(
            f"/api/reports/{report_id}",
            json={
                "revision": 2,
                "audience": {"kind": "user", "user_id": str(recipient.id)},
            },
        )
        assert changed.status_code == 200
        assert changed.json()["audience"]["user_id"] == str(recipient.id)
        assert changed.json()["revision"] == 3
        assert client.get(f"/api/reports/{report_id}").status_code == 200

    with _client(db, recipient) as client:
        assert client.get("/api/reports").json()["pagination"]["total"] == 0
        assert client.get(f"/api/reports/{report_id}").status_code == 404
        assert client.patch(
            f"/api/reports/{report_id}", json={"revision": 3, "name": "Takeover"}
        ).status_code == 404


def test_report_audience_rejects_unavailable_targets_and_bad_payloads(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, permissions={"records.read": True, "records.write": True})
    disabled = _actor(db)
    disabled.status = "disabled"
    deleted_role = Role(role=f"deleted-report-role-{uuid7().hex}", permissions={})
    deleted_role.is_deleted = True
    db.add(deleted_role)
    db.flush()
    module, field = _module(db)
    with _client(db, owner) as client:
        created = client.post(
            "/api/reports",
            json={"module_id": str(module.id), "name": "Private", "recipe": _recipe(field)},
        )
        assert created.status_code == 201
        report_id = created.json()["id"]
        assert created.json()["audience"] == {
            "kind": "private",
            "role_id": None,
            "user_id": None,
        }
        for audience in (
            {"kind": "role", "role_id": str(deleted_role.id)},
            {"kind": "role", "role_id": str(uuid7())},
            {"kind": "user", "user_id": str(disabled.id)},
            {"kind": "user", "user_id": str(uuid7())},
        ):
            denied = client.patch(
                f"/api/reports/{report_id}", json={"revision": 1, "audience": audience}
            )
            assert denied.status_code == 409
            assert denied.json()["detail"]["code"] == "audience_invalid"
        malformed = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "audience": {"kind": "private", "user_id": str(owner.id)}},
        )
        assert malformed.status_code == 422
        stored = db.get(Report, report_id)
        assert stored is not None and stored.revision == 1 and stored.audience_kind == "private"


def test_excluded_report_owner_cannot_run_or_read_retained_outputs(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    original_key = uuid7()
    created = fixture.client.post(path, headers=fixture.headers(key=original_key))
    assert created.status_code == 201, created.text
    run_id = created.json()["id"]

    outsider_claims = decode_token(fixture.outsider_token, TokenType.ACCESS)
    assert outsider_claims is not None
    with Session(fixture.owner_engine) as db:
        outsider = db.get(User, UUID(str(outsider_claims["sub"])))
        assert outsider is not None
        recipient_role_id = outsider.role_id

    changed = fixture.client.patch(
        f"/api/reports/{fixture.report_id}",
        headers=fixture.headers(),
        json={"revision": 1, "audience": {"kind": "role", "role_id": str(recipient_role_id)}},
    )
    assert changed.status_code == 200, changed.text
    assert fixture.client.get(
        f"/api/reports/{fixture.report_id}", headers=fixture.headers()
    ).status_code == 200
    for suffix in ("", f"/{run_id}", f"/{run_id}/csv"):
        denied = fixture.client.get(f"{path}{suffix}", headers=fixture.headers())
        assert denied.status_code == 404
    assert fixture.client.post(path, headers=fixture.headers(key=uuid7())).status_code == 404
    assert fixture.client.post(
        path, headers=fixture.headers(key=original_key)
    ).status_code == 404
    outsider_runs = fixture.client.get(path, headers=fixture.headers(fixture.outsider_token))
    assert outsider_runs.status_code == 200
    assert outsider_runs.json()["items"] == []
    assert outsider_runs.json()["pagination"]["total"] == 0

    with Session(fixture.owner_engine) as db:
        retained = db.scalar(select(ReportRun).where(ReportRun.report_id == fixture.report_id))
        assert retained is not None
    restored = fixture.client.patch(
        f"/api/reports/{fixture.report_id}",
        headers=fixture.headers(),
        json={"revision": 2, "audience": {"kind": "private"}},
    )
    assert restored.status_code == 200
    assert fixture.client.get(f"{path}/{run_id}/csv", headers=fixture.headers()).status_code == 200
