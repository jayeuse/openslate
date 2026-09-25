"""Isolated PostgreSQL evidence for Access rule batch atomicity."""

import os
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.access.policy.models import AccessRule
from app.systems.access.policy.rule_batch_service import apply_rule_batch, preview_rule_batch
from app.systems.access.policy.rules_service import (
    create_rule,
    get_policy_version,
    policy_etag,
)
from app.systems.access.policy.schemas import AccessRuleBatchPreviewRequest, AccessRuleCreate
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


def _rule() -> AccessRuleCreate:
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


def _actor(integration_db: Session) -> tuple[User, Role]:
    role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.MEMBER.value, Role.is_deleted.is_(False))
    )
    assert isinstance(role, Role)
    actor = User(
        email=f"batch-actor-{uuid7().hex}@example.com",
        username=f"batch_actor_{uuid7().hex[:12]}",
        role_id=role.id,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add(actor)
    integration_db.flush()
    set_audit_actor(integration_db, actor.id)
    return actor, role


def _admin_actor(integration_db: Session) -> User:
    role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.ADMIN.value, Role.is_deleted.is_(False))
    )
    assert isinstance(role, Role)
    suffix = uuid7().hex
    actor = User(
        email=f"batch-admin-{suffix}@example.com",
        username=f"batch_admin_{suffix[:12]}",
        role_id=role.id,
        role=role,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add(actor)
    integration_db.flush()
    set_audit_actor(integration_db, actor.id)
    return actor


def _audit_count(integration_db: Session) -> int:
    return int(integration_db.scalar(select(func.count()).select_from(AuditLog)) or 0)


def _audit_actions(integration_db: Session, entity_id: UUID) -> list[AuditAction]:
    return list(
        integration_db.scalars(
            select(AuditLog.action)
            .where(AuditLog.entity_id == entity_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        )
    )


def _batch_payload(first: AccessRule, revision: int) -> AccessRuleBatchPreviewRequest:
    return AccessRuleBatchPreviewRequest.model_validate(
        {
            "base_revision": revision,
            "operations": [
                {"type": "update", "rule_id": first.id, "patch": {"decision": "deny"}},
                {
                    "type": "create",
                    "rule": {
                        "subject_kind": "everyone",
                        "subject_id": None,
                        "scope_kind": "workspace",
                        "scope_id": None,
                        "permission_id": "records.write",
                        "decision": "allow",
                    },
                },
            ],
        }
    )


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_batch_apply_updates_multiple_rules_under_one_isolated_policy_revision(
    integration_db: Session,
) -> None:
    actor, _ = _actor(integration_db)
    first = create_rule(integration_db, _rule(), actor.id)
    policy_version = get_policy_version(integration_db)
    before = policy_version.revision
    before_audits = _audit_count(integration_db)
    payload = _batch_payload(first, before)

    preview = preview_rule_batch(integration_db, payload)
    assert preview.blockers == ()
    assert get_policy_version(integration_db).revision == before
    assert integration_db.get(AccessRule, first.id).decision == "allow"
    assert _audit_count(integration_db) == before_audits
    result = apply_rule_batch(
        integration_db,
        payload,
        digest=preview.digest,
        if_match=policy_etag(get_policy_version(integration_db)),
        actor_id=actor.id,
    )

    assert result.revision == before + 1
    updated = integration_db.get(AccessRule, first.id)
    assert isinstance(updated, AccessRule)
    assert (updated.decision, updated.policy_version, updated.performed_by) == (
        "deny",
        before + 1,
        actor.id,
    )
    created = integration_db.scalars(
        select(AccessRule).where(
            AccessRule.permission_id == "records.write",
            AccessRule.is_deleted.is_(False),
        )
    ).all()
    assert len(created) == 1
    assert (created[0].policy_version, created[0].performed_by) == (before + 1, actor.id)
    assert get_policy_version(integration_db).revision == before + 1
    assert _audit_actions(integration_db, first.id) == [AuditAction.CREATE, AuditAction.UPDATE]
    assert _audit_actions(integration_db, created[0].id) == [AuditAction.CREATE]
    assert _audit_actions(integration_db, policy_version.id)[-1] == AuditAction.UPDATE


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_blocked_and_noop_batches_leave_rules_policy_and_audits_unchanged(
    integration_db: Session,
) -> None:
    actor, _ = _actor(integration_db)
    first = create_rule(integration_db, _rule(), actor.id)
    before = get_policy_version(integration_db).revision
    before_audits = _audit_count(integration_db)
    blocked = AccessRuleBatchPreviewRequest.model_validate(
        {
            "base_revision": before,
            "operations": [
                {"type": "update", "rule_id": first.id, "patch": {"decision": "deny"}},
                {
                    "type": "create",
                    "rule": {
                        "subject_kind": "everyone",
                        "subject_id": None,
                        "scope_kind": "workspace",
                        "scope_id": None,
                        "permission_id": "records.read",
                        "decision": "allow",
                    },
                },
            ],
        }
    )

    with pytest.raises(HTTPException) as failure:
        apply_rule_batch(
            integration_db,
            blocked,
            digest=preview_rule_batch(integration_db, blocked).digest,
            if_match=policy_etag(get_policy_version(integration_db)),
            actor_id=actor.id,
        )

    assert failure.value.status_code == 409
    assert get_policy_version(integration_db).revision == before
    assert integration_db.get(AccessRule, first.id).decision == "allow"
    assert _audit_count(integration_db) == before_audits

    noop = AccessRuleBatchPreviewRequest.model_validate(
        {
            "base_revision": before,
            "operations": [
                {"type": "update", "rule_id": first.id, "patch": {"decision": "allow"}},
            ],
        }
    )
    result = apply_rule_batch(
        integration_db,
        noop,
        digest=preview_rule_batch(integration_db, noop).digest,
        if_match=policy_etag(get_policy_version(integration_db)),
        actor_id=actor.id,
    )

    assert result.revision == before
    assert get_policy_version(integration_db).revision == before
    assert integration_db.get(AccessRule, first.id).decision == "allow"
    assert _audit_count(integration_db) == before_audits


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_commit_failure_rolls_back_staged_multi_rule_batch(
    integration_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actor, _ = _actor(integration_db)
    first = create_rule(integration_db, _rule(), actor.id)
    before = get_policy_version(integration_db).revision
    before_audits = _audit_count(integration_db)
    payload = _batch_payload(first, before)

    def fail_commit() -> None:
        raise SQLAlchemyError("forced commit failure")

    monkeypatch.setattr(integration_db, "commit", fail_commit)
    with pytest.raises(HTTPException) as failure:
        apply_rule_batch(
            integration_db,
            payload,
            digest=preview_rule_batch(integration_db, payload).digest,
            if_match=policy_etag(get_policy_version(integration_db)),
            actor_id=actor.id,
        )

    assert failure.value.status_code == 503
    assert get_policy_version(integration_db).revision == before
    assert integration_db.get(AccessRule, first.id).decision == "allow"
    assert not integration_db.scalars(
        select(AccessRule).where(
            AccessRule.permission_id == "records.write",
            AccessRule.is_deleted.is_(False),
        )
    ).all()
    assert _audit_count(integration_db) == before_audits


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_role_rule_impact_counts_non_deleted_users_and_services(
    integration_db: Session,
) -> None:
    actor, role = _actor(integration_db)
    service = ServiceIdentity(
        name=f"Batch service {uuid7()}",
        purpose="Batch impact test",
        owner_id=actor.id,
        role_id=role.id,
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    integration_db.add(service)
    integration_db.flush()
    version = get_policy_version(integration_db).revision
    payload = AccessRuleBatchPreviewRequest.model_validate(
        {
            "base_revision": version,
            "operations": [
                {
                    "type": "create",
                    "rule": {
                        "subject_kind": "role",
                        "subject_id": role.id,
                        "scope_kind": "workspace",
                        "scope_id": None,
                        "permission_id": "records.read",
                        "decision": "allow",
                    },
                }
            ],
        }
    )

    preview = preview_rule_batch(integration_db, payload)

    assert preview.blockers == ()
    assert preview.affected_principals == 2


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_http_batch_blocks_unsupported_scope_writes_without_partial_mutation(
    integration_db: Session,
) -> None:
    admin = _admin_actor(integration_db)
    department = Department(department_name=f"Legacy batch scope {uuid7().hex[:12]}")
    integration_db.add(department)
    integration_db.flush()
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
    legacy_conversion = AccessRule(
        subject_kind="everyone",
        subject_id=None,
        scope_kind="module",
        scope_id=uuid7(),
        permission_id="records.read",
        decision="allow",
        policy_version=revision,
    )
    legacy_deletion = AccessRule(
        subject_kind="everyone",
        subject_id=None,
        scope_kind="field",
        scope_id=uuid7(),
        permission_id="records.read",
        decision="allow",
        policy_version=revision,
    )
    integration_db.add_all([legacy, legacy_conversion, legacy_deletion])
    integration_db.commit()

    payload = AccessRuleBatchPreviewRequest.model_validate(
        {
            "base_revision": get_policy_version(integration_db).revision,
            "operations": [
                {
                    "type": "create",
                    "rule": {
                        "subject_kind": "everyone",
                        "subject_id": None,
                        "scope_kind": "department",
                        "scope_id": department.id,
                        "permission_id": "records.write",
                        "decision": "allow",
                    },
                },
                {
                    "type": "update",
                    "rule_id": legacy.id,
                    "patch": {"decision": "deny"},
                },
                {
                    "type": "update",
                    "rule_id": legacy_conversion.id,
                    "patch": {"scope_kind": "workspace", "scope_id": None},
                },
                {"type": "delete", "rule_id": legacy_deletion.id},
            ],
        }
    )
    application = create_app()
    application.dependency_overrides[get_db] = lambda: integration_db
    application.dependency_overrides[get_current_user] = lambda: admin
    request_body = payload.model_dump(mode="json", exclude_unset=True)
    before_audits = _audit_count(integration_db)

    with TestClient(application) as client:
        preview = client.post("/api/access/rules/impact-preview", json=request_body)

        assert preview.status_code == 200, preview.text
        preview_body = preview.json()
        expected_blockers = [
            {
                "operation_index": 0,
                "code": "unsupported_scope",
                "message": "Only workspace-scoped rules are currently supported",
                "rule_id": None,
            },
            {
                "operation_index": 1,
                "code": "unsupported_scope",
                "message": "Existing non-workspace rules are read-only",
                "rule_id": None,
            },
            {
                "operation_index": 2,
                "code": "unsupported_scope",
                "message": "Existing non-workspace rules are read-only",
                "rule_id": None,
            },
            {
                "operation_index": 3,
                "code": "unsupported_scope",
                "message": "Existing non-workspace rules are read-only",
                "rule_id": None,
            },
        ]
        assert preview_body["can_apply"] is False
        assert preview_body["blockers"] == expected_blockers
        assert preview_body["counts"] == {
            "created": 0,
            "updated": 0,
            "deleted": 0,
            "unchanged": 0,
        }
        assert preview_body["affected_principals"] is None

        applied = client.post(
            "/api/access/rules/apply",
            headers={"If-Match": policy_etag(get_policy_version(integration_db))},
            json={**request_body, "digest": preview_body["digest"]},
        )

    assert applied.status_code == 409
    assert applied.json() == {
        "detail": {
            "code": "batch_blocked",
            "message": "Batch cannot be applied",
            "blockers": expected_blockers,
        }
    }
    assert get_policy_version(integration_db).revision == payload.base_revision
    stored_legacy = integration_db.get(AccessRule, legacy.id)
    assert isinstance(stored_legacy, AccessRule)
    assert stored_legacy.decision == "allow"
    stored_conversion = integration_db.get(AccessRule, legacy_conversion.id)
    stored_deletion = integration_db.get(AccessRule, legacy_deletion.id)
    assert isinstance(stored_conversion, AccessRule)
    assert isinstance(stored_deletion, AccessRule)
    assert (stored_conversion.scope_kind, stored_conversion.is_deleted) == ("module", False)
    assert (stored_deletion.scope_kind, stored_deletion.is_deleted) == ("field", False)
    assert not integration_db.scalars(
        select(AccessRule).where(
            AccessRule.permission_id == "records.write",
            AccessRule.scope_id == department.id,
            AccessRule.is_deleted.is_(False),
        )
    ).all()
    assert _audit_count(integration_db) == before_audits
