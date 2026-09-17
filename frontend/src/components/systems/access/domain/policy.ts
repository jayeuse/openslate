import { initialPeople, type Role } from "./model";

export type AccessIdentityStatus =
  "active" | "pending" | "disabled" | "deleted" | "revoked" | "suspended";

type AccessIdentityBase = {
  id: string;
  name: string;
  status: AccessIdentityStatus;
  roleId: string;
  groupIds: string[];
  expiresAt?: string;
};

export type InternalIdentity = AccessIdentityBase & {
  kind: "internal";
  email: string;
  departmentIds: string[];
  primaryDepartmentId: string;
  title: string;
};

export type GuestIdentity = AccessIdentityBase & {
  kind: "guest";
  email: string;
  sponsorId: string;
  expiresAt: string;
};

export type ServiceIdentity = AccessIdentityBase & {
  kind: "service";
  ownerId: string;
  purpose: string;
  expiresAt: string;
  credentialState?: "not-created" | "active" | "rotation-due";
};

export type AccessIdentity = InternalIdentity | GuestIdentity | ServiceIdentity;

export type AccessGroup = {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
};

export type AccessSubjectRef =
  { kind: "everyone" } | { kind: "role" | "group" | "identity"; id: string };

export type AccessScopeKind =
  | "workspace"
  | "department"
  | "module"
  | "field"
  | "board"
  | "openview"
  | "comms-category"
  | "comms-channel";

export type AccessScopeRef = { kind: AccessScopeKind; id: string };
export type AccessDecision = "inherit" | "allow" | "deny";

export type AccessRule = {
  id: string;
  subject: AccessSubjectRef;
  scope: AccessScopeRef;
  permissionId: string;
  decision: AccessDecision;
  locked?: boolean;
  startsAt?: string;
  endsAt?: string;
};

export type EffectiveAccessTraceEntry = {
  ruleId: string;
  outcome:
    AccessDecision | "expired" | "not-started" | "not-applicable" | "invalid";
  subject: AccessSubjectRef;
  scope: AccessScopeRef;
  scopeSpecificity: number;
  subjectPriority: number;
  selected: boolean;
  reason: string;
  overriddenByRuleId?: string;
};

export type EffectiveAccessPrerequisite = {
  id:
    | "identity-lifecycle"
    | "identity-expiry"
    | "known-role"
    | "known-permission"
    | "known-scope-path"
    | "required-permission"
    | "scope-visibility";
  label: string;
  passed: boolean;
  reason: string;
};

export type EffectiveAccessResult = {
  decision: "allow" | "deny";
  reason: string;
  invalid?: boolean;
  source?: { ruleId: string; locked: boolean };
  prerequisites: EffectiveAccessPrerequisite[];
  trace: EffectiveAccessTraceEntry[];
};

export type ResolveEffectiveAccessInput = {
  identity: AccessIdentity;
  permissionId: string;
  scopePath: readonly AccessScopeRef[];
  rules: readonly AccessRule[];
  groups: readonly AccessGroup[];
  knownPermissionIds: readonly string[];
  knownScopeIds: readonly string[];
  knownRoleIds: readonly string[];
  knownIdentityIds?: readonly string[];
  now: string;
  protectedAdministratorRoleId?: string;
};

export type AccessDefaults = {
  defaultRoleId: string;
  defaultDepartmentIds: string[];
  defaultGroupIds: string[];
  invitationExpiryDays: number;
  guestDurationDays: number;
  serviceDurationDays: number;
  defaultDeny: true;
  requireGuestSponsor: true;
  requireServiceOwner: true;
};

export type AccessTemplate = {
  id: string;
  name: string;
  description: string;
  identityKind: AccessIdentity["kind"];
  grants: string[];
};

export type AccessReview = {
  id: string;
  name: string;
  reviewerId: string;
  status: "draft" | "in-progress" | "complete";
  subjectKind: "role" | "group" | "identity-kind" | "expiry-window";
  subjectId: string;
  decisions: {
    targetId: string;
    decision: "pending" | "keep" | "change" | "revoke";
  }[];
};

