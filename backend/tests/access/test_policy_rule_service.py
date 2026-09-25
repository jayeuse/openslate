"""Service contracts for single Access-rule administration."""

import os
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.policy.rules_service as service
from app.systems.access.policy.models import AccessGroup, AccessPolicyVersion, AccessRule
from app.systems.access.policy.schemas import AccessRuleCreate, AccessRuleUpdate
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.manage.audit.context import set_audit_actor
from app.systems.sandbox.departments.models import Department

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


def _payload(**overrides: object) -> AccessRuleCreate:
    return AccessRuleCreate.model_validate(
        {
            "subject_kind": "everyone",
            "subject_id": None,
            "scope_kind": "workspace",
            "scope_id": None,
            "permission_id": "records.read",
            "decision": "allow",
            **overrides,
        }
    )


def _rule(**overrides: object) -> AccessRule:
    values: dict[str, object] = {
        "id": uuid7(),
        "subject_kind": "everyone",
        "subject_id": None,
        "scope_kind": "workspace",
        "scope_id": None,
        "permission_id": "records.read",
        "decision": "allow",
        "starts_at": None,
        "ends_at": None,
        "locked": False,
        "policy_version": 2,
        "is_deleted": False,
    }
    return AccessRule(**(values | overrides))


def test_policy_etag_requires_an_exact_match() -> None:
    version = AccessPolicyVersion(revision=7)

    assert service.policy_etag(version) == '"workspace:7"'
    service.require_match('"workspace:7"', version)
    with pytest.raises(HTTPException) as missing:
        service.require_match(None, version)
    with pytest.raises(HTTPException) as stale:
        service.require_match('"workspace:6"', version)
    assert missing.value.status_code == 428
    assert stale.value.status_code == 412
    assert missing.value.headers == {
        "Cache-Control": "private, no-store",
        "ETag": '"workspace:7"',
    }
    assert stale.value.headers == {
        "Cache-Control": "private, no-store",
        "ETag": '"workspace:7"',
    }


def test_shared_policy_version_reads_request_a_shared_lock() -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = AccessPolicyVersion(revision=1)

    assert service.get_policy_version(db, lock=True, shared=True).revision == 1
    statement = db.scalar.call_args.args[0]
    assert statement._for_update_arg.read is True
    with pytest.raises(ValueError):
        service.get_policy_version(db, shared=True)


@pytest.mark.parametrize(
    ("payload", "reference"),
    [
        (_payload(subject_kind="role", subject_id=uuid7()), Role(role="operator")),
        (_payload(subject_kind="group", subject_id=uuid7()), AccessGroup(name="Operations")),
        (
            _payload(subject_kind="user", subject_id=uuid7()),
            User(
                email="disabled@example.com",
                username="disabled",
                role_id=uuid7(),
                status=UserStatus.DISABLED.value,
                identity_kind=IdentityKind.INTERNAL.value,
                expires_at=datetime.now(UTC) - timedelta(days=1),
            ),
        ),
        (
            _payload(subject_kind="service", subject_id=uuid7()),
            ServiceIdentity(
                name="Disabled service",
                purpose="Reports",
                owner_id=uuid7(),
                role_id=uuid7(),
                expires_at=datetime.now(UTC) - timedelta(days=1),
                status="disabled",
            ),
        ),
        (
            _payload(scope_kind="department", scope_id=uuid7()),
            Department(department_name="Operations"),
        ),
    ],
)
def test_reference_validation_accepts_non_deleted_targets_regardless_of_lifecycle(
    payload: AccessRuleCreate,
    reference: object,
) -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = reference

    service.validate_references(db, payload)

    db.rollback.assert_not_called()


def test_reference_validation_rejects_missing_deleted_and_administrator_targets() -> None:
    for target in (None, Role(role=UserRole.ADMIN.value, is_deleted=False)):
        db = Mock(spec=Session)
        db.scalar.return_value = target
        with pytest.raises(HTTPException) as error:
            service.validate_references(
                db,
                _payload(subject_kind="role", subject_id=uuid7()),
            )
        assert error.value.status_code == 409


