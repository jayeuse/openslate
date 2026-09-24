"""Behavioral tests for bounded Access rule batch planning and application."""

from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import ANY, Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

import app.systems.access.policy.rule_batch_service as service
from app.systems.access.policy.models import AccessPolicyVersion, AccessRule
from app.systems.access.policy.rules_service import policy_revision_etag
from app.systems.access.policy.schemas import AccessRuleBatchPreviewRequest


def _rule(**overrides: object) -> AccessRule:
    values: dict[str, object] = {
        "id": uuid4(),
        "subject_kind": "everyone",
        "subject_id": None,
        "scope_kind": "workspace",
        "scope_id": None,
        "permission_id": "records.read",
        "decision": "allow",
        "starts_at": None,
        "ends_at": None,
        "locked": False,
        "policy_version": 3,
        "is_deleted": False,
    }
    return AccessRule(**(values | overrides))


def _request(
    *operations: dict[str, object], base_revision: int = 3
) -> AccessRuleBatchPreviewRequest:
    return AccessRuleBatchPreviewRequest.model_validate(
        {"base_revision": base_revision, "operations": list(operations)}
    )


def _create(**rule: object) -> dict[str, object]:
    return {
        "type": "create",
        "rule": {
            "subject_kind": "everyone",
            "subject_id": None,
            "scope_kind": "workspace",
            "scope_id": None,
            "permission_id": "records.write",
            "decision": "allow",
            **rule,
        },
    }


def _configure_plan_db(db: Mock, *rows: AccessRule) -> None:
    db.scalars.return_value.all.return_value = list(rows)


def test_canonical_digest_is_revision_bound_and_preserves_explicit_null() -> None:
    rule_id = uuid4()
    utc_value = datetime(2026, 9, 23, 12, tzinfo=UTC)
    offset_value = datetime(2026, 9, 23, 20, tzinfo=timezone(timedelta(hours=8)))
    omitted = _request({"type": "update", "rule_id": rule_id, "patch": {"starts_at": utc_value}})
    explicit_null = _request(
        {
            "type": "update",
            "rule_id": rule_id,
            "patch": {"starts_at": offset_value, "ends_at": None},
        }
    )

    assert service.canonical_batch_digest(omitted) != service.canonical_batch_digest(explicit_null)
    assert service.canonical_batch_digest(omitted) == service.canonical_batch_digest(
        _request(
            {
                "type": "update",
                "rule_id": rule_id,
                "patch": {"starts_at": datetime(2026, 9, 23, 12, tzinfo=UTC)},
            }
        )
    )
    assert service.canonical_batch_digest(omitted) != service.canonical_batch_digest(
        _request(
            {"type": "update", "rule_id": rule_id, "patch": {"starts_at": utc_value}},
            base_revision=4,
        )
    )


def test_preview_uses_shared_version_lock_without_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    row = _rule()
    _configure_plan_db(db, row)
    version = AccessPolicyVersion(revision=3)
    observed: list[dict[str, bool]] = []
    monkeypatch.setattr(
        service,
        "get_policy_version",
        lambda *_args, **kwargs: observed.append(kwargs) or version,
    )
    validate = Mock()
    monkeypatch.setattr(service, "validate_references", validate)
    monkeypatch.setattr(service, "_affected_principal_count", lambda *_args: 1)

    plan = service.preview_rule_batch(
        db,
        _request({"type": "update", "rule_id": row.id, "patch": {"decision": "allow"}}),
    )

    assert observed == [{"lock": True, "shared": True}]
    assert plan.counts.unchanged == 1
    assert plan.blockers == ()
    validate.assert_called_once_with(db, ANY, lock=False)
    db.add.assert_not_called()
    db.flush.assert_not_called()
    db.commit.assert_not_called()


def test_preview_and_apply_block_unsupported_scope_writes_with_specific_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    legacy = _rule(scope_kind="department", scope_id=uuid4())
    _configure_plan_db(db, legacy)
    version = AccessPolicyVersion(revision=3)
    monkeypatch.setattr(
        service,
        "get_policy_version",
        lambda *_args, **_kwargs: version,
    )
    validate = Mock()
    monkeypatch.setattr(service, "validate_references", validate)
    monkeypatch.setattr(service, "_affected_principal_count", lambda *_args: 1)
    request = _request(
        _create(scope_kind="department", scope_id=uuid4()),
        {
            "type": "update",
            "rule_id": legacy.id,
            "patch": {"decision": "deny"},
        },
    )

    plan = service.preview_rule_batch(db, request)

    assert [(item.operation_index, item.code) for item in plan.blockers] == [
        (0, "unsupported_scope"),
        (1, "unsupported_scope"),
    ]
    assert [item.message for item in plan.blockers] == [
        "Only workspace-scoped rules are currently supported",
        "Existing non-workspace rules are read-only",
    ]
    assert plan.counts.model_dump() == {
        "created": 0,
        "updated": 0,
        "deleted": 0,
        "unchanged": 0,
    }
    assert plan.affected_principals is None
    validate.assert_not_called()

    with pytest.raises(HTTPException) as blocked:
        service.apply_rule_batch(
            db,
            request,
            digest=plan.digest,
            if_match=policy_revision_etag(version.revision),
            actor_id=uuid4(),
        )

    assert blocked.value.status_code == 409
    assert blocked.value.detail == {
        "code": "batch_blocked",
        "message": "Batch cannot be applied",
        "blockers": [item.model_dump(mode="json") for item in plan.blockers],
    }
    assert legacy.decision == "allow"
    db.add.assert_not_called()
    db.commit.assert_not_called()
    assert db.rollback.call_count == 1