export type AccessHistoryEntry = {
  id: string;
  actorId: string;
  target: string;
  occurredAt: string;
  summary: string;
  result: "applied" | "rejected" | "restored";
  restorable: boolean;
};

export type DeletedAccessIdentity = {
  identity: InternalIdentity;
  deletedAt: string;
  deletedBy: string;
};

export const initialAccessGroups: AccessGroup[] = [
  { id: "group:dispatch", name: "Dispatch", description: "", memberIds: [] },
  { id: "group:finance", name: "Finance", description: "", memberIds: [] },
];

export const initialAccessIdentities: AccessIdentity[] = initialPeople.map(
  (person) => ({
    kind: "internal",
    id: person.id,
    name: person.name,
    email: person.email,
    status: person.active ? "active" : "disabled",
    roleId: person.role,
    groupIds: [],
    departmentIds: person.departments.map(
      (name) => `department:${name.toLowerCase().replaceAll(" ", "-")}`,
    ),
    primaryDepartmentId: `department:${person.primary.toLowerCase().replaceAll(" ", "-")}`,
    title: person.title,
  }),
);

initialAccessIdentities.push(
  {
    kind: "guest",
    id: "guest:sample-vendor",
    name: "Vendor partner",
    email: "vendor@example.invalid",
    status: "active",
    roleId: "sample-member",
    groupIds: [],
    sponsorId: "sample-mara",
    expiresAt: "2026-12-31T16:00:00.000Z",
  },
  {
    kind: "service",
    id: "service:sample-reporting",
    name: "Reporting service",
    status: "active",
    roleId: "sample-member",
    groupIds: [],
    ownerId: "sample-mara",
    purpose: "Prepare workspace summaries",
    expiresAt: "2026-12-31T16:00:00.000Z",
  },
);

export const initialAccessDefaults: AccessDefaults = {
  defaultRoleId: "sample-member",
  defaultDepartmentIds: ["department:operations"],
  defaultGroupIds: [],
  invitationExpiryDays: 7,
  guestDurationDays: 30,
  serviceDurationDays: 90,
  defaultDeny: true,
  requireGuestSponsor: true,
  requireServiceOwner: true,
};

export const initialAccessRules: AccessRule[] = [
  {
    id: "rule:member-records-read",
    subject: { kind: "role", id: "sample-member" },
    scope: { kind: "workspace", id: "workspace" },
    permissionId: "records.read",
    decision: "allow",
  },
];
export const initialAccessTemplates: AccessTemplate[] = [
  {
    id: "template:viewer",
    name: "Viewer",
    description: "Read-only access to visible workspace resources.",
    identityKind: "internal",
    grants: ["Action · read"],
  },
  {
    id: "template:department-operator",
    name: "Department operator",
    description: "Operate within one assigned department.",
    identityKind: "internal",
    grants: [
      "Department · Operations",
      "Module · Service requests",
      "Action · read",
      "Action · update",
    ],
  },
  {
    id: "template:contractor-guest",
    name: "Contractor guest",
    description: "Temporary, sponsored read access.",
    identityKind: "guest",
    grants: ["Action · read"],
  },
  {
    id: "template:integration-reader",
    name: "Integration reader",
    description: "Time-bound read access for a service identity.",
    identityKind: "service",
    grants: ["Action · read"],
  },
  {
    id: "template:blank",
    name: "Blank",
    description: "Start from default deny.",
    identityKind: "internal",
    grants: [],
  },
];
export const initialAccessReviews: AccessReview[] = [];
export const initialAccessHistory: AccessHistoryEntry[] = [];
export const initialDeletedAccessIdentities: DeletedAccessIdentity[] = [];

function hasValidTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

