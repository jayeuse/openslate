"""Database-backed workspace policy authorization snapshots."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import is_identity_eligible, is_internal_identity
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.evaluator import (
    AccessDecision,
    AccessRuleCandidate,
    EvaluationReason,
    PolicyEvaluation,
    PolicyPrincipal,
    PrincipalKind,
    RuleDecision,
    ScopeKind,
    ScopePathNode,
    SubjectKind,
    evaluate_access,
)
from app.systems.access.policy.models import (
    AccessGroup,
    AccessGroupMember,
    AccessPolicyVersion,
    AccessRule,
)
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import Role, User, UserRole, UserStatus
from app.systems.access.users.permissions import (
    Capability,
    effective_permissions,
    is_valid_permissions,
)


class ActorLockMode(StrEnum):
    SHARED = "shared"
    UPDATE = "update"


class WorkspaceRoleChanged(HTTPException):
    """The role changed between candidate discovery and the locked snapshot."""

    def __init__(self) -> None:
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


@dataclass(frozen=True, slots=True)
class _WorkspacePolicySnapshot:
    revision: int
    checked_at: datetime
    role: Role
    principal: PolicyPrincipal
    principal_row: User | ServiceIdentity
    candidates: tuple[AccessRuleCandidate, ...]


def authorize_workspace_capabilities(
    db: Session,
    *,
    actor_id: UUID,
    expected_role_id: UUID,
    capabilities: Iterable[Capability | str],
    session_id: UUID | None = None,
    actor_lock_mode: ActorLockMode = ActorLockMode.SHARED,
    now: datetime | None = None,
) -> User:
    """Authorize capabilities from one locked, workspace-scoped policy snapshot."""

    required = tuple(sorted({Capability(item) for item in capabilities}))
    if not required:
        raise ValueError("At least one capability is required")
    timestamp = now or utc_now()
    snapshot = _load_workspace_policy_snapshot(
        db,
        principal_kind=PrincipalKind.USER,
        principal_id=actor_id,
        expected_role_id=expected_role_id,
        capabilities=required,
        now=timestamp,
        session_id=session_id,
        actor_lock_mode=actor_lock_mode,
    )
    actor = snapshot.principal_row
    if not isinstance(actor, User):
        raise _unavailable(db)
    _validate_human_principal(db, actor, snapshot.role, timestamp)
    for capability in required:
        result = _evaluate_snapshot(db, snapshot, capability)
        if result.decision is not AccessDecision.ALLOW:
            raise _forbidden(db)
    actor.role = snapshot.role
    return actor


def check_workspace_access(
    db: Session,
    *,
    principal_kind: PrincipalKind,
    principal_id: UUID,
    capability: Capability,
    now: datetime | None = None,
) -> tuple[PolicyEvaluation, datetime]:
    timestamp = now or utc_now()
    snapshot = _load_workspace_policy_snapshot(
        db,
        principal_kind=principal_kind,
        principal_id=principal_id,
        expected_role_id=None,
        capabilities=(capability,),
        now=timestamp,
    )
    if (
        principal_kind is PrincipalKind.USER
        and snapshot.role.role == UserRole.ADMIN.value
        and isinstance(snapshot.principal_row, User)
        and not is_internal_identity(snapshot.principal_row)
    ):
        return (
            PolicyEvaluation(
                AccessDecision.DENY,
                EvaluationReason.DEFAULT_DENY,
                snapshot.revision,
                None,
                False,
                (),
            ),
            timestamp,
        )
    return _evaluate_snapshot(db, snapshot, capability), timestamp


def _evaluate_snapshot(
    db: Session, snapshot: _WorkspacePolicySnapshot, capability: Capability
) -> PolicyEvaluation:
    result = evaluate_access(
        principal=snapshot.principal,
        capability=capability.value,
        scope_path=(ScopePathNode(kind=ScopeKind.WORKSPACE, id=None),),
        rules=snapshot.candidates,
        now=snapshot.checked_at,
        policy_version=snapshot.revision,
    )
    if result.invalid:
        raise _unavailable(db)
    return result


def _load_workspace_policy_snapshot(
    db: Session,
    *,
    principal_kind: PrincipalKind,
    principal_id: UUID,
    expected_role_id: UUID | None,
    capabilities: tuple[Capability, ...],
    now: datetime,
    session_id: UUID | None = None,
    actor_lock_mode: ActorLockMode = ActorLockMode.SHARED,
) -> _WorkspacePolicySnapshot:
    try:
        version = db.scalar(
            select(AccessPolicyVersion)
            .where(
                AccessPolicyVersion.singleton_key == "workspace",
                AccessPolicyVersion.is_deleted.is_(False),
            )
            .with_for_update(read=True)
        )
        if (
            not isinstance(version, AccessPolicyVersion)
            or type(version.revision) is not int
            or version.revision <= 0
        ):
            raise _unavailable(db)
        if session_id is not None:
            _validate_session(db, actor_id=principal_id, session_id=session_id, now=now)
        if expected_role_id is None:
            model = User if principal_kind is PrincipalKind.USER else ServiceIdentity
            role_id = db.scalar(select(model.role_id).where(model.id == principal_id))
            if role_id is None:
                db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Principal not found"
                )
        else:
            role_id = expected_role_id
        if not isinstance(role_id, UUID):
            raise ValueError("Invalid principal role reference")
        memberships: tuple[object, ...] = ()
        principal_row: User | ServiceIdentity | None = None
        if principal_kind is PrincipalKind.SERVICE:
            principal_row = _load_principal(
                db,
                principal_kind=principal_kind,
                principal_id=principal_id,
                actor_lock_mode=actor_lock_mode,
            )
        role = db.scalar(
            select(Role)
            .where(Role.id == role_id)
            .execution_options(populate_existing=True)
            .with_for_update(read=True)
        )
        if principal_kind is PrincipalKind.USER:
            memberships = _load_group_memberships(db, principal_id)
            principal_row = _load_principal(
                db,
                principal_kind=principal_kind,
                principal_id=principal_id,
                actor_lock_mode=actor_lock_mode,
            )
        rules = _load_workspace_rules(db, capabilities)
        role, principal_row, group_ids, rules = _validate_snapshot_rows(
            db,
            role=role,
            principal_row=principal_row,
            principal_kind=principal_kind,
            principal_id=principal_id,
            memberships=memberships,
            rules=rules,
            expected_role_id=expected_role_id,
        )
        candidates = tuple(
            _candidate_from_rule(
                row,
                policy_revision=version.revision,
                principal_id=principal_id,
                principal_kind=principal_kind,
                role=role,
                group_ids=group_ids,
            )
            for row in rules
        )
        principal = _policy_principal(
            db,
            principal_row=principal_row,
            principal_kind=principal_kind,
            role=role,
            group_ids=group_ids,
        )
        return _WorkspacePolicySnapshot(
            revision=version.revision,
            checked_at=now,
            role=role,
            principal=principal,
            principal_row=principal_row,
            candidates=candidates,
        )
    except (AttributeError, TypeError, ValueError) as error:
        raise _unavailable(db) from error
    except SQLAlchemyError as error:
        raise _unavailable(db) from error


def _validate_session(db: Session, *, actor_id: UUID, session_id: UUID, now: datetime) -> None:
    session = db.get(IdentitySession, session_id, with_for_update=True, populate_existing=True)
    if (
        session is None
        or session.user_id != actor_id
        or session.revoked_at is not None
        or session.expires_at <= now
    ):
        raise _forbidden(db)


def _load_principal(
    db: Session,
    *,
    principal_kind: PrincipalKind,
    principal_id: UUID,
    actor_lock_mode: ActorLockMode,
) -> User | ServiceIdentity | None:
    if principal_kind is PrincipalKind.USER:
        return db.scalar(
            select(User)
            .where(User.id == principal_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User, read=actor_lock_mode is ActorLockMode.SHARED)
        )
    return db.scalar(
        select(ServiceIdentity)
        .where(ServiceIdentity.id == principal_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=ServiceIdentity, read=True)
    )


def _load_group_memberships(db: Session, actor_id: UUID) -> tuple[object, ...]:
    return tuple(
        tuple(row)
        for row in db.execute(
            select(AccessGroupMember, AccessGroup)
            .join(AccessGroup, AccessGroup.id == AccessGroupMember.group_id)
            .where(
                AccessGroupMember.user_id == actor_id,
                AccessGroupMember.is_deleted.is_(False),
                AccessGroup.is_deleted.is_(False),
            )
            .order_by(AccessGroupMember.id, AccessGroup.id)
            .with_for_update(read=True)
        ).all()
    )


def _validate_snapshot_rows(
    db: Session,
    *,
    role: Role | None,
    principal_row: User | ServiceIdentity | None,
    principal_kind: PrincipalKind,
    principal_id: UUID,
    memberships: tuple[object, ...],
    rules: tuple[AccessRule, ...],
    expected_role_id: UUID | None,
) -> tuple[Role, User | ServiceIdentity, frozenset[UUID], tuple[AccessRule, ...]]:
    row_type = User if principal_kind is PrincipalKind.USER else ServiceIdentity
    if not isinstance(role, Role) or role.is_deleted or not is_valid_permissions(role.permissions):
        raise _unavailable(db)
    if not isinstance(principal_row, row_type):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Principal not found")
    if principal_row.role_id != role.id:
        db.rollback()
        if expected_role_id is not None:
            raise WorkspaceRoleChanged()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Principal changed; retry the access check",
        )
    group_ids: set[UUID] = set()
    for item in memberships:
        if not isinstance(item, tuple) or len(item) != 2:
            raise ValueError("Invalid group membership")
        membership, group = item
        if (
            not isinstance(membership, AccessGroupMember)
            or not isinstance(group, AccessGroup)
            or membership.user_id != principal_id
            or membership.group_id != group.id
            or membership.is_deleted
            or group.is_deleted
            or not isinstance(group.id, UUID)
        ):
            raise ValueError("Invalid group membership")
        group_ids.add(group.id)
    if not all(isinstance(rule, AccessRule) for rule in rules):
        raise ValueError("Invalid rule row")
    return role, principal_row, frozenset(group_ids), rules


def _load_workspace_rules(
    db: Session, capabilities: tuple[Capability, ...]
) -> tuple[AccessRule, ...]:
    rows = db.scalars(
        select(AccessRule)
        .where(
            AccessRule.is_deleted.is_(False),
            AccessRule.scope_kind == ScopeKind.WORKSPACE.value,
            AccessRule.permission_id.in_([item.value for item in capabilities]),
        )
        .order_by(
            AccessRule.permission_id,
            AccessRule.subject_kind,
            AccessRule.subject_id,
            AccessRule.id,
        )
        .with_for_update(read=True)
    ).all()
    return tuple(rows)


def _candidate_from_rule(
    row: AccessRule,
    *,
    policy_revision: int,
    principal_id: UUID,
    principal_kind: PrincipalKind,
    role: Role,
    group_ids: frozenset[UUID],
) -> AccessRuleCandidate:
    subject_kind = SubjectKind(row.subject_kind)
    scope_kind = ScopeKind(row.scope_kind)
    decision = RuleDecision(row.decision)
    if (
        not isinstance(row.id, UUID)
        or scope_kind is not ScopeKind.WORKSPACE
        or row.scope_id is not None
        or row.permission_id not in {item.value for item in Capability}
        or type(row.locked) is not bool
        or type(row.policy_version) is not int
        or row.policy_version <= 0
        or row.policy_version > policy_revision
    ):
        raise ValueError("Invalid workspace rule")
    if subject_kind is SubjectKind.EVERYONE:
        if row.subject_id is not None:
            raise ValueError("Invalid everyone rule")
        reference_valid = True
    elif not isinstance(row.subject_id, UUID):
        raise ValueError("Invalid rule subject")
    elif subject_kind is SubjectKind.ROLE:
        reference_valid = row.subject_id == role.id
    elif subject_kind is SubjectKind.GROUP:
        reference_valid = row.subject_id in group_ids
    elif subject_kind is SubjectKind.USER:
        reference_valid = principal_kind is PrincipalKind.USER and row.subject_id == principal_id
    else:
        reference_valid = principal_kind is PrincipalKind.SERVICE and row.subject_id == principal_id
    return AccessRuleCandidate(
        id=row.id,
        subject_kind=subject_kind,
        subject_id=row.subject_id,
        scope_kind=scope_kind,
        scope_id=row.scope_id,
        permission_id=row.permission_id,
        decision=decision,
        starts_at=row.starts_at,
        ends_at=row.ends_at,
        locked=row.locked,
        policy_version=row.policy_version,
        reference_valid=reference_valid,
        is_deleted=False,
    )


def _policy_principal(
    db: Session,
    *,
    principal_row: User | ServiceIdentity,
    principal_kind: PrincipalKind,
    role: Role,
    group_ids: frozenset[UUID],
) -> PolicyPrincipal:
    if principal_kind is PrincipalKind.USER:
        if not isinstance(principal_row, User):
            raise ValueError("Expected a user principal")
        is_active = principal_row.status == UserStatus.ACTIVE.value and is_established_user(
            principal_row
        )
        is_deleted = principal_row.is_deleted
        expires_at = principal_row.expires_at
        principal_id = principal_row.id
        groups = group_ids
    else:
        if not isinstance(principal_row, ServiceIdentity):
            raise ValueError("Expected a service principal")
        if role.role == UserRole.ADMIN.value:
            raise _unavailable(db)
        is_active = principal_row.status == "active"
        is_deleted = principal_row.is_deleted
        expires_at = principal_row.expires_at
        principal_id = principal_row.id
        groups = frozenset()
    return PolicyPrincipal(
        id=principal_id,
        kind=principal_kind,
        is_active=is_active,
        is_deleted=is_deleted,
        expires_at=expires_at,
        role_id=role.id,
        role_name=role.role,
        group_ids=groups,
        legacy_capabilities=frozenset(effective_permissions(role)),
    )


def _validate_human_principal(db: Session, actor: User, role: Role, now: datetime) -> None:
    if (
        actor.status != UserStatus.ACTIVE.value
        or not is_established_user(actor)
        or not is_identity_eligible(actor, now=now)
    ):
        raise _forbidden(db)
    if role.role == UserRole.ADMIN.value and not is_internal_identity(actor):
        raise _forbidden(db)


def _forbidden(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def _unavailable(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Authorization unavailable",
    )
