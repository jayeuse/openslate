"""Least-privilege Report audience choices on runner-owned PostgreSQL."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database import get_db
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.openview.reports.models import Report
from app.systems.openview.reports.router import router
from tests.reports.test_report_routes import _actor, _client, _module, _recipe

pytestmark = pytest.mark.integration


def _role(db: Session, prefix: str, name: str, *, permissions: object) -> Role:
    role = Role(role=f"{prefix}{name}", permissions=permissions)
    db.add(role)
    db.flush()
    return role


def _user(db: Session, prefix: str, name: str, role: Role) -> User:
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"report-choice-{user_id.hex}@example.test",
        username=f"{prefix}{name}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
        role=role,
    )
    db.add(user)
    db.flush()
    return user


def test_report_role_choices_filter_capability_before_count_and_page(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    editor = _actor(db, permissions={"records.write": True})
    prefix = f"report-role-choice-{uuid7().hex}-"
    alpha = _role(db, prefix, "alpha", permissions={"records.read": True})
    _role(db, prefix, "beta", permissions={"records.read": "true"})
    _role(db, prefix, "gamma", permissions={})
    delta = _role(db, prefix, "delta", permissions={"records.read": True})
    deleted = _role(db, prefix, "deleted", permissions={"records.read": True})
    deleted.is_deleted = True
    dated = _role(db, prefix, "dated", permissions={"records.read": True})
    dated.deleted_at = datetime.now(UTC)
    db.flush()

    with _client(db, editor) as client:
        path = f"/api/reports/audience-roles?search={prefix}&limit=1"
        first = client.get(path)
        second = client.get(f"{path}&offset=1")
        assert first.status_code == second.status_code == 200
        assert first.headers["cache-control"] == "private, no-store"
        assert first.json() == {
            "items": [{"id": str(alpha.id), "role": alpha.role}],
            "pagination": {"limit": 1, "offset": 0, "count": 1, "total": 2, "has_more": True},
        }
        assert second.json() == {
            "items": [{"id": str(delta.id), "role": delta.role}],
            "pagination": {"limit": 1, "offset": 1, "count": 1, "total": 2, "has_more": False},
        }
        selected = client.get(f"/api/reports/audience-roles?id={delta.id}")
        assert selected.json()["items"] == [{"id": str(delta.id), "role": delta.role}]
        assert client.get(f"/api/reports/audience-roles?id={deleted.id}").json()[
            "pagination"
        ]["total"] == 0
        admin = db.scalar(select(Role).where(Role.role == "admin"))
        assert admin is not None
        assert client.get(f"/api/reports/audience-roles?id={admin.id}").json()[
            "items"
        ] == [{"id": str(admin.id), "role": "admin"}]
        assert client.get(f"{path}&limit=101").status_code == 422
        assert client.get(f"{path}&deleted=include").status_code == 422


def test_report_user_choices_filter_active_established_eligible_roles_before_page(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    editor = _actor(db, permissions={"records.write": True})
    prefix = f"report_user_choice_{uuid7().hex}_"
    allowed = _role(db, f"choice-{uuid7().hex}-", "read", permissions={"records.read": True})
    no_read = _role(db, f"choice-{uuid7().hex}-", "none", permissions={})
    alpha = _user(db, prefix, "alpha", allowed)
    beta = _user(db, prefix, "beta", no_read)
    gamma = _user(db, prefix, "gamma", allowed)
    gamma.status = UserStatus.PENDING.value
    delta = _user(db, prefix, "delta", allowed)
    delta.invitation_sent_at = datetime.now(UTC)
    expired = _user(db, prefix, "expired", allowed)
    expired.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    epsilon = _user(db, prefix, "epsilon", allowed)
    epsilon.is_deleted = True
    omega = _user(db, prefix, "omega", allowed)
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
        for excluded in (beta, gamma, delta, expired, epsilon):
            assert client.get(f"/api/reports/audience-users?id={excluded.id}").json()[
                "pagination"
            ]["total"] == 0


def test_report_audience_choices_require_records_write_without_profile_disclosure(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    reader = _actor(db, permissions={"records.read": True})
    anonymous = FastAPI()
    anonymous.include_router(router, prefix="/api")
    anonymous.dependency_overrides[get_db] = lambda: db
    for path in ("/api/reports/audience-users", "/api/reports/audience-roles"):
        assert TestClient(anonymous).get(path).status_code == 401
        assert _client(db, reader).get(path).status_code == 403


def test_report_audience_write_rejects_stale_chooser_targets(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    editor = _actor(db, permissions={"records.read": True, "records.write": True})
    module, field = _module(db)
    allowed_role = _role(db, f"choice-{uuid7().hex}-", "read", permissions={"records.read": True})
    selected = _user(db, f"report_choice_{uuid7().hex}_", "person", allowed_role)
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

        selected.invitation_sent_at = None
        allowed_role.permissions = {}
        db.flush()
        invalid_role = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "audience": {"kind": "role", "role_id": str(allowed_role.id)}},
        )
        assert invalid_role.status_code == 409
        assert invalid_role.json()["detail"]["code"] == "audience_invalid"
        invalid_create = client.post(
            "/api/reports",
            json={
                "module_id": str(module.id),
                "name": "Invalid target",
                "recipe": _recipe(field),
                "audience": {"kind": "role", "role_id": str(allowed_role.id)},
            },
        )
        assert invalid_create.status_code == 409
        assert invalid_create.json()["detail"]["code"] == "audience_invalid"
        invalid_user_role = client.patch(
            f"/api/reports/{report_id}",
            json={"revision": 1, "audience": {"kind": "user", "user_id": str(selected.id)}},
        )
        assert invalid_user_role.status_code == 409
        assert invalid_user_role.json()["detail"]["code"] == "audience_invalid"
    stored = db.get(Report, report_id)
    assert stored is not None and stored.revision == 1 and stored.audience_kind == "private"