export function validateAccessIdentity(identity: AccessIdentity): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!identity.roleId) issues.push("Identities require one role.");
  if (
    identity.expiresAt !== undefined &&
    !hasValidTimestamp(identity.expiresAt)
  )
    issues.push("Expiry must be a valid date and time.");

  if (identity.kind === "internal") {
    if (!identity.email.trim())
      issues.push("Internal identities require an email.");
    if (
      identity.primaryDepartmentId &&
      !identity.departmentIds.includes(identity.primaryDepartmentId)
    )
      issues.push("The primary department must be an assigned department.");
  } else if (identity.kind === "guest") {
    if (!identity.email.trim()) issues.push("Guests require an email.");
    if (!identity.sponsorId.trim())
      issues.push("Guests require an internal sponsor.");
    if (!identity.expiresAt.trim()) issues.push("Guests require an expiry.");
    if (identity.roleId === "sample-admin")
      issues.push("Guests cannot be administrators.");
  } else {
    if (!identity.ownerId.trim())
      issues.push("Services require an internal owner.");
    if (!identity.purpose.trim()) issues.push("Services require a purpose.");
    if (!identity.expiresAt.trim()) issues.push("Services require an expiry.");
    if (identity.roleId === "sample-admin")
      issues.push("Services cannot be administrators.");
    if (identity.groupIds.length)
      issues.push("Services cannot belong to groups.");
  }

  return { valid: issues.length === 0, issues };
}

function deny(
  reason: string,
  prerequisites: EffectiveAccessPrerequisite[],
  trace: EffectiveAccessTraceEntry[] = [],
  invalid = false,
): EffectiveAccessResult {
  return {
    decision: "deny",
    reason,
    prerequisites,
    trace,
    ...(invalid ? { invalid } : {}),
  };
}

function subjectPriority(subject: AccessSubjectRef): number {
  if (subject.kind === "identity") return 3;
  if (subject.kind === "group") return 2;
  if (subject.kind === "role") return 1;
  return 0;
}

function subjectApplies(
  subject: AccessSubjectRef,
  identity: AccessIdentity,
): boolean {
  if (subject.kind === "everyone") return true;
  if (subject.kind === "identity") return subject.id === identity.id;
  if (subject.kind === "role") return subject.id === identity.roleId;
  return identity.groupIds.includes(subject.id);
}

function chooseAtScope(rules: readonly AccessRule[]): {
  rule: AccessRule & { decision: "allow" | "deny" };
  conflict: boolean;
} {
  const highestPriority = Math.max(
    ...rules.map((item) => subjectPriority(item.subject)),
  );
  const candidates = rules.filter(
    (item): item is AccessRule & { decision: "allow" | "deny" } =>
      item.decision !== "inherit" &&
      subjectPriority(item.subject) === highestPriority,
  );
  const denied = candidates.find((item) => item.decision === "deny");
  return {
    rule: denied ?? candidates[0],
    conflict:
      candidates[0].subject.kind === "group" &&
      candidates.some((item) => item.decision === "allow") &&
      candidates.some((item) => item.decision === "deny"),
  };
}

function accessPrerequisites(
  input: ResolveEffectiveAccessInput,
): EffectiveAccessPrerequisite[] {
  const now = Date.parse(input.now);
  const expiresAt = input.identity.expiresAt
    ? Date.parse(input.identity.expiresAt)
    : undefined;
  const expiryPassed =
    Number.isFinite(now) &&
    (expiresAt === undefined ||
      (Number.isFinite(expiresAt) && expiresAt > now));
  const scopePathPassed =
    input.scopePath.length > 0 &&
    input.scopePath.every((scope) => input.knownScopeIds.includes(scope.id));
  return [
    {
      id: "identity-lifecycle",
      label: "Identity lifecycle",
      passed: input.identity.status === "active",
      reason:
        input.identity.status === "active"
          ? "Identity is active."
          : `Identity is ${input.identity.status}.`,
    },
    {
      id: "identity-expiry",
      label: "Identity expiry",
      passed: expiryPassed,
      reason: !Number.isFinite(now)
        ? "Evaluation time is invalid."
        : expiresAt === undefined
          ? "Identity access does not expire."
          : !Number.isFinite(expiresAt)
            ? "Identity expiry is invalid."
            : expiresAt <= now
              ? "Identity access is expired."
              : `Identity access is active until ${input.identity.expiresAt}.`,
    },
    {
      id: "known-role",
      label: "Known role",
      passed: input.knownRoleIds.includes(input.identity.roleId),
      reason: input.knownRoleIds.includes(input.identity.roleId)
        ? `Role ${input.identity.roleId} is recognized.`
        : `Role ${input.identity.roleId} is unknown.`,
    },
    {
      id: "known-permission",
      label: "Known permission",
      passed: input.knownPermissionIds.includes(input.permissionId),
      reason: input.knownPermissionIds.includes(input.permissionId)
        ? `Permission ${input.permissionId} is recognized.`
        : `Permission ${input.permissionId} is unknown.`,
    },
    {
      id: "known-scope-path",
      label: "Known scope path",
      passed: scopePathPassed,
      reason: scopePathPassed
        ? `All ${input.scopePath.length} scopes are recognized.`
        : "The resource scope path is empty or contains an unknown scope.",
    },
  ];
}

