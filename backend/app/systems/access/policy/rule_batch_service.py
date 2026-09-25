"""Bounded preview and atomic application for Access policy rule batches."""

import json
from dataclasses import dataclass
from datetime import UTC
from hashlib import sha256
from hmac import compare_digest
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.policy.models import AccessGroupMember, AccessPolicyVersion, AccessRule
from app.systems.access.policy.rules_service import (
    UNSUPPORTED_SCOPE_MESSAGE,
    UNSUPPORTED_SOURCE_SCOPE_MESSAGE,
    _commit,
    _current_payload,
    _unavailable,
    get_policy_version,
    is_supported_rule_scope,
    policy_revision_etag,
    require_match,
    validate_references,
)
from app.systems.access.policy.schemas import (
    AccessRuleBatchBlocker,
    AccessRuleBatchCounts,
    AccessRuleBatchCreateOperation,
    AccessRuleBatchDeleteOperation,
    AccessRuleBatchOperation,
    AccessRuleBatchPreviewRequest,
    AccessRuleBatchUpdateOperation,
    AccessRuleCreate,
)
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.users.models import Role, User, UserRole


@dataclass(frozen=True, slots=True)
class RuleBatchPlanItem:
    index: int
    operation: AccessRuleBatchOperation
    current: AccessRule | None
    desired: AccessRuleCreate | None
    changed: bool


@dataclass(frozen=True, slots=True)
class RuleBatchPlan:
    revision: int
    digest: str
    items: tuple[RuleBatchPlanItem, ...]
    blockers: tuple[AccessRuleBatchBlocker, ...]
    counts: AccessRuleBatchCounts
    affected_principals: int | None


@dataclass(frozen=True, slots=True)
class RuleBatchApplyResult:
    revision: int
    digest: str
    counts: AccessRuleBatchCounts
    affected_principals: int