def test_create_locks_version_before_references_and_increments_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    version = AccessPolicyVersion(revision=3)
    actor_id = uuid7()
    calls: list[str] = []

    def get_version(*_args: object, **_kwargs: object) -> AccessPolicyVersion:
        calls.append("version")
        return version

    monkeypatch.setattr(
        service,
        "get_policy_version",
        get_version,
    )
    monkeypatch.setattr(
        service,
        "validate_references",
        lambda *_args: calls.append("references"),
    )

    row = service.create_rule(db, _payload(), actor_id)

    assert calls == ["version", "references"]
    assert version.revision == 4
    assert version.performed_by == actor_id
    assert row.policy_version == 4
    assert row.performed_by == actor_id
    db.commit.assert_called_once()
    db.refresh.assert_called_once_with(row)


@pytest.mark.parametrize("operation", ["create", "update"])
def test_rule_writes_reject_unsupported_scopes_before_reference_checks(
    operation: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    version = AccessPolicyVersion(revision=3)
    actor_id = uuid7()
    row = _rule()
    monkeypatch.setattr(
        service,
        "get_policy_version",
        lambda *_args, **_kwargs: version,
    )
    monkeypatch.setattr(service, "get_rule", lambda *_args, **_kwargs: row)
    validate = Mock()
    monkeypatch.setattr(service, "validate_references", validate)

    with pytest.raises(HTTPException) as error:
        if operation == "create":
            service.create_rule(
                db,
                _payload(scope_kind="department", scope_id=uuid7()),
                actor_id,
            )
        else:
            service.update_rule(
                db,
                row.id,
                AccessRuleUpdate(scope_kind="department", scope_id=uuid7()),
                service.policy_etag(version),
                actor_id,
            )

    assert error.value.status_code == 409
    assert error.value.detail == "Only workspace-scoped rules are currently supported"
    assert version.revision == 3
    assert row.scope_kind == "workspace"
    validate.assert_not_called()
    db.add.assert_not_called()
    db.commit.assert_not_called()
    db.rollback.assert_called_once()


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_existing_unsupported_scope_rules_are_read_only(
    operation: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    version = AccessPolicyVersion(revision=3)
    actor_id = uuid7()
    row = _rule(scope_kind="department", scope_id=uuid7())
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "get_rule", lambda *_args, **_kwargs: row)
    validate = Mock()
    monkeypatch.setattr(service, "validate_references", validate)

    with pytest.raises(HTTPException) as error:
        if operation == "update":
            service.update_rule(
                db,
                row.id,
                AccessRuleUpdate(scope_kind="workspace", scope_id=None),
                service.policy_etag(version),
                actor_id,
            )
        else:
            service.delete_rule(
                db,
                row.id,
                service.policy_etag(version),
                actor_id,
            )

    assert error.value.status_code == 409
    assert error.value.detail == "Existing non-workspace rules are read-only"
    assert version.revision == 3
    assert row.scope_kind == "department"
    assert row.is_deleted is False
    validate.assert_not_called()
    db.commit.assert_not_called()
    db.rollback.assert_called_once()


def test_update_noop_releases_locks_without_incrementing_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    version = AccessPolicyVersion(revision=7)
    row = _rule(policy_version=2)
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "get_rule", lambda *_args, **_kwargs: row)
    monkeypatch.setattr(service, "validate_references", Mock())

    returned, revision = service.update_rule(
        db,
        row.id,
        AccessRuleUpdate(decision="allow"),
        service.policy_etag(version),
        uuid7(),
    )

    assert returned is row
    assert revision == 7
    assert version.revision == 7
    assert row.policy_version == 2
    db.commit.assert_called_once()
    db.refresh.assert_called_once_with(row)


def test_update_noop_returns_the_revision_locked_before_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    version = AccessPolicyVersion(revision=7)
    row = _rule(policy_version=2)
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "get_rule", lambda *_args, **_kwargs: row)
    monkeypatch.setattr(service, "validate_references", Mock())
    db.commit.side_effect = lambda: setattr(version, "revision", 8)

    returned, revision = service.update_rule(
        db,
        row.id,
        AccessRuleUpdate(decision="allow"),
        service.policy_revision_etag(7),
        uuid7(),
    )

    assert returned is row
    assert revision == 7
    assert row.policy_version == 2


