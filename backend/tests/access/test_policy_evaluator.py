from dataclasses import fields, replace
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import UUID, uuid4

import pytest

from app.systems.access.policy.evaluator import (
    AccessDecision,
    AccessRuleCandidate,
    EvaluationReason,
    PolicyPrincipal,
    PrincipalKind,
    RuleDecision,
    ScopeKind,
    ScopePathNode,
    SubjectKind,
    evaluate_access,
)

NOW = datetime(2026, 9, 23, 9, 0, tzinfo=UTC)
CAPABILITY = "records.read"


def _principal(
    *,
    kind: PrincipalKind = PrincipalKind.USER,
    role_name: str | None = "member",
    role_id: UUID | None = None,
    group_ids: frozenset[UUID] = frozenset(),
    legacy_capabilities: frozenset[str] = frozenset(),
    is_active: bool = True,
    is_deleted: bool = False,
    expires_at: datetime | None = None,
) -> PolicyPrincipal:
    return PolicyPrincipal(
        id=uuid4(),
        kind=kind,
        is_active=is_active,
        is_deleted=is_deleted,
        expires_at=expires_at,
        role_id=role_id or uuid4(),
        role_name=role_name,
        group_ids=group_ids,
        legacy_capabilities=legacy_capabilities,
    )


def _path(
    *, department_id: UUID | None = None, module_id: UUID | None = None
) -> tuple[ScopePathNode, ...]:
    path = [ScopePathNode(kind=ScopeKind.WORKSPACE, id=None)]
    if department_id is not None:
        path.append(ScopePathNode(kind=ScopeKind.DEPARTMENT, id=department_id))
    if module_id is not None:
        path.append(ScopePathNode(kind=ScopeKind.MODULE, id=module_id))
    return tuple(path)


def _rule(
    *,
    subject_kind: SubjectKind = SubjectKind.EVERYONE,
    subject_id: UUID | None = None,
    scope_kind: ScopeKind = ScopeKind.WORKSPACE,
    scope_id: UUID | None = None,
    decision: RuleDecision = RuleDecision.ALLOW,
    starts_at: datetime | None = None,
    ends_at: datetime | None = None,
    locked: bool = False,
    policy_version: int = 2,
    reference_valid: bool = True,
    permission_id: str = CAPABILITY,
) -> AccessRuleCandidate:
    return AccessRuleCandidate(
        id=uuid4(),
        subject_kind=subject_kind,
        subject_id=subject_id,
        scope_kind=scope_kind,
        scope_id=scope_id,
        permission_id=permission_id,
        decision=decision,
        starts_at=starts_at,
        ends_at=ends_at,
        locked=locked,
        policy_version=policy_version,
        reference_valid=reference_valid,
    )


def _evaluate(
    principal: PolicyPrincipal,
    rules: tuple[AccessRuleCandidate, ...] = (),
    path: tuple[ScopePathNode, ...] | None = None,
    policy_version: int = 1,
    **kwargs: object,
):
    return evaluate_access(
        principal=principal,
        capability=CAPABILITY,
        scope_path=path or _path(),
        rules=rules,
        now=NOW,
        policy_version=policy_version,
        **kwargs,
    )


def test_active_literal_admin_user_is_protected_before_rules() -> None:
    result = _evaluate(
        _principal(role_name="admin"),
        (_rule(decision=RuleDecision.DENY),),
    )

    assert result.decision is AccessDecision.ALLOW
    assert result.reason is EvaluationReason.ADMINISTRATOR_PROTECTED
    assert result.source_rule_id is None
    assert result.invalid is False


@pytest.mark.parametrize(
    ("principal", "reason"),
    [
        (_principal(is_active=False), EvaluationReason.PRINCIPAL_INACTIVE),
        (_principal(is_deleted=True), EvaluationReason.PRINCIPAL_DELETED),
        (_principal(expires_at=NOW), EvaluationReason.PRINCIPAL_EXPIRED),
        (
            _principal(kind=PrincipalKind.SERVICE, expires_at=NOW),
            EvaluationReason.PRINCIPAL_EXPIRED,
        ),
    ],
)
def test_ineligible_user_or_service_is_denied_before_policy(
    principal: PolicyPrincipal, reason: EvaluationReason
) -> None:
    result = _evaluate(principal, (_rule(),))

    assert result.decision is AccessDecision.DENY
    assert result.reason is reason
    assert result.source_rule_id is None


