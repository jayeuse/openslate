import { permissions } from "./model";
import { normalizeLegacyGrant } from "../adapters/adapters";
import type { AccessPolicyBundleV1 } from "./policy-bundle";
import {
  resolveEffectiveAccess,
  type AccessDecision,
  type AccessDefaults,
  type AccessRule,
  type AccessScopeRef,
  type EffectiveAccessPrerequisite,
  type EffectiveAccessResult,
} from "./policy";
import {
  activeAdminCount,
  findIdentity,
  getControllerIdentities,
  permissionCatalog,
  scopeCatalog,
  slug,
  type AccessControllerSnapshot,
  type AccessHealthFinding,
  type ResolveAccessInput,
} from "./controller-model";

export function knownPermission(id: string): boolean {
  return permissionCatalog.some((permission) => permission.id === id);
}

export function knownScope(
  scope: AccessScopeRef,
  state?: AccessControllerSnapshot,
): boolean {
  return [...scopeCatalog, ...(state?.federatedScopes ?? [])].some(
    (candidate) => candidate.id === scope.id && candidate.kind === scope.kind,
  );
}

export function compatibleRuleProduct(
  state: AccessControllerSnapshot,
  rule: Pick<AccessRule, "scope" | "permissionId">,
): boolean {
  const permission = permissionCatalog.find(
    (candidate) => candidate.id === rule.permissionId,
  );
  const scope = [...scopeCatalog, ...(state.federatedScopes ?? [])].find(
    (candidate) =>
      candidate.id === rule.scope.id && candidate.kind === rule.scope.kind,
  );
  return Boolean(permission && scope && permission.product === scope.product);
}

export function legacyGrantFor(
  scope: AccessScopeRef,
  permissionId: string,
): string | undefined {
  return permissions.find((grant) => {
    const normalized = normalizeLegacyGrant(grant);
    return (
      normalized?.scope.id === scope.id &&
      normalized.permissionId === permissionId
    );
  });
}

export function validRule(
  state: AccessControllerSnapshot,
  rule: AccessRule,
): string | null {
  if (!rule.id.trim()) return "Rules require an identifier.";
  if (!knownPermission(rule.permissionId))
    return "The rule permission is unknown.";
  if (!knownScope(rule.scope, state)) return "The rule scope is unknown.";
  if (!compatibleRuleProduct(state, rule))
    return "The rule permission is incompatible with its scope.";
  if (
    rule.subject.kind === "role" &&
    !state.roles.some((role) => role.id === (rule.subject as { id: string }).id)
  )
    return "The rule role is unknown.";
  if (
    rule.subject.kind === "group" &&
    !state.groups.some(
      (group) => group.id === (rule.subject as { id: string }).id,
    )
  )
    return "The rule group is unknown.";
  if (rule.subject.kind === "identity" && !findIdentity(state, rule.subject.id))
    return "The rule identity is unknown.";
  const starts =
    rule.startsAt === undefined ? undefined : Date.parse(rule.startsAt);
  const ends = rule.endsAt === undefined ? undefined : Date.parse(rule.endsAt);
  if (
    (starts !== undefined && !Number.isFinite(starts)) ||
    (ends !== undefined && !Number.isFinite(ends)) ||
    (starts !== undefined && ends !== undefined && starts >= ends)
  )
    return "The rule time window is invalid.";
  return null;
}

export function updateLegacyProjection(
  state: AccessControllerSnapshot,
  rule: AccessRule,
): void {
  if (rule.subject.kind !== "role") return;
  const roleId = rule.subject.id;
  const grant = legacyGrantFor(rule.scope, rule.permissionId);
  if (!grant || roleId === "sample-admin") return;
  state.roles = state.roles.map((role) =>
    role.id === roleId
      ? {
          ...role,
          grants:
            rule.decision === "allow"
              ? [...new Set([...role.grants, grant])]
              : role.grants.filter((item) => item !== grant),
        }
      : role,
  );
}

export function validateDefaults(
  state: AccessControllerSnapshot,
  defaults: AccessDefaults,
): string | null {
  if (!state.roles.some((role) => role.id === defaults.defaultRoleId))
    return "The default role is unknown.";
  if (
    defaults.defaultGroupIds.some(
      (id) => !state.groups.some((group) => group.id === id),
    )
  )
    return "A default group is unknown.";
  if (
    defaults.defaultDepartmentIds.some(
      (id) =>
        !scopeCatalog.some(
          (scope) => scope.kind === "department" && scope.id === id,
        ),
    )
  )
    return "A default department is unknown.";
  if (
    [
      defaults.invitationExpiryDays,
      defaults.guestDurationDays,
      defaults.serviceDurationDays,
    ].some((value) => !Number.isInteger(value) || value <= 0)
  )
    return "Default durations must be positive whole days.";
  if (
    !defaults.defaultDeny ||
    !defaults.requireGuestSponsor ||
    !defaults.requireServiceOwner
  )
    return "Protected default-deny, sponsor, and owner controls cannot be disabled.";
  return null;
}