def test_preview_and_apply_block_mutations_of_legacy_unsupported_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    legacy_update = _rule(scope_kind="department", scope_id=uuid4())
    legacy_delete = _rule(scope_kind="module", scope_id=uuid4())
    _configure_plan_db(db, legacy_update, legacy_delete)
    version = AccessPolicyVersion(revision=3)
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    validate = Mock()
    monkeypatch.setattr(service, "validate_references", validate)
    monkeypatch.setattr(service, "_affected_principal_count", lambda *_args: 1)
    request = _request(
        {
            "type": "update",
            "rule_id": legacy_update.id,
            "patch": {"scope_kind": "workspace", "scope_id": None},
        },
        {"type": "delete", "rule_id": legacy_delete.id},
    )

    plan = service.preview_rule_batch(db, request)

    assert [(item.operation_index, item.code) for item in plan.blockers] == [
        (0, "unsupported_scope"),
        (1, "unsupported_scope"),
    ]
    assert [item.message for item in plan.blockers] == [
        "Existing non-workspace rules are read-only",
        "Existing non-workspace rules are read-only",
    ]
    assert plan.counts.model_dump() == {
        "created": 0,
        "updated": 0,
        "deleted": 0,
        "unchanged": 0,
    }
    assert plan.affected_principals is None
    validate.assert_not_called()

    with pytest.raises(HTTPException) as blocked:
        service.apply_rule_batch(
            db,
            request,
            digest=plan.digest,
            if_match=policy_revision_etag(version.revision),
            actor_id=uuid4(),
        )

    assert blocked.value.status_code == 409
    assert blocked.value.detail == {
        "code": "batch_blocked",
        "message": "Batch cannot be applied",
        "blockers": [item.model_dump(mode="json") for item in plan.blockers],
    }
    assert (legacy_update.scope_kind, legacy_update.is_deleted) == ("department", False)
    assert (legacy_delete.scope_kind, legacy_delete.is_deleted) == ("module", False)
    db.add.assert_not_called()
    db.commit.assert_not_called()
    assert db.rollback.call_count == 1


def test_preview_blocks_delete_then_create_key_reuse_and_duplicate_targets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    row = _rule()
    _configure_plan_db(db, row)
    monkeypatch.setattr(
        service,
        "get_policy_version",
        lambda *_args, **_kwargs: AccessPolicyVersion(revision=3),
    )
    monkeypatch.setattr(service, "validate_references", lambda *_args, **_kwargs: None)

    plan = service.preview_rule_batch(
        db,
        _request(
            {"type": "delete", "rule_id": row.id},
            _create(permission_id="records.read"),
            {"type": "delete", "rule_id": row.id},
        ),
    )

    assert [(blocker.operation_index, blocker.code) for blocker in plan.blockers] == [
        (1, "active_key_conflict"),
        (2, "duplicate_target"),
    ]
    assert plan.counts.model_dump() == {
        "created": 0,
        "updated": 0,
        "deleted": 1,
        "unchanged": 0,
    }
    assert plan.affected_principals is None


def test_preview_turns_partial_patch_merge_failures_into_indexed_blockers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    row = _rule()
    _configure_plan_db(db, row)
    monkeypatch.setattr(
        service,
        "get_policy_version",
        lambda *_args, **_kwargs: AccessPolicyVersion(revision=3),
    )

    plan = service.preview_rule_batch(
        db,
        _request(
            {
                "type": "update",
                "rule_id": row.id,
                "patch": {"scope_kind": "department"},
            }
        ),
    )

    assert [(blocker.operation_index, blocker.code) for blocker in plan.blockers] == [
        (0, "invalid_patch"),
    ]
    assert plan.counts.model_dump() == {
        "created": 0,
        "updated": 0,
        "deleted": 0,
        "unchanged": 0,
    }