def canonical_batch_digest(payload: AccessRuleBatchPreviewRequest) -> str:
    """Hash the revision-bound, normalized command payload without live database state."""

    normalized = {
        "base_revision": payload.base_revision,
        "operations": [_normalized_operation(operation) for operation in payload.operations],
    }
    encoded = json.dumps(normalized, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return sha256(encoded.encode("utf-8")).hexdigest()


def preview_rule_batch(db: Session, payload: AccessRuleBatchPreviewRequest) -> RuleBatchPlan:
    """Build a side-effect-free plan while holding a shared policy-version lock."""

    try:
        version = get_policy_version(db, lock=True, shared=True)
        _require_base_revision(payload.base_revision, version)
        return _build_plan(db, payload, version.revision, lock_references=False)
    except HTTPException:
        db.rollback()
        raise


def apply_rule_batch(
    db: Session,
    payload: AccessRuleBatchPreviewRequest,
    *,
    digest: str,
    if_match: str | None,
    actor_id: UUID,
) -> RuleBatchApplyResult:
    """Revalidate and atomically apply a previewed batch under the policy write lock."""

    try:
        version = get_policy_version(db, lock=True)
        current_revision = version.revision
        require_match(if_match, version)
        _require_base_revision(payload.base_revision, version)
        expected_digest = canonical_batch_digest(payload)
        if not compare_digest(expected_digest, digest):
            raise _conflict("Batch digest does not match the supplied operations", version.revision)
        plan = _build_plan(db, payload, version.revision, lock_references=True)
        if plan.blockers:
            raise _blocked(plan, version)
        if not any(item.changed for item in plan.items):
            db.rollback()
            return RuleBatchApplyResult(
                revision=current_revision,
                digest=plan.digest,
                counts=plan.counts,
                affected_principals=plan.affected_principals or 0,
            )

        next_revision = version.revision + 1
        for item in plan.items:
            if not item.changed:
                continue
            if isinstance(item.operation, AccessRuleBatchCreateOperation):
                assert item.desired is not None
                db.add(
                    AccessRule(
                        **item.desired.model_dump(),
                        policy_version=next_revision,
                        performed_by=actor_id,
                    )
                )
            elif isinstance(item.operation, AccessRuleBatchUpdateOperation):
                assert item.current is not None and item.desired is not None
                for field, value in item.desired.model_dump().items():
                    setattr(item.current, field, value)
                item.current.policy_version = next_revision
                item.current.performed_by = actor_id
            else:
                assert isinstance(item.operation, AccessRuleBatchDeleteOperation)
                assert item.current is not None
                item.current.is_deleted = True
                item.current.deleted_at = utc_now()
                item.current.policy_version = next_revision
                item.current.performed_by = actor_id

        version.revision = next_revision
        version.performed_by = actor_id
        try:
            _commit(db)
        except HTTPException as error:
            if error.status_code == status.HTTP_409_CONFLICT:
                raise _conflict("Rule conflicts with an existing rule", current_revision) from error
            raise
        return RuleBatchApplyResult(
            revision=next_revision,
            digest=plan.digest,
            counts=plan.counts,
            affected_principals=plan.affected_principals or 0,
        )
    except HTTPException:
        db.rollback()
        raise


def _build_plan(
    db: Session,
    payload: AccessRuleBatchPreviewRequest,
    revision: int,
    *,
    lock_references: bool,
) -> RuleBatchPlan:
    try:
        active_rows = tuple(
            db.scalars(select(AccessRule).where(AccessRule.is_deleted.is_(False))).all()
        )
    except SQLAlchemyError as error:
        raise _unavailable(db) from error
    active_by_id = {row.id: row for row in active_rows}
    active_by_key = {_rule_key(_current_payload(row)): row.id for row in active_rows}
    blockers: list[AccessRuleBatchBlocker] = []
    seen_targets: set[UUID] = set()
    items: list[RuleBatchPlanItem] = []

    for index, operation in enumerate(payload.operations):
        current: AccessRule | None = None
        desired: AccessRuleCreate | None = None
        changed = False
        if isinstance(operation, AccessRuleBatchCreateOperation):
            desired = operation.rule
            changed = True
        else:
            if operation.rule_id in seen_targets:
                blockers.append(
                    _blocker(
                        index,
                        "duplicate_target",
                        "A rule can be changed once per batch",
                        operation.rule_id,
                    )
                )
            seen_targets.add(operation.rule_id)
            current = active_by_id.get(operation.rule_id)
            if current is None:
                blockers.append(
                    _blocker(index, "rule_not_found", "Rule is unavailable", operation.rule_id)
                )
            elif isinstance(operation, AccessRuleBatchUpdateOperation):
                try:
                    desired = operation.patch.merge_with(_current_payload(current))
                except ValidationError:
                    blockers.append(
                        _blocker(
                            index,
                            "invalid_patch",
                            "Rule patch is incompatible with its current rule",
                        )
                    )
                else:
                    changed = desired != _current_payload(current)
            else:
                changed = True
        items.append(RuleBatchPlanItem(index, operation, current, desired, changed))

    _add_key_blockers(items, active_by_key, blockers)
    for item in items:
        if item.current is not None and not is_supported_rule_scope(_current_payload(item.current)):
            blockers.append(
                _blocker(item.index, "unsupported_scope", UNSUPPORTED_SOURCE_SCOPE_MESSAGE)
            )
            continue
        if item.desired is None:
            continue
        if not is_supported_rule_scope(item.desired):
            blockers.append(_blocker(item.index, "unsupported_scope", UNSUPPORTED_SCOPE_MESSAGE))
            continue
        try:
            validate_references(db, item.desired, lock=lock_references)
        except HTTPException as error:
            if error.status_code != status.HTTP_409_CONFLICT:
                raise
            blockers.append(
                _blocker(
                    item.index,
                    "reference_unavailable",
                    "Rule subject or scope is unavailable",
                )
            )

    ordered_blockers = tuple(
        sorted(blockers, key=lambda blocker: (blocker.operation_index, blocker.code))
    )
    counts = _counts(items, {blocker.operation_index for blocker in ordered_blockers})
    affected = None if ordered_blockers else _affected_principal_count(db, items)
    return RuleBatchPlan(
        revision=revision,
        digest=canonical_batch_digest(payload),
        items=tuple(items),
        blockers=ordered_blockers,
        counts=counts,
        affected_principals=affected,
    )


def _add_key_blockers(
    items: list[RuleBatchPlanItem],
    active_by_key: dict[tuple[str, UUID | None, str, UUID | None, str], UUID],
    blockers: list[AccessRuleBatchBlocker],
) -> None:
    planned_keys: dict[tuple[str, UUID | None, str, UUID | None, str], int] = {}
    for item in items:
        if item.desired is None or not item.changed:
            continue
        key = _rule_key(item.desired)
        owner_id = active_by_key.get(key)
        if owner_id is not None and (item.current is None or owner_id != item.current.id):
            blockers.append(
                _blocker(
                    item.index,
                    "active_key_conflict",
                    "An active rule already owns this key",
                    owner_id,
                )
            )
        other_index = planned_keys.get(key)
        if other_index is not None:
            blockers.append(
                _blocker(other_index, "duplicate_result_key", "Batch produces duplicate rule keys")
            )
            blockers.append(
                _blocker(item.index, "duplicate_result_key", "Batch produces duplicate rule keys")
            )
        else:
            planned_keys[key] = item.index


def _counts(items: list[RuleBatchPlanItem], blocked_indices: set[int]) -> AccessRuleBatchCounts:
    created = updated = deleted = unchanged = 0
    for item in items:
        if item.index in blocked_indices:
            continue
        if isinstance(item.operation, AccessRuleBatchCreateOperation):
            created += 1
        elif isinstance(item.operation, AccessRuleBatchDeleteOperation):
            deleted += int(item.current is not None)
        elif item.changed:
            updated += 1
        elif item.current is not None:
            unchanged += 1
    return AccessRuleBatchCounts(
        created=created,
        updated=updated,
        deleted=deleted,
        unchanged=unchanged,
    )


def _affected_principal_count(db: Session, items: list[RuleBatchPlanItem]) -> int:
    subjects: set[tuple[str, UUID | None]] = set()
    for item in items:
        if not item.changed:
            continue
        if item.current is not None:
            previous = _current_payload(item.current)
            subjects.add((previous.subject_kind.value, previous.subject_id))
        if item.desired is not None:
            subjects.add((item.desired.subject_kind.value, item.desired.subject_id))
    try:
        affected: set[tuple[str, UUID]] = set()
        for subject_kind, subject_id in subjects:
            if subject_kind == "everyone":
                affected.update(("user", user_id) for user_id in _non_admin_user_ids(db))
                affected.update(("service", service_id) for service_id in _service_ids(db))
            elif subject_kind == "role" and subject_id is not None:
                affected.update(
                    ("user", user_id) for user_id in _non_admin_user_ids(db, role_id=subject_id)
                )
                affected.update(
                    ("service", service_id) for service_id in _service_ids(db, role_id=subject_id)
                )
            elif subject_kind == "group" and subject_id is not None:
                affected.update(
                    ("user", user_id) for user_id in _non_admin_user_ids(db, group_id=subject_id)
                )
            elif subject_kind == "user" and subject_id is not None:
                affected.update(
                    ("user", user_id) for user_id in _non_admin_user_ids(db, user_id=subject_id)
                )
            elif subject_kind == "service" and subject_id is not None:
                affected.update(
                    ("service", service_id)
                    for service_id in _service_ids(db, service_id=subject_id)
                )
        return len(affected)
    except SQLAlchemyError as error:
        raise _unavailable(db) from error


def _non_admin_user_ids(
    db: Session,
    *,
    role_id: UUID | None = None,
    group_id: UUID | None = None,
    user_id: UUID | None = None,
) -> tuple[UUID, ...]:
    statement = (
        select(User.id)
        .join(Role, User.role_id == Role.id)
        .where(
            User.is_deleted.is_(False),
            Role.is_deleted.is_(False),
            Role.role != UserRole.ADMIN.value,
        )
    )
    if role_id is not None:
        statement = statement.where(User.role_id == role_id)
    if group_id is not None:
        statement = statement.join(AccessGroupMember, AccessGroupMember.user_id == User.id).where(
            AccessGroupMember.group_id == group_id,
            AccessGroupMember.is_deleted.is_(False),
        )
    if user_id is not None:
        statement = statement.where(User.id == user_id)
    return tuple(db.scalars(statement))


def _service_ids(
    db: Session,
    *,
    role_id: UUID | None = None,
    service_id: UUID | None = None,
) -> tuple[UUID, ...]:
    statement = select(ServiceIdentity.id).where(ServiceIdentity.is_deleted.is_(False))
    if role_id is not None:
        statement = statement.where(ServiceIdentity.role_id == role_id)
    if service_id is not None:
        statement = statement.where(ServiceIdentity.id == service_id)
    return tuple(db.scalars(statement))


def _normalized_operation(operation: AccessRuleBatchOperation) -> dict[str, Any]:
    if isinstance(operation, AccessRuleBatchCreateOperation):
        return {"type": "create", "rule": _normalize_values(operation.rule.model_dump())}
    if isinstance(operation, AccessRuleBatchUpdateOperation):
        patch = {
            field: _normalize_values(getattr(operation.patch, field))
            for field in sorted(operation.patch.model_fields_set)
        }
        return {"type": "update", "rule_id": str(operation.rule_id), "patch": patch}
    return {"type": "delete", "rule_id": str(operation.rule_id)}


def _normalize_values(value: Any) -> Any:
    if hasattr(value, "value"):
        return value.value
    if isinstance(value, UUID):
        return str(value)
    if hasattr(value, "tzinfo") and hasattr(value, "astimezone"):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, dict):
        return {str(key): _normalize_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_values(item) for item in value]
    return value


def _rule_key(rule: AccessRuleCreate) -> tuple[str, UUID | None, str, UUID | None, str]:
    return (
        rule.subject_kind.value,
        rule.subject_id,
        rule.scope_kind.value,
        rule.scope_id,
        rule.permission_id.value,
    )


def _blocker(
    index: int,
    code: str,
    message: str,
    rule_id: UUID | None = None,
) -> AccessRuleBatchBlocker:
    return AccessRuleBatchBlocker(
        operation_index=index,
        code=code,
        message=message,
        rule_id=rule_id,
    )


def _require_base_revision(base_revision: int, version: AccessPolicyVersion) -> None:
    if base_revision != version.revision:
        raise _conflict("Policy changed", version.revision)


def _conflict(message: str, revision: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=message,
        headers={
            "Cache-Control": "private, no-store",
            "ETag": policy_revision_etag(revision),
        },
    )


def _blocked(plan: RuleBatchPlan, version: AccessPolicyVersion) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": "batch_blocked",
            "message": "Batch cannot be applied",
            "blockers": [blocker.model_dump(mode="json") for blocker in plan.blockers],
        },
        headers={
            "Cache-Control": "private, no-store",
            "ETag": policy_revision_etag(version.revision),
        },
    )