export function previewHistoryRestore(
  state: AccessControllerSnapshot,
  historyId: string,
):
  | { ok: true; summary: string; bundle: AccessPolicyBundleV1 }
  | { ok: false; error: string } {
  const entry = state.history.find((item) => item.id === historyId);
  if (!entry?.restorable || !entry.policySnapshot)
    return {
      ok: false,
      error: "This history entry cannot restore policy configuration.",
    };
  return {
    ok: true,
    summary: `Restore policy configuration from ${entry.occurredAt}. Identities and sessions will not change.`,
    bundle: structuredClone(entry.policySnapshot),
  };
}

export function getAccessHealth(
  state: AccessControllerSnapshot,
  now: string,
  context?: {
    adminRoleId?: string | null;
    knownPermissionIds?: readonly string[];
  },
): AccessHealthFinding[] {
  const findings: AccessHealthFinding[] = [];
  const timestamp = Date.parse(now);
  const adminCount = activeAdminCount(
    state,
    context?.adminRoleId ?? "sample-admin",
    timestamp,
  );
  if (adminCount === 0)
    findings.push({
      id: "health:last-admin",
      kind: "last-admin",
      severity: "critical",
      title: "No active Administrator",
      detail: "Restore or assign one active internal Administrator.",
    });
  else if (adminCount === 1)
    findings.push({
      id: "health:last-admin",
      kind: "last-admin",
      severity: "warning",
      title: "Only one active Administrator",
      detail:
        "Assign a second active internal Administrator to reduce lockout risk.",
    });
  for (const identity of getControllerIdentities(state)) {
    if (
      identity.expiresAt &&
      (!Number.isFinite(Date.parse(identity.expiresAt)) ||
        Date.parse(identity.expiresAt) <= timestamp)
    )
      findings.push({
        id: `health:expiry:${identity.id}`,
        kind: "expiry",
        severity: "warning",
        title:
          identity.status === "pending"
            ? "Invitation expired"
            : "Identity access expired",
        detail: `${identity.name} requires review.`,
        targetId: identity.id,
      });
    else if (identity.status === "pending")
      findings.push({
        id: `health:invite:${identity.id}`,
        kind: "expiry",
        severity: "warning",
        title: "Invitation is pending",
        detail: `${identity.name} has not activated access.`,
        targetId: identity.id,
      });
    if (
      !state.roles.some((role) => role.id === identity.roleId) ||
      identity.groupIds.some(
        (id) => !state.groups.some((group) => group.id === id),
      )
    )
      findings.push({
        id: `health:identity-ref:${identity.id}`,
        kind: "invalid-reference",
        severity: "critical",
        title: "Identity has an invalid reference",
        detail: `${identity.name} references an unknown role or group.`,
        targetId: identity.id,
      });
    if (
      (identity.kind === "guest" &&
        !state.people.some((person) => person.id === identity.sponsorId)) ||
      (identity.kind === "service" &&
        !state.people.some((person) => person.id === identity.ownerId))
    )
      findings.push({
        id: `health:owner-ref:${identity.id}`,
        kind: "invalid-reference",
        severity: "critical",
        title: "Identity owner is invalid",
        detail: `${identity.name} references an unknown internal sponsor or owner.`,
        targetId: identity.id,
      });
  }
  for (const role of state.roles) {
    if (!role.builtin && role.grants.length === 0)
      findings.push({
        id: `health:empty-role:${role.id}`,
        kind: "empty",
        severity: "warning",
        title: "Role grants no access",
        detail: `${role.name} has no legacy grants.`,
        targetId: role.id,
      });
    if (
      role.grants.some((grant) =>
        context?.knownPermissionIds
          ? !context.knownPermissionIds.includes(grant)
          : normalizeLegacyGrant(grant) === null,
      )
    )
      findings.push({
        id: `health:legacy:${role.id}`,
        kind: "invalid-reference",
        severity: "warning",
        title: "Role has an unknown legacy grant",
        detail: `${role.name} contains a grant that cannot be projected safely.`,
        targetId: role.id,
      });
  }
  for (const group of state.groups)
    if (
      group.memberIds.some(
        (id) =>
          !state.people.some((person) => person.id === id) &&
          !state.guests.some((guest) => guest.id === id),
      )
    )
      findings.push({
        id: `health:group-ref:${group.id}`,
        kind: "invalid-reference",
        severity: "critical",
        title: "Group has an invalid member",
        detail: `${group.name} references an unknown or unsupported member.`,
        targetId: group.id,
      });
    else if (group.memberIds.length === 0)
      findings.push({
        id: `health:empty-group:${group.id}`,
        kind: "empty",
        severity: "warning",
        title: "Group is empty",
        detail: `${group.name} has no members.`,
        targetId: group.id,
      });
  for (const rule of state.rules) {
    const issue = validRule(state, rule);
    if (issue)
      findings.push({
        id: `health:rule:${rule.id}`,
        kind: "invalid-reference",
        severity: "critical",
        title: "Policy rule is invalid",
        detail: issue,
        targetId: rule.id,
      });
  }
  const groupRules = state.rules.filter(
    (
      rule,
    ): rule is AccessRule & {
      subject: { kind: "group"; id: string };
      decision: AccessDecision;
    } => rule.subject.kind === "group" && rule.decision !== "inherit",
  );
  for (let index = 0; index < groupRules.length; index += 1) {
    const left = groupRules[index];
    const conflict = groupRules
      .slice(index + 1)
      .find(
        (right) =>
          right.subject.id !== left.subject.id &&
          right.scope.id === left.scope.id &&
          right.permissionId === left.permissionId &&
          right.decision !== left.decision &&
          getControllerIdentities(state).some(
            (identity) =>
              identity.groupIds.includes(left.subject.id) &&
              identity.groupIds.includes(right.subject.id),
          ),
      );
    if (conflict)
      findings.push({
        id: `health:conflict:${left.id}:${conflict.id}`,
        kind: "conflict",
        severity: "warning",
        title: "Group policy conflict resolves to deny",
        detail:
          "An identity belongs to groups with equal-priority allow and deny rules.",
        targetId: left.id,
      });
  }
  return findings;
}

