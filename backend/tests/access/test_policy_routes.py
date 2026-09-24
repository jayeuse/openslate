"""HTTP contracts for administrator Access-policy routes."""

import os
from datetime import UTC, datetime
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.policy.evaluator import (
    AccessDecision,
    EvaluationReason,
    PolicyEvaluation,
)
from app.systems.access.policy.models import AccessPolicyVersion, AccessRule
from app.systems.access.policy.rules_service import get_policy_version, policy_etag
from app.systems.access.policy.schemas import AccessRuleCreate, AccessRuleUpdate
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.sandbox.departments.models import Department

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


def _payload() -> AccessRuleCreate:
    return AccessRuleCreate.model_validate(
        {
            "subject_kind": "everyone",
            "subject_id": None,
            "scope_kind": "workspace",
            "scope_id": None,
            "permission_id": "records.read",
            "decision": "allow",
        }
    )


def _rule(*, policy_version: int = 4) -> AccessRule:
    now = datetime.now(UTC)
    return AccessRule(
        id=uuid4(),
        subject_kind="everyone",
        subject_id=None,
        scope_kind="workspace",
        scope_id=None,
        permission_id="records.read",
        decision="allow",
        starts_at=None,
        ends_at=None,
        locked=False,
        policy_version=policy_version,
        created_at=now,
        updated_at=now,
        deleted_at=None,
        is_deleted=False,
        performed_by=None,
    )


def test_rule_routes_are_registered_with_explicit_openapi_headers() -> None:
    paths = create_app().openapi()["paths"]

    assert "/api/access/rules" in paths
    assert "/api/access/rules/{rule_id}" in paths
    assert "ETag" in paths["/api/access/rules"]["get"]["responses"]["200"]["headers"]
    create = paths["/api/access/rules"]["post"]["responses"]["201"]["headers"]
    assert {"ETag", "Location"} <= set(create)
    detail = paths["/api/access/rules/{rule_id}"]
    assert "ETag" in detail["get"]["responses"]["200"]["headers"]
    assert {"412", "428"} <= set(detail["patch"]["responses"])
    assert {"412", "428"} <= set(detail["delete"]["responses"])
    assert "409" in detail["delete"]["responses"]
    assert "ETag" in detail["delete"]["responses"]["204"]["headers"]


def test_workspace_check_route_is_registered_with_direct_response_contract() -> None:
    application = create_app()
    application.dependency_overrides[get_db] = lambda: object()
    paths = application.openapi()["paths"]

    assert "/api/access/checks" in paths
    operation = paths["/api/access/checks"]["post"]
    assert operation["operationId"] == "check_workspace_access"
    assert "200" in operation["responses"]
    assert "Cache-Control" in operation["responses"]["200"]["headers"]
    assert {"401", "403", "404", "409", "422", "503"} <= set(operation["responses"])
    assert operation["security"]

    response = TestClient(application).post(
        "/api/access/checks",
        json={
            "principal_kind": "user",
            "principal_id": str(uuid4()),
            "permission_id": "records.read",
            "scope_kind": "workspace",
        },
    )

    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    application.dependency_overrides.clear()


