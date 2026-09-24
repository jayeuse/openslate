"""Transactional single-rule Access policy administration."""

from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.policy.models import AccessGroup, AccessPolicyVersion, AccessRule
from app.systems.access.policy.schemas import (
    AccessRuleCreate,
    AccessRuleScopeKind,
    AccessRuleSubjectKind,
    AccessRuleUpdate,
)
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.users.models import Role, User, UserRole
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module

UNSUPPORTED_SCOPE_MESSAGE = "Only workspace-scoped rules are currently supported"
UNSUPPORTED_SOURCE_SCOPE_MESSAGE = "Existing non-workspace rules are read-only"


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found")


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _unavailable(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Database unavailable",
    )


def policy_etag(version: AccessPolicyVersion) -> str:
    return policy_revision_etag(version.revision)


def policy_revision_etag(revision: int) -> str:
    return f'"workspace:{revision}"'


def require_match(value: str | None, version: AccessPolicyVersion) -> None:
    if value is None:
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED,
            detail="If-Match is required",
            headers={
                "Cache-Control": "private, no-store",
                "ETag": policy_etag(version),
            },
        )
    if value != policy_etag(version):
        raise HTTPException(
            status_code=status.HTTP_412_PRECONDITION_FAILED,
            detail="Policy changed",
            headers={
                "Cache-Control": "private, no-store",
                "ETag": policy_etag(version),
            },
        )


def get_policy_version(
    db: Session,
    *,
    lock: bool = False,
    shared: bool = False,
) -> AccessPolicyVersion:
    if shared and not lock:
        raise ValueError("A shared policy-version lock requires lock=True")
    statement = select(AccessPolicyVersion).where(
        AccessPolicyVersion.singleton_key == "workspace",
        AccessPolicyVersion.is_deleted.is_(False),
    )
    if lock:
        statement = statement.with_for_update(read=shared)
    try:
        row = db.scalar(statement)
    except SQLAlchemyError as error:
        raise _unavailable(db) from error
    if not isinstance(row, AccessPolicyVersion):
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Policy version unavailable",
        )
    return row


def get_rule(
    db: Session,
    rule_id: UUID,
    *,
    include_deleted: bool = False,
    lock: bool = False,
) -> AccessRule:
    statement = select(AccessRule).where(AccessRule.id == rule_id)
    if not include_deleted:
        statement = statement.where(AccessRule.is_deleted.is_(False))
    if lock:
        statement = statement.with_for_update()
    try:
        row = db.scalar(statement)
    except SQLAlchemyError as error:
        raise _unavailable(db) from error
    if not isinstance(row, AccessRule):
        db.rollback()
        raise _not_found()
    return row


def _locked_reference(
    db: Session,
    model: type[Any],
    reference_id: UUID,
    *,
    lock: bool,
) -> Any | None:
    statement = select(model).where(model.id == reference_id, model.is_deleted.is_(False))
    if lock:
        statement = statement.with_for_update()
    return db.scalar(statement)


def validate_references(db: Session, rule: AccessRuleCreate, *, lock: bool = True) -> None:
    """Lock every polymorphic reference and reject unavailable targets."""

    try:
        if rule.subject_kind is AccessRuleSubjectKind.ROLE:
            assert rule.subject_id is not None
            subject = _locked_reference(db, Role, rule.subject_id, lock=lock)
            if not isinstance(subject, Role) or subject.role == UserRole.ADMIN.value:
                raise _conflict("Rule subject is unavailable")
        elif rule.subject_kind is AccessRuleSubjectKind.GROUP:
            assert rule.subject_id is not None
            group = _locked_reference(db, AccessGroup, rule.subject_id, lock=lock)
            if not isinstance(group, AccessGroup):
                raise _conflict("Rule subject is unavailable")
        elif rule.subject_kind is AccessRuleSubjectKind.USER:
            assert rule.subject_id is not None
            if not isinstance(_locked_reference(db, User, rule.subject_id, lock=lock), User):
                raise _conflict("Rule subject is unavailable")
        elif rule.subject_kind is AccessRuleSubjectKind.SERVICE:
            assert rule.subject_id is not None
            if not isinstance(
                _locked_reference(db, ServiceIdentity, rule.subject_id, lock=lock), ServiceIdentity
            ):
                raise _conflict("Rule subject is unavailable")

        if rule.scope_kind is AccessRuleScopeKind.DEPARTMENT:
            assert rule.scope_id is not None
            department = _locked_reference(db, Department, rule.scope_id, lock=lock)
            if not isinstance(department, Department):
                raise _conflict("Rule scope is unavailable")
        elif rule.scope_kind is AccessRuleScopeKind.MODULE:
            assert rule.scope_id is not None
            if not isinstance(_locked_reference(db, Module, rule.scope_id, lock=lock), Module):
                raise _conflict("Rule scope is unavailable")
        elif rule.scope_kind is AccessRuleScopeKind.FIELD:
            assert rule.scope_id is not None
            if not isinstance(_locked_reference(db, Field, rule.scope_id, lock=lock), Field):
                raise _conflict("Rule scope is unavailable")
    except HTTPException:
        raise
    except SQLAlchemyError as error:
        raise _unavailable(db) from error