def test_affected_principals_dedupe_by_kind_and_include_role_services(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shared_id = uuid4()
    role_id = uuid4()
    operation = service.AccessRuleBatchCreateOperation.model_validate(
        _create(subject_kind="role", subject_id=role_id)
    )
    item = service.RuleBatchPlanItem(
        index=0,
        operation=operation,
        current=None,
        desired=operation.rule,
        changed=True,
    )
    monkeypatch.setattr(service, "_non_admin_user_ids", lambda *_args, **_kwargs: (shared_id,))
    monkeypatch.setattr(service, "_service_ids", lambda *_args, **_kwargs: (shared_id,))

    assert service._affected_principal_count(Mock(spec=Session), [item]) == 2


def test_apply_revalidates_and_increments_once_for_all_changed_operations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    row = _rule()
    _configure_plan_db(db, row)
    version = AccessPolicyVersion(revision=3)
    actor_id = uuid4()
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "validate_references", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(service, "_affected_principal_count", lambda *_args: 2)
    commit = Mock()
    monkeypatch.setattr(service, "_commit", commit)
    request = _request(
        {"type": "update", "rule_id": row.id, "patch": {"decision": "deny"}},
        _create(),
    )

    result = service.apply_rule_batch(
        db,
        request,
        digest=service.canonical_batch_digest(request),
        if_match=policy_revision_etag(version.revision),
        actor_id=actor_id,
    )

    assert result.revision == 4
    assert result.counts.updated == 1
    assert result.counts.created == 1
    assert row.decision == "deny"
    assert (row.policy_version, row.performed_by) == (4, actor_id)
    assert (version.revision, version.performed_by) == (4, actor_id)
    db.add.assert_called_once()
    commit.assert_called_once_with(db)


def test_apply_translates_late_commit_conflicts_to_the_current_policy_etag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    row = _rule()
    _configure_plan_db(db, row)
    version = AccessPolicyVersion(revision=3)
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "validate_references", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(service, "_affected_principal_count", lambda *_args: 1)
    monkeypatch.setattr(
        service,
        "_commit",
        Mock(
            side_effect=HTTPException(
                status_code=409,
                detail="Rule conflicts with an existing rule",
            )
        ),
    )
    request = _request({"type": "update", "rule_id": row.id, "patch": {"decision": "deny"}})

    with pytest.raises(HTTPException) as conflict:
        service.apply_rule_batch(
            db,
            request,
            digest=service.canonical_batch_digest(request),
            if_match=policy_revision_etag(version.revision),
            actor_id=uuid4(),
        )

    assert conflict.value.status_code == 409
    assert conflict.value.headers == {
        "Cache-Control": "private, no-store",
        "ETag": policy_revision_etag(3),
    }


def test_apply_all_noop_preserves_revision_and_audit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    row = _rule(performed_by=uuid4())
    original_actor = row.performed_by
    _configure_plan_db(db, row)
    version = AccessPolicyVersion(revision=3, performed_by=uuid4())
    original_version_actor = version.performed_by
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "validate_references", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(service, "_affected_principal_count", lambda *_args: 0)
    request = _request({"type": "update", "rule_id": row.id, "patch": {"decision": "allow"}})

    result = service.apply_rule_batch(
        db,
        request,
        digest=service.canonical_batch_digest(request),
        if_match=policy_revision_etag(version.revision),
        actor_id=uuid4(),
    )

    assert result.revision == 3
    assert (row.policy_version, row.performed_by) == (3, original_actor)
    assert (version.revision, version.performed_by) == (3, original_version_actor)
    db.rollback.assert_called_once()
    db.commit.assert_not_called()


def test_apply_all_noop_returns_the_revision_locked_before_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    row = _rule()
    _configure_plan_db(db, row)
    version = AccessPolicyVersion(revision=3)
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    monkeypatch.setattr(service, "validate_references", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(service, "_affected_principal_count", lambda *_args: 0)
    db.rollback.side_effect = lambda: setattr(version, "revision", 4)
    request = _request({"type": "update", "rule_id": row.id, "patch": {"decision": "allow"}})

    result = service.apply_rule_batch(
        db,
        request,
        digest=service.canonical_batch_digest(request),
        if_match=policy_revision_etag(3),
        actor_id=uuid4(),
    )

    assert result.revision == 3
    db.commit.assert_not_called()


def test_apply_rejects_stale_or_tampered_batches_with_current_etag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    version = AccessPolicyVersion(revision=3)
    monkeypatch.setattr(service, "get_policy_version", lambda *_args, **_kwargs: version)
    request = _request(_create())

    with pytest.raises(HTTPException) as stale:
        service.apply_rule_batch(
            db,
            request,
            digest="0" * 64,
            if_match=policy_revision_etag(2),
            actor_id=uuid4(),
        )
    assert stale.value.status_code == 412

    with pytest.raises(HTTPException) as tampered:
        service.apply_rule_batch(
            db,
            request,
            digest="0" * 64,
            if_match=policy_revision_etag(3),
            actor_id=uuid4(),
        )
    assert tampered.value.status_code == 409
    assert tampered.value.headers == {
        "Cache-Control": "private, no-store",
        "ETag": policy_revision_etag(3),
    }
