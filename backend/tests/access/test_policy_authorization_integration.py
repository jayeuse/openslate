"""Guarded PostgreSQL authorization-lock integration coverage."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.authorization import (
    authorize_workspace_capabilities,
    check_workspace_access,
)
from app.systems.access.policy.evaluator import EvaluationReason, PrincipalKind
from app.systems.access.policy.models import (
    AccessGroup,
    AccessGroupMember,
    AccessPolicyVersion,
    AccessRule,
)
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.users.models import UserStatus
from app.systems.access.users.permissions import Capability
from tests.access.policy_authorization_support import _role, _user

pytestmark = pytest.mark.integration


def _workspace_rule(*, group_id: UUID, policy_version: int, decision: str = "allow") -> AccessRule:
    return AccessRule(
        subject_kind="group",
        subject_id=group_id,
        scope_kind="workspace",
        scope_id=None,
        permission_id=Capability.RECORDS_READ.value,
        decision=decision,
        starts_at=None,
        ends_at=None,
        locked=False,
        policy_version=policy_version,
    )


def test_workspace_authorizer_reads_joined_group_and_rule_rows(
    integration_owner_db: Session,
) -> None:
    suffix = uuid4().hex
    role = _role(name=f"policy-reader-{suffix}", permissions={})
    integration_owner_db.add(role)
    integration_owner_db.flush()
    actor = _user(role=role, name=f"policy-reader-{suffix}")
    group = AccessGroup(name=f"Policy readers {suffix}", description="")
    integration_owner_db.add_all([actor, group])
    integration_owner_db.flush()
    version = integration_owner_db.scalar(
        select(AccessPolicyVersion).where(AccessPolicyVersion.singleton_key == "workspace")
    )
    assert version is not None
    integration_owner_db.add_all(
        [
            AccessGroupMember(group_id=group.id, user_id=actor.id),
            _workspace_rule(group_id=group.id, policy_version=version.revision),
        ]
    )
    integration_owner_db.flush()

    authorized = authorize_workspace_capabilities(
        integration_owner_db,
        actor_id=actor.id,
        expected_role_id=role.id,
        capabilities=(Capability.RECORDS_READ,),
    )

    assert authorized.id == actor.id
    assert authorized.role_id == role.id


def test_workspace_authorizer_applies_real_group_deny_rule(integration_owner_db: Session) -> None:
    suffix = uuid4().hex
    role = _role(name=f"policy-denied-{suffix}", permissions={Capability.RECORDS_READ.value: True})
    integration_owner_db.add(role)
    integration_owner_db.flush()
    actor = _user(role=role, name=f"policy-denied-{suffix}")
    group = AccessGroup(name=f"Policy denied {suffix}", description="")
    integration_owner_db.add_all([actor, group])
    integration_owner_db.flush()
    version = integration_owner_db.scalar(
        select(AccessPolicyVersion).where(AccessPolicyVersion.singleton_key == "workspace")
    )
    assert version is not None
    integration_owner_db.add_all(
        [
            AccessGroupMember(group_id=group.id, user_id=actor.id),
            _workspace_rule(
                group_id=group.id,
                policy_version=version.revision,
                decision="deny",
            ),
        ]
    )
    integration_owner_db.flush()

    with pytest.raises(HTTPException) as denied:
        authorize_workspace_capabilities(
            integration_owner_db,
            actor_id=actor.id,
            expected_role_id=role.id,
            capabilities=(Capability.RECORDS_READ,),
        )

    assert denied.value.status_code == 403


def test_workspace_check_matches_enforcement_and_evaluates_service_subjects(
    integration_owner_db: Session,
) -> None:
    suffix = uuid4().hex
    role = _role(name=f"check-reader-{suffix}", permissions={})
    integration_owner_db.add(role)
    integration_owner_db.flush()
    actor = _user(role=role, name=f"check-user-{suffix}")
    integration_owner_db.add(actor)
    integration_owner_db.flush()
    now = datetime.now(UTC)
    service = ServiceIdentity(
        name=f"check-service-{suffix}",
        purpose="Verify workspace policy check parity",
        owner_id=actor.id,
        role_id=role.id,
        expires_at=now + timedelta(days=1),
    )
    integration_owner_db.add(service)
    integration_owner_db.flush()
    version = integration_owner_db.scalar(
        select(AccessPolicyVersion).where(AccessPolicyVersion.singleton_key == "workspace")
    )
    assert version is not None
    user_rule = AccessRule(
        subject_kind="user",
        subject_id=actor.id,
        scope_kind="workspace",
        scope_id=None,
        permission_id=Capability.RECORDS_READ.value,
        decision="allow",
        starts_at=None,
        ends_at=None,
        locked=False,
        policy_version=version.revision,
    )
    service_rule = AccessRule(
        subject_kind="service",
        subject_id=service.id,
        scope_kind="workspace",
        scope_id=None,
        permission_id=Capability.RECORDS_READ.value,
        decision="allow",
        starts_at=None,
        ends_at=None,
        locked=False,
        policy_version=version.revision,
    )
    integration_owner_db.add_all([user_rule, service_rule])
    integration_owner_db.flush()

    enforced_user = authorize_workspace_capabilities(
        integration_owner_db,
        actor_id=actor.id,
        expected_role_id=role.id,
        capabilities=(Capability.RECORDS_READ,),
        now=now,
    )
    user_result, user_checked_at = check_workspace_access(
        integration_owner_db,
        principal_kind=PrincipalKind.USER,
        principal_id=actor.id,
        capability=Capability.RECORDS_READ,
        now=now,
    )
    service_result, service_checked_at = check_workspace_access(
        integration_owner_db,
        principal_kind=PrincipalKind.SERVICE,
        principal_id=service.id,
        capability=Capability.RECORDS_READ,
        now=now,
    )

    assert enforced_user.id == actor.id
    assert user_result.decision.value == "allow"
    assert user_result.reason.value == "rule_allow"
    assert user_result.source_rule_id == user_rule.id
    assert service_result.decision.value == "allow"
    assert service_result.reason.value == "rule_allow"
    assert service_result.source_rule_id == service_rule.id
    assert user_checked_at == service_checked_at == now


def test_workspace_check_reports_inactive_deleted_and_expired_principal_reasons(
    integration_owner_db: Session,
) -> None:
    suffix = uuid4().hex
    role = _role(name=f"check-lifecycle-{suffix}", permissions={})
    integration_owner_db.add(role)
    integration_owner_db.flush()
    owner = _user(role=role, name=f"check-owner-{suffix}")
    inactive = _user(role=role, name=f"check-inactive-{suffix}")
    inactive.status = UserStatus.DISABLED.value
    deleted = _user(role=role, name=f"check-deleted-{suffix}")
    deleted.is_deleted = True
    deleted.deleted_at = datetime.now(UTC)
    integration_owner_db.add_all([owner, inactive, deleted])
    integration_owner_db.flush()
    now = datetime.now(UTC)
    expired_service = ServiceIdentity(
        name=f"check-expired-{suffix}",
        purpose="Verify expiry is reported before a matching allow",
        owner_id=owner.id,
        role_id=role.id,
        expires_at=now - timedelta(seconds=1),
    )
    integration_owner_db.add(expired_service)
    integration_owner_db.flush()
    version = integration_owner_db.scalar(
        select(AccessPolicyVersion).where(AccessPolicyVersion.singleton_key == "workspace")
    )
    assert version is not None
    targets = (
        (PrincipalKind.USER, inactive.id, EvaluationReason.PRINCIPAL_INACTIVE),
        (PrincipalKind.USER, deleted.id, EvaluationReason.PRINCIPAL_DELETED),
        (PrincipalKind.SERVICE, expired_service.id, EvaluationReason.PRINCIPAL_EXPIRED),
    )
    integration_owner_db.add_all(
        [
            AccessRule(
                subject_kind=kind.value,
                subject_id=principal_id,
                scope_kind="workspace",
                scope_id=None,
                permission_id=Capability.RECORDS_READ.value,
                decision="allow",
                starts_at=None,
                ends_at=None,
                locked=False,
                policy_version=version.revision,
            )
            for kind, principal_id, _reason in targets
        ]
    )
    integration_owner_db.flush()

    results = [
        check_workspace_access(
            integration_owner_db,
            principal_kind=kind,
            principal_id=principal_id,
            capability=Capability.RECORDS_READ,
            now=now,
        )[0]
        for kind, principal_id, _reason in targets
    ]

    assert [result.decision.value for result in results] == ["deny", "deny", "deny"]
    assert [result.reason for result in results] == [reason for _kind, _id, reason in targets]
    assert all(result.source_rule_id is None for result in results)


def test_workspace_check_fails_closed_for_malformed_role_with_direct_allow(
    integration_owner_db: Session,
) -> None:
    suffix = uuid4().hex
    role = _role(name=f"check-malformed-{suffix}", permissions={"unknown.permission": True})
    integration_owner_db.add(role)
    integration_owner_db.flush()
    actor = _user(role=role, name=f"check-malformed-user-{suffix}")
    integration_owner_db.add(actor)
    integration_owner_db.flush()
    version = integration_owner_db.scalar(
        select(AccessPolicyVersion).where(AccessPolicyVersion.singleton_key == "workspace")
    )
    assert version is not None
    integration_owner_db.add(
        AccessRule(
            subject_kind="user",
            subject_id=actor.id,
            scope_kind="workspace",
            scope_id=None,
            permission_id=Capability.RECORDS_READ.value,
            decision="allow",
            starts_at=None,
            ends_at=None,
            locked=False,
            policy_version=version.revision,
        )
    )
    integration_owner_db.flush()

    with pytest.raises(HTTPException) as unavailable:
        check_workspace_access(
            integration_owner_db,
            principal_kind=PrincipalKind.USER,
            principal_id=actor.id,
            capability=Capability.RECORDS_READ,
        )

    assert unavailable.value.status_code == 503