def test_legacy_baseline_falls_back_but_persisted_rules_can_remove_or_grant() -> None:
    allowed_by_role = _evaluate(_principal(legacy_capabilities=frozenset({CAPABILITY})))
    removed_by_rule = _evaluate(
        _principal(legacy_capabilities=frozenset({CAPABILITY})),
        (_rule(decision=RuleDecision.DENY),),
    )
    granted_by_rule = _evaluate(_principal(), (_rule(decision=RuleDecision.ALLOW),))

    assert (allowed_by_role.decision, allowed_by_role.reason) == (
        AccessDecision.ALLOW,
        EvaluationReason.LEGACY_ROLE_ALLOW,
    )
    assert removed_by_rule.decision is AccessDecision.DENY
    assert removed_by_rule.reason is EvaluationReason.RULE_DENY
    assert granted_by_rule.decision is AccessDecision.ALLOW
    assert granted_by_rule.reason is EvaluationReason.RULE_ALLOW


def test_direct_subject_beats_group_role_and_everyone_at_same_scope() -> None:
    role_id = uuid4()
    group_id = uuid4()
    principal = _principal(role_id=role_id, group_ids=frozenset({group_id}))
    direct = _rule(
        subject_kind=SubjectKind.USER,
        subject_id=principal.id,
        decision=RuleDecision.ALLOW,
    )

    result = _evaluate(
        principal,
        (
            _rule(decision=RuleDecision.DENY),
            _rule(subject_kind=SubjectKind.ROLE, subject_id=role_id, decision=RuleDecision.DENY),
            _rule(subject_kind=SubjectKind.GROUP, subject_id=group_id, decision=RuleDecision.DENY),
            direct,
        ),
    )

    assert result.decision is AccessDecision.ALLOW
    assert result.source_rule_id == direct.id


def test_group_deny_wins_an_equal_priority_group_conflict() -> None:
    first_group, second_group = uuid4(), uuid4()
    principal = _principal(group_ids=frozenset({first_group, second_group}))
    deny = _rule(subject_kind=SubjectKind.GROUP, subject_id=first_group, decision=RuleDecision.DENY)

    result = _evaluate(
        principal,
        (
            _rule(subject_kind=SubjectKind.GROUP, subject_id=second_group),
            deny,
        ),
    )

    assert result.decision is AccessDecision.DENY
    assert result.source_rule_id == deny.id


def test_deepest_scope_wins_and_inherit_contributes_no_local_decision() -> None:
    department_id = uuid4()
    module_id = uuid4()
    principal = _principal()
    module_allow = _rule(
        scope_kind=ScopeKind.MODULE,
        scope_id=module_id,
        decision=RuleDecision.ALLOW,
    )

    result = _evaluate(
        principal,
        (
            _rule(decision=RuleDecision.DENY),
            _rule(
                scope_kind=ScopeKind.DEPARTMENT,
                scope_id=department_id,
                decision=RuleDecision.INHERIT,
            ),
            module_allow,
        ),
        _path(department_id=department_id, module_id=module_id),
    )

    assert result.decision is AccessDecision.ALLOW
    assert result.source_rule_id == module_allow.id


def test_broadest_locked_ancestor_suppresses_descendant_rules() -> None:
    department_id = uuid4()
    module_id = uuid4()
    principal = _principal()
    workspace_allow = _rule(decision=RuleDecision.ALLOW, locked=True)

    result = _evaluate(
        principal,
        (
            workspace_allow,
            _rule(
                scope_kind=ScopeKind.DEPARTMENT,
                scope_id=department_id,
                decision=RuleDecision.DENY,
                locked=True,
            ),
            _rule(scope_kind=ScopeKind.MODULE, scope_id=module_id, decision=RuleDecision.DENY),
        ),
        _path(department_id=department_id, module_id=module_id),
    )

    assert result.decision is AccessDecision.ALLOW
    assert result.source_rule_id == workspace_allow.id