export function resolveControllerAccess(
  state: AccessControllerSnapshot,
  input: ResolveAccessInput,
): EffectiveAccessResult {
  const identity = findIdentity(state, input.identityId);
  const now = input.now ?? new Date().toISOString();
  const requiredVisibilityPermission =
    {
      "records.create": "scope.view",
      "records.write": "scope.view",
      "records.close": "scope.view",
      "records.purge": "scope.view",
      "action.create": "scope.view",
      "action.update": "scope.view",
      "action.close": "scope.view",
      "action.purge": "scope.view",
      "boards.edit": "boards.view",
      "boards.manage": "boards.view",
      "openview.edit": "openview.view",
      "comms.post": "comms.view",
      "comms.reply": "comms.view",
      "comms.manage": "comms.view",
    }[input.permissionId] ?? undefined;
  const knownScopePath =
    input.scopePath.length > 0 &&
    input.scopePath.every((scope) => knownScope(scope, state));
  const permissionKnown = knownPermission(input.permissionId);
  if (!identity) {
    const prerequisites: EffectiveAccessPrerequisite[] = [
      {
        id: "identity-lifecycle",
        label: "Identity lifecycle",
        passed: false,
        reason: "An unknown identity cannot satisfy lifecycle requirements.",
      },
      {
        id: "identity-expiry",
        label: "Identity expiry",
        passed: false,
        reason: "An unknown identity has no verifiable expiry state.",
      },
      {
        id: "known-role",
        label: "Known role",
        passed: false,
        reason: "An unknown identity has no recognized role.",
      },
      {
        id: "known-permission",
        label: "Known permission",
        passed: permissionKnown,
        reason: permissionKnown
          ? `Permission ${input.permissionId} is recognized.`
          : `Permission ${input.permissionId} is unknown.`,
      },
      {
        id: "known-scope-path",
        label: "Known scope path",
        passed: knownScopePath,
        reason: knownScopePath
          ? `All ${input.scopePath.length} scopes are recognized.`
          : "The resource scope path is empty or contains an unknown scope.",
      },
      {
        id: "required-permission",
        label: `Required permission · ${input.permissionId}`,
        passed: false,
        reason:
          "The required permission cannot be evaluated for an unknown identity.",
      },
    ];
    if (requiredVisibilityPermission)
      prerequisites.push({
        id: "scope-visibility",
        label: `Scope visibility · ${requiredVisibilityPermission}`,
        passed: false,
        reason: "Scope visibility cannot be evaluated for an unknown identity.",
      });
    return {
      decision: "deny",
      reason: "The identity is unknown.",
      prerequisites,
      trace: [],
      invalid: true,
    };
  }
  const scopeIds = new Set(input.scopePath.map((scope) => scope.id));
  const legacyRules: AccessRule[] = [];
  for (const role of state.roles) {
    for (const grant of role.grants) {
      const normalized = normalizeLegacyGrant(grant);
      if (!normalized || !scopeIds.has(normalized.scope.id)) continue;
      const permissionIds = [normalized.permissionId];
      if (normalized.permissionId.startsWith("action.")) {
        const action = normalized.permissionId.slice("action.".length);
        permissionIds.push(
          action === "read"
            ? "records.read"
            : action === "update"
              ? "records.write"
              : `records.${action}`,
        );
      }
      for (const permissionId of permissionIds)
        legacyRules.push({
          id: `legacy:${role.id}:${slug(grant)}:${permissionId}`,
          subject: { kind: "role", id: role.id },
          scope: normalized.scope,
          permissionId,
          decision: "allow",
        });
    }
  }
  const allRules = [...legacyRules, ...state.rules];
  const resolvePermission = (permissionId: string): EffectiveAccessResult => {
    const resolved = resolveEffectiveAccess({
      identity,
      permissionId,
      scopePath: input.scopePath,
      rules: allRules,
      groups: state.groups,
      knownPermissionIds: permissionCatalog.map((item) => item.id),
      knownScopeIds: [
        ...new Set([
          ...scopeCatalog.map((item) => item.id),
          ...(state.federatedScopes ?? []).map((item) => item.id),
        ]),
      ],
      knownRoleIds: state.roles.map((item) => item.id),
      knownIdentityIds: getControllerIdentities(state).map((item) => item.id),
      now,
    });
    const incompatible = allRules.find(
      (rule) =>
        rule.permissionId === permissionId &&
        scopeIds.has(rule.scope.id) &&
        knownScope(rule.scope, state) &&
        !compatibleRuleProduct(state, rule),
    );
    if (!incompatible) return resolved;
    return {
      decision: "deny",
      reason: `Policy rule ${incompatible.id} is incompatible with its scope.`,
      prerequisites: resolved.prerequisites,
      trace: resolved.trace,
      invalid: true,
    };
  };
  let required = resolvePermission(input.permissionId);
  const leafScope = input.scopePath.at(-1);
  if (
    leafScope &&
    knownScope(leafScope, state) &&
    !compatibleRuleProduct(state, {
      scope: leafScope,
      permissionId: input.permissionId,
    })
  )
    required = {
      decision: "deny",
      reason: "The permission is incompatible with the requested scope.",
      prerequisites: required.prerequisites,
      trace: required.trace,
      invalid: true,
    };
  const prerequisites: EffectiveAccessPrerequisite[] = [
    ...required.prerequisites,
    {
      id: "required-permission",
      label: `Required permission · ${input.permissionId}`,
      passed: required.decision === "allow",
      reason:
        required.decision === "allow"
          ? `${input.permissionId} is allowed.`
          : `${input.permissionId} is denied: ${required.reason}`,
    },
  ];
  if (!requiredVisibilityPermission) return { ...required, prerequisites };

  let visibility = resolvePermission(requiredVisibilityPermission);
  if (
    leafScope &&
    knownScope(leafScope, state) &&
    !compatibleRuleProduct(state, {
      scope: leafScope,
      permissionId: requiredVisibilityPermission,
    })
  )
    visibility = {
      decision: "deny",
      reason:
        "The visibility permission is incompatible with the requested scope.",
      prerequisites: visibility.prerequisites,
      trace: visibility.trace,
      invalid: true,
    };
  prerequisites.push({
    id: "scope-visibility",
    label: `Scope visibility · ${requiredVisibilityPermission}`,
    passed: visibility.decision === "allow",
    reason:
      visibility.decision === "allow"
        ? `${requiredVisibilityPermission} is allowed on the requested scope.`
        : `${requiredVisibilityPermission} is denied: ${visibility.reason}`,
  });
  if (required.decision === "deny") return { ...required, prerequisites };
  if (visibility.decision === "deny")
    return {
      decision: "deny",
      reason: `${requiredVisibilityPermission} is required before ${input.permissionId}.`,
      prerequisites,
      trace: required.trace,
      ...(visibility.invalid ? { invalid: true } : {}),
    };
  return { ...required, prerequisites };
}