def test_access_check_returns_direct_result_and_marks_services_as_metadata_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = import_module("app.systems.access.policy.checks_router")
    admin = SimpleNamespace(
        id=uuid4(), role=SimpleNamespace(role="admin"), identity_kind="internal"
    )
    database = object()
    exact_admin_calls: list[tuple[object, object]] = []
    checker_calls: list[dict[str, object]] = []
    rule_id = uuid4()
    monkeypatch.setattr(
        router,
        "require_fresh_exact_admin",
        lambda db, user_id: exact_admin_calls.append((db, user_id)),
    )

    def checker(db, **kwargs):
        checker_calls.append({"db": db, **kwargs})
        return (
            PolicyEvaluation(
                decision=AccessDecision.ALLOW,
                reason=EvaluationReason.RULE_ALLOW,
                policy_version=8,
                source_rule_id=rule_id,
                invalid=False,
                trace=(),
            ),
            kwargs["now"],
        )

    monkeypatch.setattr(router, "check_workspace_access", checker)
    application = FastAPI()
    application.include_router(router.router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: database
    application.dependency_overrides[get_current_user] = lambda: admin
    client = TestClient(application)
    payload = {
        "principal_kind": "service",
        "principal_id": str(uuid4()),
        "permission_id": "records.read",
        "scope_kind": "workspace",
    }

    response = client.post("/api/access/checks", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body == {
        **payload,
        "policy_decision": "allow",
        "reason": "rule_allow",
        "source_rule_id": str(rule_id),
        "policy_revision": 8,
        "checked_at": body["checked_at"],
        "runtime_supported": False,
    }
    assert response.headers["cache-control"] == "private, no-store"
    assert exact_admin_calls == [(database, admin.id)]
    assert checker_calls[0]["principal_kind"].value == "service"
    assert "now" in checker_calls[0]

    user_response = client.post(
        "/api/access/checks", json=payload | {"principal_kind": "user"}
    )

    assert user_response.status_code == 200
    assert user_response.json()["runtime_supported"] is True
    assert exact_admin_calls == [(database, admin.id), (database, admin.id)]
    application.dependency_overrides.clear()


def test_access_check_rejects_non_workspace_scope_and_client_selected_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = import_module("app.systems.access.policy.checks_router")
    admin = SimpleNamespace(
        id=uuid4(), role=SimpleNamespace(role="admin"), identity_kind="internal"
    )
    monkeypatch.setattr(router, "require_fresh_exact_admin", lambda *_args: None)
    application = FastAPI()
    application.include_router(router.router, prefix="/api")
    application.dependency_overrides[get_db] = lambda: object()
    application.dependency_overrides[get_current_user] = lambda: admin
    client = TestClient(application)
    payload = {
        "principal_kind": "user",
        "principal_id": str(uuid4()),
        "permission_id": "records.read",
        "scope_kind": "workspace",
    }

    unsupported_scope = client.post(
        "/api/access/checks", json=payload | {"scope_kind": "department"}
    )
    client_time = client.post("/api/access/checks", json=payload | {"now": "2026-01-01"})

    assert unsupported_scope.status_code == 422
    assert client_time.status_code == 422
    application.dependency_overrides.clear()


def test_rule_routes_read_under_shared_revision_lock_and_emit_private_etags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = import_module("app.systems.access.policy.rules_router")

    db = Mock()
    admin = SimpleNamespace(id=uuid4())
    row = _rule()
    version = AccessPolicyVersion(revision=4)
    calls: list[object] = []
    monkeypatch.setattr(router, "require_fresh_exact_admin", lambda *_args: calls.append("admin"))
    monkeypatch.setattr(
        router,
        "get_policy_version",
        lambda *_args, **kwargs: calls.append(kwargs) or version,
    )
    monkeypatch.setattr(router, "get_rule", lambda *_args: row)

    response = Response()
    result = router.get_rule_route(row.id, admin, db, response)

    assert result.id == row.id
    assert calls == ["admin", {"lock": True, "shared": True}]
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["ETag"] == '"workspace:4"'


def test_rule_create_update_and_delete_preserve_conditional_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = import_module("app.systems.access.policy.rules_router")

    db = Mock()
    admin = SimpleNamespace(id=uuid4())
    created = _rule(policy_version=5)
    updated = _rule(policy_version=4)
    monkeypatch.setattr(router, "require_fresh_exact_admin", lambda *_args: None)
    monkeypatch.setattr(router, "create_rule", lambda *_args: created)
    monkeypatch.setattr(router, "update_rule", lambda *_args: (updated, 6))
    monkeypatch.setattr(router, "delete_rule", lambda *_args: 7)

    create_response = Response()
    assert router.create_rule_route(_payload(), admin, db, create_response).id == created.id
    assert create_response.headers["ETag"] == '"workspace:5"'
    assert create_response.headers["Location"] == f"/api/access/rules/{created.id}"

    update_response = Response()
    assert (
        router.update_rule_route(
            updated.id,
            AccessRuleUpdate(decision="deny"),
            admin,
            db,
            update_response,
            '"workspace:5"',
        ).id
        == updated.id
    )
    assert update_response.headers["ETag"] == '"workspace:6"'
    assert updated.policy_version == 4

    deleted = router.delete_rule_route(updated.id, admin, db, '"workspace:6"')
    assert deleted.status_code == 204
    assert deleted.headers["ETag"] == '"workspace:7"'
    assert deleted.headers["Cache-Control"] == "private, no-store"


def test_rule_list_filters_and_database_failures_are_route_local(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = import_module("app.systems.access.policy.rules_router")
    from app.common.listing import PaginationMetadata
    from app.common.listing.query import ListQueryResult
    from app.systems.access.policy.schemas import AccessRuleListRequest

    db = Mock()
    admin = SimpleNamespace(id=uuid4())
    version = AccessPolicyVersion(revision=3)
    row = _rule(policy_version=3)
    version_lock_calls: list[dict[str, bool]] = []
    monkeypatch.setattr(router, "require_fresh_exact_admin", lambda *_args: None)
    monkeypatch.setattr(
        router,
        "get_policy_version",
        lambda *_args, **kwargs: version_lock_calls.append(kwargs) or version,
    )
    executed: dict[str, object] = {}

    def list_rules(*args: object) -> ListQueryResult[AccessRule]:
        executed["statement"] = args[1]
        return ListQueryResult(
            items=[row],
            pagination=PaginationMetadata(limit=25, offset=0, count=1, total=1, has_more=False),
        )

    monkeypatch.setattr(router, "execute_standard_list", list_rules)
    response = Response()
    result = router.list_rules(
        admin,
        db,
        response,
        AccessRuleListRequest(subject_kind="everyone", decision="allow"),
    )
    assert result.items[0].id == row.id
    assert version_lock_calls == [{"lock": True, "shared": True}]
    assert response.headers["ETag"] == '"workspace:3"'
    assert "access_rules.subject_kind" in str(executed["statement"])
    assert "access_rules.decision" in str(executed["statement"])

    monkeypatch.setattr(
        router,
        "execute_standard_list",
        Mock(side_effect=SQLAlchemyError("unavailable")),
    )
    with pytest.raises(HTTPException) as unavailable:
        router.list_rules(admin, db, Response(), AccessRuleListRequest())
    assert unavailable.value.status_code == 503
    db.rollback.assert_called_once()


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_rule_http_writes_reject_unsupported_scopes_without_mutating_policy(
    integration_db: Session,
) -> None:
    admin_role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.ADMIN.value, Role.is_deleted.is_(False))
    )
    assert isinstance(admin_role, Role)
    suffix = uuid7().hex
    admin = User(
        email=f"rule-scope-admin-{suffix}@example.com",
        username=f"rule_scope_admin_{suffix[:12]}",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role_id=admin_role.id,
        role=admin_role,
    )
    department = Department(department_name=f"Legacy rule scope {suffix[:12]}")
    integration_db.add_all([admin, department])
    integration_db.flush()
    set_audit_actor(integration_db, admin.id)
    integration_db.commit()

    application = create_app()
    application.dependency_overrides[get_db] = lambda: integration_db
    application.dependency_overrides[get_current_user] = lambda: admin
    payload = {
        **_payload().model_dump(mode="json"),
        "scope_kind": "department",
        "scope_id": str(department.id),
    }
    with TestClient(application) as client:
        created = client.post("/api/access/rules", json=payload)

        assert created.status_code == 409
        assert created.json() == {
            "detail": "Only workspace-scoped rules are currently supported"
        }
        revision = get_policy_version(integration_db).revision
        legacy = AccessRule(
            subject_kind="everyone",
            subject_id=None,
            scope_kind="department",
            scope_id=department.id,
            permission_id="records.read",
            decision="allow",
            policy_version=revision,
        )
        integration_db.add(legacy)
        integration_db.commit()
        revision = get_policy_version(integration_db).revision

        updated = client.patch(
            f"/api/access/rules/{legacy.id}",
            headers={"If-Match": policy_etag(get_policy_version(integration_db))},
            json={"decision": "deny"},
        )
        converted = client.patch(
            f"/api/access/rules/{legacy.id}",
            headers={"If-Match": policy_etag(get_policy_version(integration_db))},
            json={"scope_kind": "workspace", "scope_id": None},
        )
        deleted = client.delete(
            f"/api/access/rules/{legacy.id}",
            headers={"If-Match": policy_etag(get_policy_version(integration_db))},
        )
        visible = client.get(f"/api/access/rules/{legacy.id}")

    assert updated.status_code == 409
    assert converted.status_code == 409
    assert deleted.status_code == 409
    assert updated.json() == {
        "detail": "Existing non-workspace rules are read-only"
    }
    assert converted.json() == updated.json()
    assert deleted.json() == updated.json()
    assert visible.status_code == 200
    assert visible.json()["scope_kind"] == "department"
    assert get_policy_version(integration_db).revision == revision
    stored_legacy = integration_db.get(AccessRule, legacy.id)
    assert isinstance(stored_legacy, AccessRule)
    assert stored_legacy.decision == "allow"
