"""Pure, fail-closed evaluator for persisted Access policy rules."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from app.systems.access.users.permissions import ALL_CAPABILITIES


class PrincipalKind(StrEnum):
    USER = "user"
    SERVICE = "service"


class SubjectKind(StrEnum):
    EVERYONE = "everyone"
    ROLE = "role"
    GROUP = "group"
    USER = "user"
    SERVICE = "service"


class ScopeKind(StrEnum):
    WORKSPACE = "workspace"
    DEPARTMENT = "department"
    MODULE = "module"
    FIELD = "field"


class RuleDecision(StrEnum):
    INHERIT = "inherit"
    ALLOW = "allow"
    DENY = "deny"


class AccessDecision(StrEnum):
    ALLOW = "allow"
    DENY = "deny"


class EvaluationReason(StrEnum):
    ADMINISTRATOR_PROTECTED = "administrator_protected"
    PRINCIPAL_INACTIVE = "principal_inactive"
    PRINCIPAL_DELETED = "principal_deleted"
    PRINCIPAL_EXPIRED = "principal_expired"
    INVALID_INPUT = "invalid_input"
    INVALID_RULE = "invalid_rule"
    RULE_ALLOW = "rule_allow"
    RULE_DENY = "rule_deny"
    LEGACY_ROLE_ALLOW = "legacy_role_allow"
    DEFAULT_DENY = "default_deny"


@dataclass(frozen=True, slots=True)
class PolicyPrincipal:
    id: UUID
    kind: PrincipalKind
    is_active: bool
    is_deleted: bool
    expires_at: datetime | None
    role_id: UUID
    role_name: str | None
    group_ids: frozenset[UUID]
    legacy_capabilities: frozenset[str]


@dataclass(frozen=True, slots=True)
class ScopePathNode:
    kind: ScopeKind
    id: UUID | None


@dataclass(frozen=True, slots=True)
class AccessRuleCandidate:
    id: UUID
    subject_kind: SubjectKind
    subject_id: UUID | None
    scope_kind: ScopeKind
    scope_id: UUID | None
    permission_id: str
    decision: RuleDecision
    starts_at: datetime | None
    ends_at: datetime | None
    locked: bool
    policy_version: int
    reference_valid: bool
    is_deleted: bool = False


@dataclass(frozen=True, slots=True)
class PolicyTraceEntry:
    reason: EvaluationReason
    scope_kind: ScopeKind | None
    decision: AccessDecision | None
    rule_id: UUID | None


@dataclass(frozen=True, slots=True)
class PolicyEvaluation:
    decision: AccessDecision
    reason: EvaluationReason
    policy_version: int
    source_rule_id: UUID | None
    invalid: bool
    trace: tuple[PolicyTraceEntry, ...]


@dataclass(frozen=True, slots=True)
class _MatchedRule:
    rule: AccessRuleCandidate
    depth: int


_KNOWN_CAPABILITIES = frozenset(ALL_CAPABILITIES)
_SCOPE_ORDER = (
    ScopeKind.WORKSPACE,
    ScopeKind.DEPARTMENT,
    ScopeKind.MODULE,
    ScopeKind.FIELD,
)
_SUBJECT_PRIORITY = {
    SubjectKind.EVERYONE: 0,
    SubjectKind.ROLE: 1,
    SubjectKind.GROUP: 2,
    SubjectKind.USER: 3,
    SubjectKind.SERVICE: 3,
}


def evaluate_access(
    *,
    principal: PolicyPrincipal,
    capability: str,
    scope_path: Iterable[ScopePathNode],
    rules: Iterable[AccessRuleCandidate],
    now: datetime,
    policy_version: int,
) -> PolicyEvaluation:
    """Evaluate one capability at an ordered scope path without database or HTTP access."""

    if not _is_aware(now) or not _is_positive_int(policy_version):
        return _invalid_input_result()
    if not isinstance(capability, str) or capability not in _KNOWN_CAPABILITIES:
        return _invalid_input_result(policy_version)

    path = _validated_path(scope_path)
    if path is None or not _is_valid_principal(principal, now):
        return _invalid_input_result(policy_version)

    lifecycle_result = _principal_lifecycle_result(principal, now, policy_version)
    if lifecycle_result is not None:
        return lifecycle_result
    if principal.kind is PrincipalKind.USER and principal.role_name == "admin":
        return PolicyEvaluation(
            decision=AccessDecision.ALLOW,
            reason=EvaluationReason.ADMINISTRATOR_PROTECTED,
            policy_version=policy_version,
            source_rule_id=None,
            invalid=False,
            trace=(
                PolicyTraceEntry(
                    reason=EvaluationReason.ADMINISTRATOR_PROTECTED,
                    scope_kind=None,
                    decision=AccessDecision.ALLOW,
                    rule_id=None,
                ),
            ),
        )

    candidates = _iter_candidates(rules)
    if candidates is None:
        return _invalid_input_result(policy_version)

    observed_version = policy_version
    matches: list[_MatchedRule] = []
    for rule in candidates:
        relevance = _rule_relevance(rule, capability, path, principal)
        if relevance is None:
            return _invalid_rule_result(observed_version)
        if relevance is False:
            continue

        valid, active = _validate_relevant_rule(rule, now)
        if not valid:
            return _invalid_rule_result(max(observed_version, _safe_rule_version(rule)))
        if not rule.is_deleted:
            observed_version = max(observed_version, rule.policy_version)
        if active:
            matches.append(_MatchedRule(rule=rule, depth=relevance))

    return _resolve_matches(principal, capability, matches, observed_version)


def _validated_path(scope_path: Iterable[ScopePathNode]) -> tuple[ScopePathNode, ...] | None:
    try:
        path = tuple(scope_path)
    except TypeError:
        return None
    if not path or len(path) > len(_SCOPE_ORDER):
        return None
    for index, node in enumerate(path):
        if not isinstance(node, ScopePathNode) or node.kind is not _SCOPE_ORDER[index]:
            return None
        if index == 0:
            if node.id is not None:
                return None
        elif not isinstance(node.id, UUID):
            return None
    return path


def _is_valid_principal(principal: object, now: datetime) -> bool:
    if not isinstance(principal, PolicyPrincipal):
        return False
    if not isinstance(principal.id, UUID) or not isinstance(principal.kind, PrincipalKind):
        return False
    if type(principal.is_active) is not bool or type(principal.is_deleted) is not bool:
        return False
    if principal.expires_at is not None and not _is_aware(principal.expires_at):
        return False
    if not isinstance(principal.role_id, UUID):
        return False
    if principal.role_name is not None and not isinstance(principal.role_name, str):
        return False
    if not isinstance(principal.group_ids, frozenset) or not all(
        isinstance(group_id, UUID) for group_id in principal.group_ids
    ):
        return False
    if not isinstance(principal.legacy_capabilities, frozenset) or not all(
        isinstance(item, str) and item in _KNOWN_CAPABILITIES
        for item in principal.legacy_capabilities
    ):
        return False
    return _is_aware(now)


def _principal_lifecycle_result(
    principal: PolicyPrincipal, now: datetime, policy_version: int
) -> PolicyEvaluation | None:
    reason: EvaluationReason | None = None
    if principal.is_deleted:
        reason = EvaluationReason.PRINCIPAL_DELETED
    elif not principal.is_active:
        reason = EvaluationReason.PRINCIPAL_INACTIVE
    elif principal.expires_at is not None and principal.expires_at <= now:
        reason = EvaluationReason.PRINCIPAL_EXPIRED
    if reason is None:
        return None
    return PolicyEvaluation(
        decision=AccessDecision.DENY,
        reason=reason,
        policy_version=policy_version,
        source_rule_id=None,
        invalid=False,
        trace=(
            PolicyTraceEntry(
                reason=reason,
                scope_kind=None,
                decision=AccessDecision.DENY,
                rule_id=None,
            ),
        ),
    )


def _iter_candidates(
    rules: Iterable[AccessRuleCandidate],
) -> tuple[AccessRuleCandidate, ...] | None:
    try:
        return tuple(rules)
    except TypeError:
        return None


def _rule_relevance(
    rule: object,
    capability: str,
    path: tuple[ScopePathNode, ...],
    principal: PolicyPrincipal,
) -> int | bool | None:
    if not isinstance(rule, AccessRuleCandidate):
        return None
    if rule.permission_id != capability:
        return False
    if not isinstance(rule.scope_kind, ScopeKind):
        return None

    depth = _scope_depth(rule, path)
    if depth is None:
        return False
    if depth is False:
        return None
    if not isinstance(rule.subject_kind, SubjectKind):
        return None
    if not _has_valid_subject_shape(rule):
        return None
    if not _subject_matches(rule, principal):
        return False
    return depth


def _scope_depth(rule: AccessRuleCandidate, path: tuple[ScopePathNode, ...]) -> int | bool | None:
    for depth, node in enumerate(path):
        if rule.scope_kind is not node.kind:
            continue
        if node.kind is ScopeKind.WORKSPACE:
            return depth if rule.scope_id is None else False
        if not isinstance(rule.scope_id, UUID):
            return False
        return depth if rule.scope_id == node.id else None
    return None


def _has_valid_subject_shape(rule: AccessRuleCandidate) -> bool:
    if rule.subject_kind is SubjectKind.EVERYONE:
        return rule.subject_id is None
    return isinstance(rule.subject_id, UUID)


def _subject_matches(rule: AccessRuleCandidate, principal: PolicyPrincipal) -> bool:
    if rule.subject_kind is SubjectKind.EVERYONE:
        return True
    if rule.subject_kind is SubjectKind.ROLE:
        return rule.subject_id == principal.role_id
    if rule.subject_kind is SubjectKind.GROUP:
        return rule.subject_id in principal.group_ids
    if rule.subject_kind is SubjectKind.USER:
        return principal.kind is PrincipalKind.USER and rule.subject_id == principal.id
    return principal.kind is PrincipalKind.SERVICE and rule.subject_id == principal.id


def _validate_relevant_rule(rule: AccessRuleCandidate, now: datetime) -> tuple[bool, bool]:
    if not isinstance(rule.id, UUID) or type(rule.is_deleted) is not bool:
        return False, False
    if rule.is_deleted:
        return True, False
    if type(rule.reference_valid) is not bool or not rule.reference_valid:
        return False, False
    if not isinstance(rule.decision, RuleDecision) or type(rule.locked) is not bool:
        return False, False
    if not _is_positive_int(rule.policy_version):
        return False, False
    if rule.starts_at is not None and not _is_aware(rule.starts_at):
        return False, False
    if rule.ends_at is not None and not _is_aware(rule.ends_at):
        return False, False
    if rule.starts_at is not None and rule.ends_at is not None and rule.starts_at >= rule.ends_at:
        return False, False
    if rule.starts_at is not None and now < rule.starts_at:
        return True, False
    if rule.ends_at is not None and now >= rule.ends_at:
        return True, False
    return True, True


def _resolve_matches(
    principal: PolicyPrincipal,
    capability: str,
    matches: list[_MatchedRule],
    observed_version: int,
) -> PolicyEvaluation:
    if matches:
        lock_depths = [match.depth for match in matches if match.rule.locked]
        if lock_depths:
            broadest_lock = min(lock_depths)
            matches = [match for match in matches if match.depth <= broadest_lock]
        decisive_matches = [
            match for match in matches if match.rule.decision is not RuleDecision.INHERIT
        ]
        if not decisive_matches:
            return _baseline_result(principal, capability, observed_version)
        deepest = max(match.depth for match in decisive_matches)
        selected = _select_at_scope(
            [match.rule for match in decisive_matches if match.depth == deepest], principal
        )
        if selected is not None:
            decision, rule = selected
            reason = (
                EvaluationReason.RULE_ALLOW
                if decision is AccessDecision.ALLOW
                else EvaluationReason.RULE_DENY
            )
            return PolicyEvaluation(
                decision=decision,
                reason=reason,
                policy_version=observed_version,
                source_rule_id=rule.id,
                invalid=False,
                trace=(
                    PolicyTraceEntry(
                        reason=reason,
                        scope_kind=rule.scope_kind,
                        decision=decision,
                        rule_id=rule.id,
                    ),
                ),
            )
    return _baseline_result(principal, capability, observed_version)


def _baseline_result(
    principal: PolicyPrincipal, capability: str, observed_version: int
) -> PolicyEvaluation:
    if capability in principal.legacy_capabilities:
        return PolicyEvaluation(
            decision=AccessDecision.ALLOW,
            reason=EvaluationReason.LEGACY_ROLE_ALLOW,
            policy_version=observed_version,
            source_rule_id=None,
            invalid=False,
            trace=(
                PolicyTraceEntry(
                    reason=EvaluationReason.LEGACY_ROLE_ALLOW,
                    scope_kind=ScopeKind.WORKSPACE,
                    decision=AccessDecision.ALLOW,
                    rule_id=None,
                ),
            ),
        )
    return PolicyEvaluation(
        decision=AccessDecision.DENY,
        reason=EvaluationReason.DEFAULT_DENY,
        policy_version=observed_version,
        source_rule_id=None,
        invalid=False,
        trace=(
            PolicyTraceEntry(
                reason=EvaluationReason.DEFAULT_DENY,
                scope_kind=None,
                decision=AccessDecision.DENY,
                rule_id=None,
            ),
        ),
    )


def _select_at_scope(
    rules: list[AccessRuleCandidate], principal: PolicyPrincipal
) -> tuple[AccessDecision, AccessRuleCandidate] | None:
    applicable = [
        rule
        for rule in rules
        if rule.subject_kind is not SubjectKind.USER or principal.kind is PrincipalKind.USER
    ]
    if not applicable:
        return None
    priority = max(_SUBJECT_PRIORITY[rule.subject_kind] for rule in applicable)
    candidates = [rule for rule in applicable if _SUBJECT_PRIORITY[rule.subject_kind] == priority]
    deny_rules = [rule for rule in candidates if rule.decision is RuleDecision.DENY]
    chosen = _lowest_rule_id(deny_rules or candidates)
    decision = AccessDecision.DENY if deny_rules else AccessDecision.ALLOW
    return decision, chosen


def _lowest_rule_id(rules: list[AccessRuleCandidate]) -> AccessRuleCandidate:
    return min(rules, key=lambda rule: str(rule.id))


def _is_aware(value: object) -> bool:
    return (
        isinstance(value, datetime) and value.tzinfo is not None and value.utcoffset() is not None
    )


def _is_positive_int(value: object) -> bool:
    return type(value) is int and value > 0


def _safe_rule_version(rule: AccessRuleCandidate) -> int:
    return rule.policy_version if _is_positive_int(rule.policy_version) else 0


def _invalid_input_result(policy_version: int = 0) -> PolicyEvaluation:
    return _invalid_result(
        EvaluationReason.INVALID_INPUT, policy_version if _is_positive_int(policy_version) else 0
    )


def _invalid_rule_result(policy_version: int) -> PolicyEvaluation:
    return _invalid_result(EvaluationReason.INVALID_RULE, policy_version)


def _invalid_result(reason: EvaluationReason, policy_version: int) -> PolicyEvaluation:
    return PolicyEvaluation(
        decision=AccessDecision.DENY,
        reason=reason,
        policy_version=policy_version,
        source_rule_id=None,
        invalid=True,
        trace=(
            PolicyTraceEntry(
                reason=reason,
                scope_kind=None,
                decision=AccessDecision.DENY,
                rule_id=None,
            ),
        ),
    )
