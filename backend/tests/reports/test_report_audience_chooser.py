"""Least-privilege Report audience choices on runner-owned PostgreSQL."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import get_db
from app.systems.access.users.models import User, UserStatus
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.router import router
from tests.reports.test_report_routes import _actor, _client, _module, _recipe

pytestmark = pytest.mark.integration


def _user(db: Session, prefix: str, name: str) -> User:
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"report-choice-{user_id.hex}@example.test",
        username=f"{prefix}{name}",
        status=UserStatus.ACTIVE.value,
        role="member",
    )
    db.add(user)
    db.flush()
    return user


def test_report_user_choices_list_active_established_unexpired_accounts_before_page(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    editor = _actor(db, permissions={"records.write": True})
    prefix = f"report_user_choice_{uuid7().hex}_"
    alpha = _user(db, prefix, "alpha")
    gamma = _user(db, prefix, "gamma")
    gamma.status = UserStatus.PENDING.value
    delta = _user(db, prefix, "delta")
    delta.invitation_sent_at = datetime.now(UTC)
    expired = _user(db, prefix, "expired")
    expired.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    epsilon = _user(db, prefix, "epsilon")
    epsilon.is_deleted = True
    omega = _user(db, prefix, "omega")
    db.flush()

    with _client(db, editor) as client:
        path = f"/api/reports/audience-users?search={prefix}&limit=1"
        first = client.get(path)
        second = client.get(f"{path}&offset=1")
        assert first.status_code == second.status_code == 200
        assert first.headers["cache-control"] == "private, no-store"
        assert first.json() == {
            "items": [{"id": str(alpha.id), "username": alpha.username}],
            "pagination": {"limit": 1, "offset": 0, "count": 1, "total": 2, "has_more": True},
        }
        assert second.json()["items"] == [{"id": str(omega.id), "username": omega.username}]
        assert second.json()["pagination"]["total"] == 2
        assert client.get(f"/api/reports/audience-users?id={omega.id}").json()[
            "items"
        ] == [{"id": str(omega.id), "username": omega.username}]
        for excluded in (gamma, delta, expired, epsilon):
            assert client.get(f"/api/reports/audience-users?id={excluded.id}").json()[
                "pagination"
            ]["total"] == 0


def test_report_audience_choices_refuse_guests_without_profile_disclosure(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    reader = _actor(db, permissions={"records.read": True})
    anonymous = FastAPI()
    anonymous.include_router(router, prefix="/api")
    anonymous.dependency_overrides[get_db] = lambda: db
    path = "/api/reports/audience-users"
    assert TestClient(anonymous).get(path).status_code == 401
    assert _client(db, reader).get(path).status_code == 403
    # The role chooser is retired with roles; only the person chooser remains.
    paths = anonymous.openapi()["paths"]
    assert "/api/reports/audience-users" in paths
    assert "/api/reports/audience-roles" not in paths


def test_report_audience_write_rejects_stale_chooser_targets(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    editor = _actor(db, permissions={"records.read": True, "records.write": True})
    module, field = _module(db)
    selected = _user(db, f"report_choice_{uuid7().hex}_", "person")
    with _client(db, editor) as client:
        assert client.get(f"/api/reports/audience-users?id={selected.id}").json()[
            "pagination"
        ]["total"] == 1
        created = client.post(
            "/api/reports",
            json={"module_id": str(module.id), "name": "Safe", "recipe": _recipe(field)},
        )
        assert created.status_code == 201
        report_id = UUID(created.json()["id"])

        selected.invitation_sent_at = datetime.now(UTC)
        db.flush()
        invalid_user = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "audience": {"kind": "user", "user_id": str(selected.id)}},
        )
        assert invalid_user.status_code == 409
        assert invalid_user.json()["detail"]["code"] == "audience_invalid"

        role_audience = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "audience": {"kind": "role", "role_id": str(uuid7())}},
        )
        assert role_audience.status_code == 422
        selected.invitation_sent_at = None
        db.flush()
        no_module_access = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "audience": {"kind": "user", "user_id": str(selected.id)}},
        )
        assert no_module_access.status_code == 409
        assert no_module_access.json()["detail"]["code"] == "audience_invalid"
    stored = db.get(Report, report_id)
    assert stored is not None and stored.revision == 1 and stored.audience_kind == "private"