def _commit(db: Session, row: AccessRule | None = None) -> None:
    try:
        db.flush()
        if row is not None:
            db.refresh(row)
            db.expunge(row)
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict("Rule conflicts with an existing rule") from error
    except SQLAlchemyError as error:
        raise _unavailable(db) from error


def _current_payload(row: AccessRule) -> AccessRuleCreate:
    return AccessRuleCreate.model_validate(
        {field: getattr(row, field) for field in AccessRuleCreate.model_fields}
    )


def is_supported_rule_scope(rule: AccessRuleCreate) -> bool:
    """Return whether current authorization evaluates the rule's scope."""

    return rule.scope_kind is AccessRuleScopeKind.WORKSPACE and rule.scope_id is None


def create_rule(db: Session, payload: AccessRuleCreate, actor_id: UUID) -> AccessRule:
    try:
        version = get_policy_version(db, lock=True)
        if not is_supported_rule_scope(payload):
            raise _conflict(UNSUPPORTED_SCOPE_MESSAGE)
        validate_references(db, payload)
        next_revision = version.revision + 1
        row = AccessRule(
            **payload.model_dump(),
            policy_version=next_revision,
            performed_by=actor_id,
        )
        db.add(row)
        version.revision = next_revision
        version.performed_by = actor_id
        _commit(db, row)
        return row
    except HTTPException:
        db.rollback()
        raise


def update_rule(
    db: Session,
    rule_id: UUID,
    payload: AccessRuleUpdate,
    if_match: str | None,
    actor_id: UUID,
) -> tuple[AccessRule, int]:
    try:
        version = get_policy_version(db, lock=True)
        require_match(if_match, version)
        row = get_rule(db, rule_id, lock=True)
        current = _current_payload(row)
        if not is_supported_rule_scope(current):
            raise _conflict(UNSUPPORTED_SOURCE_SCOPE_MESSAGE)
        merged = payload.merge_with(current)
        if not is_supported_rule_scope(merged):
            raise _conflict(UNSUPPORTED_SCOPE_MESSAGE)
        validate_references(db, merged)
        changes = merged.model_dump()
        if all(getattr(row, field) == value for field, value in changes.items()):
            current_revision = version.revision
            _commit(db, row)
            return row, current_revision
        for field, value in changes.items():
            setattr(row, field, value)
        next_revision = version.revision + 1
        version.revision = next_revision
        version.performed_by = actor_id
        row.policy_version = next_revision
        row.performed_by = actor_id
        _commit(db, row)
        return row, next_revision
    except HTTPException:
        db.rollback()
        raise


def delete_rule(
    db: Session,
    rule_id: UUID,
    if_match: str | None,
    actor_id: UUID,
) -> int:
    try:
        version = get_policy_version(db, lock=True)
        require_match(if_match, version)
        row = get_rule(db, rule_id, lock=True)
        if not is_supported_rule_scope(_current_payload(row)):
            raise _conflict(UNSUPPORTED_SOURCE_SCOPE_MESSAGE)
        row.is_deleted = True
        row.deleted_at = utc_now()
        row.performed_by = actor_id
        next_revision = version.revision + 1
        row.policy_version = next_revision
        version.revision = next_revision
        version.performed_by = actor_id
        _commit(db)
        return next_revision
    except HTTPException:
        db.rollback()
        raise