@pytest.mark.parametrize(
    ("legacy_capabilities", "descendant_decision", "expected"),
    [
        (frozenset(), RuleDecision.ALLOW, AccessDecision.DENY),
        (frozenset({CAPABILITY}), RuleDecision.DENY, AccessDecision.ALLOW),
    ],
)
def test_locked_inherit_ancestor_uses_the_broader_baseline(
    legacy_capabilities: frozenset[str],
    descendant_decision: RuleDecision,
    expected: AccessDecision,
) -> None:
    department_id = uuid4()
    module_id = uuid4()
    principal = _principal(legacy_capabilities=legacy_capabilities)

    result = _evaluate(
        principal,
        (
            _rule(
                scope_kind=ScopeKind.DEPARTMENT,
                scope_id=department_id,
                decision=RuleDecision.INHERIT,
                locked=True,
            ),
            _rule(
                scope_kind=ScopeKind.MODULE,
                scope_id=module_id,
                decision=descendant_decision,
            ),
        ),
        _path(department_id=department_id, module_id=module_id),
    )

    assert result.decision is expected
    assert result.source_rule_id is None


def test_time_window_uses_inclusive_start_and_exclusive_end() -> None:
    principal = _principal()
    start_allow = _rule(starts_at=NOW, ends_at=NOW + timedelta(minutes=1))
    ending_allow = _rule(starts_at=NOW - timedelta(minutes=1), ends_at=NOW)

    assert _evaluate(principal, (start_allow,)).decision is AccessDecision.ALLOW
    assert _evaluate(principal, (ending_allow,)).decision is AccessDecision.DENY


def test_relevant_invalid_reference_fails_closed_but_unrelated_invalid_rule_is_ignored() -> None:
    group_id = uuid4()
    principal = _principal(group_ids=frozenset({group_id}))
    relevant = _rule(
        subject_kind=SubjectKind.GROUP,
        subject_id=group_id,
        reference_valid=False,
    )
    unrelated = _rule(
        subject_kind=SubjectKind.GROUP,
        subject_id=uuid4(),
        reference_valid=False,
    )

    denied = _evaluate(principal, (relevant,))
    allowed = _evaluate(principal, (unrelated, _rule()))

    assert (denied.decision, denied.invalid) == (AccessDecision.DENY, True)
    assert denied.reason is EvaluationReason.INVALID_RULE
    assert allowed.decision is AccessDecision.ALLOW
    assert allowed.invalid is False


def test_deleted_rule_with_malformed_version_is_ignored_without_raising() -> None:
    deleted = replace(
        _rule(),
        is_deleted=True,
        policy_version=cast(int, None),
    )

    result = _evaluate(_principal(), (deleted,))

    assert (result.decision, result.reason, result.invalid) == (
        AccessDecision.DENY,
        EvaluationReason.DEFAULT_DENY,
        False,
    )


@pytest.mark.parametrize(
    "rule",
    [
        _rule(starts_at=datetime(2026, 9, 23, 9, 0)),
        _rule(starts_at=NOW, ends_at=NOW),
        replace(
            _rule(subject_kind=SubjectKind.GROUP, subject_id=uuid4()),
            subject_id=None,
        ),
        replace(_rule(), scope_id=uuid4()),
        replace(_rule(), scope_kind=cast(ScopeKind, "boards")),
    ],
)
def test_relevant_malformed_or_unsupported_rule_fails_closed(rule: AccessRuleCandidate) -> None:
    principal = _principal(
        group_ids=frozenset({rule.subject_id})
        if rule.subject_kind is SubjectKind.GROUP and isinstance(rule.subject_id, UUID)
        else frozenset()
    )

    result = _evaluate(principal, (rule,))

    assert (result.decision, result.reason, result.invalid) == (
        AccessDecision.DENY,
        EvaluationReason.INVALID_RULE,
        True,
    )


@pytest.mark.parametrize(
    ("capability", "path"),
    [
        ("boards.read", _path()),
        (CAPABILITY, (ScopePathNode(kind=ScopeKind.MODULE, id=uuid4()),)),
    ],
)
def test_unknown_capability_or_malformed_or_unsupported_scope_path_fails_closed(
    capability: str, path: tuple[ScopePathNode, ...]
) -> None:
    result = evaluate_access(
        principal=_principal(),
        capability=capability,
        scope_path=path,
        rules=(),
        now=NOW,
        policy_version=1,
    )

    assert (result.decision, result.invalid) == (AccessDecision.DENY, True)
    assert result.reason is EvaluationReason.INVALID_INPUT


def test_result_has_safe_trace_source_and_highest_observed_policy_version() -> None:
    principal = _principal()
    rule = _rule(policy_version=7)

    result = _evaluate(principal, (rule,), policy_version=3)

    assert result.source_rule_id == rule.id
    assert result.policy_version == 7
    assert result.trace
    trace_field_names = {field.name for field in fields(result.trace[0])}
    assert "name" not in trace_field_names
    assert "secret" not in trace_field_names