function makeTraceEntry(
  rule: AccessRule,
  outcome: EffectiveAccessTraceEntry["outcome"],
  scopeSpecificity: number,
  reason: string,
): EffectiveAccessTraceEntry {
  return {
    ruleId: rule.id,
    outcome,
    subject: structuredClone(rule.subject),
    scope: structuredClone(rule.scope),
    scopeSpecificity,
    subjectPriority: subjectPriority(rule.subject),
    selected: false,
    reason,
  };
}

export function resolveEffectiveAccess(
  input: ResolveEffectiveAccessInput,
): EffectiveAccessResult {
  const trace: EffectiveAccessTraceEntry[] = [];
  const prerequisites = accessPrerequisites(input);
  if (input.identity.status !== "active")
    return deny(`Identity is ${input.identity.status}.`, prerequisites, trace);

  const now = Date.parse(input.now);
  if (!Number.isFinite(now))
    return deny("The evaluation time is invalid.", prerequisites, trace, true);
  if (
    input.identity.expiresAt &&
    (!hasValidTimestamp(input.identity.expiresAt) ||
      Date.parse(input.identity.expiresAt) <= now)
  )
    return deny("Identity access is expired.", prerequisites, trace);

  if (!input.knownRoleIds.includes(input.identity.roleId))
    return deny("The identity role is unknown.", prerequisites, trace, true);
  if (!input.knownPermissionIds.includes(input.permissionId))
    return deny("The permission is unknown.", prerequisites, trace, true);
  if (
    input.scopePath.length === 0 ||
    input.scopePath.some((scope) => !input.knownScopeIds.includes(scope.id))
  )
    return deny("The resource scope is unknown.", prerequisites, trace, true);

  const administratorRoleId =
    input.protectedAdministratorRoleId ?? "sample-admin";
  if (input.identity.roleId === administratorRoleId)
    return {
      decision: "allow",
      reason: "Protected Administrator access.",
      prerequisites,
      trace,
    };

  const scopeIndexes = new Map(
    input.scopePath.map((scope, index) => [scope.id, index]),
  );
  const knownGroups = new Set(input.groups.map((group) => group.id));
  const knownIdentities = new Set([
    input.identity.id,
    ...(input.knownIdentityIds ?? []),
  ]);
  const active: AccessRule[] = [];

  for (const item of input.rules) {
    if (item.permissionId !== input.permissionId) continue;
    const scopeIndex = scopeIndexes.get(item.scope.id);
    const scopeKnown = input.knownScopeIds.includes(item.scope.id);
    const subjectKnown =
      item.subject.kind === "everyone" ||
      (item.subject.kind === "role" &&
        input.knownRoleIds.includes(item.subject.id)) ||
      (item.subject.kind === "group" && knownGroups.has(item.subject.id)) ||
      (item.subject.kind === "identity" &&
        knownIdentities.has(item.subject.id));
    if (!scopeKnown || !subjectKnown) {
      trace.push(
        makeTraceEntry(
          item,
          "invalid",
          scopeIndex ?? -1,
          "Rule references an unknown subject or scope.",
        ),
      );
      return deny(
        "A policy rule references an unknown subject or scope.",
        prerequisites,
        trace,
        true,
      );
    }
    if (scopeIndex === undefined) {
      trace.push(
        makeTraceEntry(
          item,
          "not-applicable",
          -1,
          "Rule scope is outside the requested resource path.",
        ),
      );
      continue;
    }
    if (!subjectApplies(item.subject, input.identity)) {
      trace.push(
        makeTraceEntry(
          item,
          "not-applicable",
          scopeIndex,
          "Rule subject does not apply to this identity.",
        ),
      );
      continue;
    }
    if (item.decision === "inherit") {
      trace.push(
        makeTraceEntry(
          item,
          "inherit",
          scopeIndex,
          "Rule inherits from broader policy.",
        ),
      );
      continue;
    }
    if (item.startsAt) {
      const startsAt = Date.parse(item.startsAt);
      if (!Number.isFinite(startsAt)) {
        trace.push(
          makeTraceEntry(
            item,
            "invalid",
            scopeIndex,
            "Rule start time is invalid.",
          ),
        );
        return deny(
          "A policy rule has an invalid time window.",
          prerequisites,
          trace,
          true,
        );
      }
      if (startsAt > now) {
        trace.push(
          makeTraceEntry(
            item,
            "not-started",
            scopeIndex,
            "Rule time window has not started.",
          ),
        );
        continue;
      }
    }
    if (item.endsAt) {
      const endsAt = Date.parse(item.endsAt);
      if (!Number.isFinite(endsAt)) {
        trace.push(
          makeTraceEntry(
            item,
            "invalid",
            scopeIndex,
            "Rule end time is invalid.",
          ),
        );
        return deny(
          "A policy rule has an invalid time window.",
          prerequisites,
          trace,
          true,
        );
      }
      if (endsAt <= now) {
        trace.push(
          makeTraceEntry(
            item,
            "expired",
            scopeIndex,
            "Rule time window has expired.",
          ),
        );
        continue;
      }
    }
    trace.push(
      makeTraceEntry(
        item,
        item.decision,
        scopeIndex,
        "Applicable rule awaiting precedence evaluation.",
      ),
    );
    active.push(item);
  }

  const locked = active.filter(
    (item) =>
      item.locked &&
      (scopeIndexes.get(item.scope.id) ?? input.scopePath.length) <
        input.scopePath.length - 1,
  );
  const candidates = locked.length ? locked : active;
  if (!candidates.length)
    return deny("No rule allowed access; default deny.", prerequisites, trace);

  const selectedScopeIndex = (locked.length ? Math.min : Math.max)(
    ...candidates.map((item) => scopeIndexes.get(item.scope.id) ?? -1),
  );
  const atScope = candidates.filter(
    (item) => scopeIndexes.get(item.scope.id) === selectedScopeIndex,
  );
  const selected = chooseAtScope(atScope);
  const finalTrace = trace.map((entry) => {
    if (entry.ruleId === selected.rule.id)
      return {
        ...entry,
        selected: true,
        reason: selected.rule.locked
          ? "Selected locked ancestor rule."
          : "Selected by scope and subject precedence.",
      };
    if (entry.outcome !== "allow" && entry.outcome !== "deny") return entry;
    return {
      ...entry,
      overriddenByRuleId: selected.rule.id,
      reason: selected.rule.locked
        ? `Overridden by locked ancestor ${selected.rule.id}.`
        : `Overridden by ${selected.rule.id}.`,
    };
  });
  return {
    decision: selected.rule.decision,
    reason: selected.conflict
      ? "An equal-priority group conflict resolved to deny."
      : selected.rule.locked
        ? "A locked ancestor rule determined access."
        : "The most specific applicable rule determined access.",
    source: {
      ruleId: selected.rule.id,
      locked: selected.rule.locked === true,
    },
    prerequisites,
    trace: finalTrace,
  };
}

export type AccessRole = Role;