def test_update_and_delete_increment_policy_once_and_record_actor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    version = AccessPolicyVersion(revision=2)
    row = _rule(policy_version=2)
    actor_id = uuid7()
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "get_rule", lambda *_args, **_kwargs: row)
    monkeypatch.setattr(service, "validate_references", Mock())

    updated, revision = service.update_rule(
        db,
        row.id,
        AccessRuleUpdate(decision="deny"),
        service.policy_etag(version),
        actor_id,
    )
    assert updated is row
    assert revision == 3
    assert (row.decision, row.policy_version, version.revision) == ("deny", 3, 3)
    assert row.performed_by == actor_id
    assert version.performed_by == actor_id

    assert service.delete_rule(db, row.id, service.policy_etag(version), actor_id) == 4
    assert row.is_deleted is True
    assert row.deleted_at is not None
    assert (row.policy_version, version.revision) == (4, 4)


def test_database_and_unique_failures_roll_back_safely() -> None:
    unavailable_db = Mock(spec=Session)
    unavailable_db.scalar.side_effect = SQLAlchemyError("unavailable")
    with pytest.raises(HTTPException) as unavailable:
        service.get_policy_version(unavailable_db, lock=True)
    assert unavailable.value.status_code == 503
    unavailable_db.rollback.assert_called_once()

    conflict_db = Mock(spec=Session)
    conflict_db.commit.side_effect = IntegrityError("insert", {}, Exception("duplicate"))
    with pytest.raises(HTTPException) as conflict:
        service._commit(conflict_db)
    assert conflict.value.status_code == 409
    conflict_db.rollback.assert_called_once()

    refresh_db = Mock(spec=Session)
    refresh_db.refresh.side_effect = SQLAlchemyError("refresh failed")
    with pytest.raises(HTTPException) as refresh_failure:
        service._commit(refresh_db, _rule())
    assert refresh_failure.value.status_code == 503
    refresh_db.flush.assert_called_once()
    refresh_db.commit.assert_not_called()
    refresh_db.rollback.assert_called_once()


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
def test_single_rule_mutations_increment_the_isolated_policy_revision(
    integration_db: Session,
) -> None:
    assert service.get_policy_version(integration_db, lock=True, shared=True).revision >= 1
    role = integration_db.scalar(
        select(Role).where(Role.role == UserRole.MEMBER.value, Role.is_deleted.is_(False))
    )
    assert isinstance(role, Role)
    actor = User(
        email=f"rule-actor-{uuid7().hex}@example.com",
        username=f"rule_actor_{uuid7().hex[:12]}",
        role_id=role.id,
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
    )
    integration_db.add(actor)
    integration_db.flush()
    set_audit_actor(integration_db, actor.id)

    before = service.get_policy_version(integration_db).revision
    row = service.create_rule(integration_db, _payload(), actor.id)
    assert (row.policy_version, row.performed_by) == (before + 1, actor.id)

    version = service.get_policy_version(integration_db)
    row, revision = service.update_rule(
        integration_db,
        row.id,
        AccessRuleUpdate(decision="deny"),
        service.policy_etag(version),
        actor.id,
    )
    assert (row.decision, row.policy_version, revision) == ("deny", before + 2, before + 2)

    version = service.get_policy_version(integration_db)
    _, revision = service.update_rule(
        integration_db,
        row.id,
        AccessRuleUpdate(decision="deny"),
        service.policy_etag(version),
        actor.id,
    )
    assert revision == before + 2
    assert service.get_policy_version(integration_db).revision == before + 2

    version = service.get_policy_version(integration_db)
    service.delete_rule(integration_db, row.id, service.policy_etag(version), actor.id)
    deleted = service.get_rule(integration_db, row.id, include_deleted=True)
    assert deleted.is_deleted is True
    assert service.get_policy_version(integration_db).revision == before + 3
