"""Fail-closed input and principal-boundary contracts for Access evaluation."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import UUID, uuid4

import pytest

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

NOW = datetime(2026, 9, 23, 9, 0, tzinfo=UTC)
CAPABILITY = "records.read"
_DEFAULT = object()


def _principal(
    *,
    kind: PrincipalKind = PrincipalKind.USER,
    principal_id: UUID | None = None,
    role_name: str | None = "member",
    role_id: UUID | None = None,
    group_ids: frozenset[UUID] = frozenset(),
    legacy_capabilities: frozenset[str] = frozenset(),
) -> PolicyPrincipal:
    return PolicyPrincipal(
        id=principal_id or uuid4(),
        kind=kind,
        is_active=True,
        is_deleted=False,
        expires_at=None,
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
    *,
    principal: object = _DEFAULT,
    scope_path: object = _DEFAULT,
    rules: object = (),
    now: object = NOW,
    policy_version: object = 1,
) -> PolicyEvaluation:
    return evaluate_access(
        principal=cast(PolicyPrincipal, _principal() if principal is _DEFAULT else principal),
        capability=CAPABILITY,
        scope_path=cast(
            tuple[ScopePathNode, ...], _path() if scope_path is _DEFAULT else scope_path
        ),
        rules=cast(tuple[AccessRuleCandidate, ...], rules),
        now=cast(datetime, now),
        policy_version=cast(int, policy_version),
    )


@pytest.mark.parametrize(
    ("now", "policy_version"),
    [
        pytest.param(datetime(2026, 9, 23, 9, 0), 1, id="naive-clock"),
        pytest.param(NOW, 0, id="zero-revision"),
        pytest.param(NOW, True, id="boolean-revision"),
    ],
)
def test_invalid_clock_or_revision_fails_closed(now: datetime, policy_version: int) -> None:
    result = _evaluate(now=now, policy_version=policy_version)

    assert (result.decision, result.reason, result.invalid, result.policy_version) == (
        AccessDecision.DENY,
        EvaluationReason.INVALID_INPUT,
        True,
        0,
    )


@pytest.mark.parametrize(
    "principal",
    [
        pytest.param(object(), id="wrong-principal-type"),
        pytest.param(replace(_principal(), id=cast(UUID, None)), id="missing-id"),
        pytest.param(replace(_principal(), kind=cast(PrincipalKind, "robot")), id="unknown-kind"),
        pytest.param(replace(_principal(), is_active=cast(bool, 1)), id="non-boolean-state"),
        pytest.param(
            replace(_principal(), expires_at=datetime(2026, 9, 23, 9, 0)),
            id="naive-expiry",
        ),
        pytest.param(replace(_principal(), role_id=cast(UUID, None)), id="missing-role"),
        pytest.param(replace(_principal(), role_name=cast(str, 4)), id="invalid-role-name"),
        pytest.param(
            replace(_principal(), group_ids=cast(frozenset[UUID], {uuid4()})),
            id="mutable-group-set",
        ),
        pytest.param(
            replace(_principal(), group_ids=frozenset({cast(UUID, 4)})),
            id="invalid-group-id",
        ),
        pytest.param(
            replace(_principal(), legacy_capabilities=frozenset({"unknown.read"})),
            id="unknown-role-capability",
        ),
    ],
)
def test_malformed_principal_fails_closed(principal: object) -> None:
    result = _evaluate(principal=principal)

    assert (result.decision, result.reason, result.invalid) == (
        AccessDecision.DENY,
        EvaluationReason.INVALID_INPUT,
        True,
    )


@pytest.mark.parametrize(
    "path",
    [
        pytest.param(None, id="non-iterable"),
        pytest.param((), id="empty"),
        pytest.param(
            tuple(ScopePathNode(ScopeKind.WORKSPACE, None) for _ in range(5)), id="too-deep"
        ),
        pytest.param((None,), id="invalid-node"),
        pytest.param((ScopePathNode(ScopeKind.DEPARTMENT, uuid4()),), id="missing-workspace"),
        pytest.param((ScopePathNode(ScopeKind.WORKSPACE, uuid4()),), id="workspace-has-id"),
        pytest.param(
            (ScopePathNode(ScopeKind.WORKSPACE, None), ScopePathNode(ScopeKind.DEPARTMENT, None)),
            id="child-missing-id",
        ),
        pytest.param(
            (ScopePathNode(ScopeKind.WORKSPACE, None), ScopePathNode(ScopeKind.MODULE, uuid4())),
            id="skipped-parent",
        ),
    ],
)
def test_malformed_scope_path_fails_closed(path: object) -> None:
    result = _evaluate(scope_path=path)

    assert (result.decision, result.reason, result.invalid) == (
        AccessDecision.DENY,
        EvaluationReason.INVALID_INPUT,
        True,
    )


def test_non_iterable_rule_snapshot_fails_closed() -> None:
    result = _evaluate(rules=None)

    assert (result.decision, result.reason, result.invalid) == (
        AccessDecision.DENY,
        EvaluationReason.INVALID_INPUT,
        True,
    )


def test_irrelevant_permission_and_scope_corruption_cannot_change_a_valid_decision() -> None:
    department_id = uuid4()
    module_id = uuid4()
    principal = _principal()
    workspace_allow = _rule()
    other_permission = replace(
        _rule(), permission_id="records.write", decision=cast(RuleDecision, "invalid")
    )
    other_module = _rule(
        scope_kind=ScopeKind.MODULE,
        scope_id=uuid4(),
        reference_valid=False,
    )
    absent_field = _rule(scope_kind=ScopeKind.FIELD, scope_id=uuid4(), reference_valid=False)

    result = _evaluate(
        principal=principal,
        rules=(workspace_allow, other_permission, other_module, absent_field),
        scope_path=_path(department_id=department_id, module_id=module_id),
    )

    assert (result.decision, result.reason, result.source_rule_id, result.invalid) == (
        AccessDecision.ALLOW,
        EvaluationReason.RULE_ALLOW,
        workspace_allow.id,
        False,
    )


@pytest.mark.parametrize(
    "rule",
    [
        pytest.param(None, id="not-a-rule"),
        pytest.param(
            replace(_rule(), subject_kind=cast(SubjectKind, "team")),
            id="unknown-subject-kind",
        ),
        pytest.param(_rule(subject_id=uuid4()), id="everyone-has-subject-id"),
        pytest.param(
            _rule(scope_kind=ScopeKind.MODULE, scope_id=None),
            id="missing-module-scope-id",
        ),
    ],
)
def test_relevant_malformed_rule_fails_closed(rule: object) -> None:
    module_id = uuid4()
    path = _path(department_id=uuid4(), module_id=module_id)
    result = _evaluate(rules=(rule,), scope_path=path)

    assert (result.decision, result.reason, result.invalid) == (
        AccessDecision.DENY,
        EvaluationReason.INVALID_RULE,
        True,
    )


@pytest.mark.parametrize(
    "rule",
    [
        pytest.param(replace(_rule(), id=cast(UUID, None)), id="missing-rule-id"),
        pytest.param(replace(_rule(), is_deleted=cast(bool, None)), id="invalid-delete-state"),
        pytest.param(
            replace(_rule(), reference_valid=cast(bool, None)), id="invalid-reference-state"
        ),
        pytest.param(replace(_rule(), decision=cast(RuleDecision, "allow")), id="invalid-decision"),
        pytest.param(replace(_rule(), locked=cast(bool, 1)), id="invalid-lock-state"),
        pytest.param(replace(_rule(), policy_version=0), id="invalid-rule-revision"),
        pytest.param(
            replace(_rule(), ends_at=datetime(2026, 9, 23, 10, 0)),
            id="naive-window-end",
        ),
    ],
)
def test_relevant_corrupt_rule_metadata_denies_without_losing_policy_revision(
    rule: AccessRuleCandidate,
) -> None:
    result = _evaluate(rules=(rule,), policy_version=3)

    assert (result.decision, result.reason, result.invalid, result.policy_version) == (
        AccessDecision.DENY,
        EvaluationReason.INVALID_RULE,
        True,
        3,
    )
    assert result.source_rule_id is None


def test_future_allow_rule_is_inactive_until_its_start_instant() -> None:
    future = _rule(starts_at=NOW + timedelta(minutes=1), policy_version=7)

    result = _evaluate(rules=(future,), policy_version=3)

    assert (result.decision, result.reason, result.invalid, result.policy_version) == (
        AccessDecision.DENY,
        EvaluationReason.DEFAULT_DENY,
        False,
        7,
    )
    assert result.source_rule_id is None


def test_service_subject_grant_matches_only_its_service_identity() -> None:
    service = _principal(kind=PrincipalKind.SERVICE, role_name="automation")
    user_rule = _rule(subject_kind=SubjectKind.USER, subject_id=service.id)
    service_rule = _rule(subject_kind=SubjectKind.SERVICE, subject_id=service.id)

    denied = _evaluate(principal=service, rules=(user_rule,))
    allowed = _evaluate(principal=service, rules=(service_rule,))

    assert (denied.decision, denied.reason, denied.source_rule_id) == (
        AccessDecision.DENY,
        EvaluationReason.DEFAULT_DENY,
        None,
    )
    assert (allowed.decision, allowed.reason, allowed.source_rule_id) == (
        AccessDecision.ALLOW,
        EvaluationReason.RULE_ALLOW,
        service_rule.id,
    )
