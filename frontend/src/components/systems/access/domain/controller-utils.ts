import { departments, permissions, type Person, type Role } from "./model";
import {
  createPolicyBundle,
  parsePolicyBundle,
  planPolicyImport,
  type AccessPolicyBundleV1,
} from "./policy-bundle";
import {
  resolveEffectiveAccess,
  validateAccessIdentity,
  type AccessDecision,
  AccessDefaults,
  AccessGroup,
  AccessHistoryEntry,
  AccessIdentity,
  AccessIdentityStatus,
  AccessReview,
  AccessRule,
  AccessScopeRef,
  AccessTemplate,
  EffectiveAccessPrerequisite,
  EffectiveAccessResult,
  GuestIdentity,
  InternalIdentity,
  ServiceIdentity,
} from "./policy";
import { normalizeLegacyGrant } from "../adapters/adapters";
import type { ManageSession } from "../../manage/state/sessions";

export type PermissionCatalogEntry = {
  id: string;
  name: string;
  product: "Sandbox/core" | "Boards" | "OpenView" | "OpenComms";
};

export const permissionCatalog: readonly PermissionCatalogEntry[] = [
  { id: "scope.view", name: "View scoped resource", product: "Sandbox/core" },
  { id: "records.create", name: "Create records", product: "Sandbox/core" },
  { id: "records.read", name: "Read records", product: "Sandbox/core" },
  { id: "records.write", name: "Update records", product: "Sandbox/core" },
  { id: "records.close", name: "Close records", product: "Sandbox/core" },
  { id: "records.purge", name: "Purge records", product: "Sandbox/core" },
  { id: "access.manage", name: "Manage access", product: "Sandbox/core" },
  { id: "boards.view", name: "View boards", product: "Boards" },
  { id: "boards.edit", name: "Edit boards", product: "Boards" },
  { id: "boards.manage", name: "Manage boards", product: "Boards" },
  { id: "openview.view", name: "View analytics", product: "OpenView" },
  { id: "openview.edit", name: "Edit analytics", product: "OpenView" },
  { id: "comms.view", name: "View channels", product: "OpenComms" },
  { id: "comms.post", name: "Post messages", product: "OpenComms" },
  { id: "comms.reply", name: "Reply in threads", product: "OpenComms" },
  { id: "comms.manage", name: "Manage channels", product: "OpenComms" },
  ...["create", "read", "update", "close", "purge"].map((action) => ({
    id: `action.${action}`,
    name: `${action[0].toUpperCase()}${action.slice(1)} legacy action`,
    product: "Sandbox/core" as const,
  })),
];

export type ScopeCatalogEntry = AccessScopeRef & {
  name: string;
  product: PermissionCatalogEntry["product"];
  parentId?: string;
};

export const scopeCatalog: readonly ScopeCatalogEntry[] = [
  {
    kind: "workspace",
    id: "workspace",
    name: "Workspace",
    product: "Sandbox/core",
  },
  ...departments.map((name) => ({
    kind: "department" as const,
    id: `department:${slug(name)}`,
    name,
    product: "Sandbox/core" as const,
    parentId: "workspace",
  })),
  ...["Service requests", "Equipment", "Customers"].map((name) => ({
    kind: "module" as const,
    id: `module:${slug(name)}`,
    name,
    product: "Sandbox/core" as const,
    parentId: "workspace",
  })),
  ...["Customer email", "Cost"].map((name) => ({
    kind: "field" as const,
    id: `field:${slug(name)}`,
    name,
    product: "Sandbox/core" as const,
    parentId: "workspace",
  })),
  ...["Organization", "Operations"].map((name) => ({
    kind: "board" as const,
    id: `board:${slug(name)}`,
    name,
    product: "Boards" as const,
    parentId: "workspace",
  })),
  {
    kind: "openview",
    id: "openview:workspace",
    name: "Workspace analytics",
    product: "OpenView",
    parentId: "workspace",
  },
  {
    kind: "comms-category",
    id: "comms-category:all",
    name: "All categories",
    product: "OpenComms",
    parentId: "comms-workspace:workspace",
  },
  {
    kind: "comms-channel",
    id: "comms-channel:all",
    name: "All channels",
    product: "OpenComms",
    parentId: "comms-workspace:workspace",
  },
];

export type ManagedGuestIdentity = GuestIdentity & {
  invitation: { sentAt: string; resendCount: number };
};

export type AccessSession = {
  id: string;
  identityId: string;
  label: string;
  current: boolean;
  status: "active" | "revoked";
  lastActiveAt?: string;
  revocation?: { kind: "manage-sessions"; revokedAt: string };
};

export function adaptManageSessions(
  sessions: readonly ManageSession[],
): AccessSession[] {
  return sessions.map((session) => ({
    id: session.id,
    identityId: session.personId,
    label: `${session.device} · ${session.browser} · ${session.location}`,
    current: session.current,
    status: "active",
    lastActiveAt: session.lastSeen,
  }));
}

export function projectManageSessions(
  sessions: readonly AccessSession[],
  previous: readonly ManageSession[],
): ManageSession[] {
  return sessions
    .filter((session) => session.status === "active")
    .map((session) => {
      const existing = previous.find((item) => item.id === session.id);
      if (existing) return structuredClone(existing);
      const [
        device = session.label,
        browser = "Unknown",
        location = "Unknown",
      ] = session.label.split(" · ");
      return {
        id: session.id,
        personId: session.identityId,
        personName: session.identityId,
        device,
        browser,
        location,
        lastSeen: session.lastActiveAt ?? "Unknown",
        current: session.current,
      };
    });
}

export type DeletedInternalIdentity = {
  identity: InternalIdentity;
  person: Person;
  deletedAt: string;
  deletedBy: string;
};

export type ControllerHistoryEntry = AccessHistoryEntry & {
  policySnapshot?: AccessPolicyBundleV1;
};

export type AccessControllerSnapshot = {
  people: Person[];
  roles: Role[];
  guests: ManagedGuestIdentity[];
  services: ServiceIdentity[];
  groups: AccessGroup[];
  rules: AccessRule[];
  defaults: AccessDefaults;
  templates: AccessTemplate[];
  reviews: AccessReview[];
  deletedIdentities: DeletedInternalIdentity[];
  sessions: AccessSession[];
  history: ControllerHistoryEntry[];
  federatedScopes?: (AccessScopeRef & {
    product?: PermissionCatalogEntry["product"];
    parentId?: string;
  })[];
};

export type AccessHealthFinding = {
  id: string;
  kind: "last-admin" | "expiry" | "empty" | "invalid-reference" | "conflict";
  severity: "critical" | "warning";
  title: string;
  detail: string;
  targetId?: string;
};

export type CreateIdentityInput =
  | (Omit<InternalIdentity, "id"> & { id?: string; email: string })
  | (Omit<ManagedGuestIdentity, "id" | "invitation"> & { id?: string })
  | (Omit<ServiceIdentity, "id"> & { id?: string });

export type UpdateIdentityPatch = Partial<
  Pick<AccessIdentity, "name" | "status" | "roleId" | "groupIds" | "expiresAt">
> & {
  email?: string;
  departmentIds?: string[];
  primaryDepartmentId?: string;
  title?: string;
  sponsorId?: string;
  ownerId?: string;
  purpose?: string;
};

export type BulkIdentityUpdateInput = {
  identityIds: string[];
  patch: Pick<UpdateIdentityPatch, "status" | "roleId" | "groupIds">;
  addGroupId?: string;
  removeGroupId?: string;
};

export type BulkIdentityImpact = {
  ok: boolean;
  affected: number;
  blocked: number;
  summary: string;
  error?: string;
};

export type CreateRoleInput = {
  id?: string;
  name: string;
  description?: string;
  grants?: string[];
};
export type UpdateRolePatch = Partial<
  Pick<Role, "name" | "description" | "grants">
>;
export type CreateGroupInput = {
  id?: string;
  name: string;
  description?: string;
  memberIds?: string[];
};
export type CreateReviewCampaignInput = Omit<
  AccessReview,
  "id" | "status" | "decisions"
> & {
  id?: string;
  targetIds: string[];
};
export type ResolveAccessInput = {
  identityId: string;
  permissionId: string;
  scopePath: readonly AccessScopeRef[];
  now?: string;
};

export type AccessCommand =
  | { type: "create-identity"; input: CreateIdentityInput }
  | { type: "update-identity"; identityId: string; patch: UpdateIdentityPatch }
  | {
      type: "set-identity-status";
      identityId: string;
      status: AccessIdentityStatus;
    }
  | { type: "resend-invite"; identityId: string }
  | { type: "revoke-invite"; identityId: string }
  | { type: "delete-identity"; identityId: string }
  | { type: "restore-identity"; identityId: string }
  | { type: "revoke-session"; identityId: string; sessionId: string }
  | { type: "revoke-all-sessions"; identityId: string }
  | { type: "bulk-update-identities"; input: BulkIdentityUpdateInput }
  | { type: "create-role"; input: CreateRoleInput }
  | {
      type: "update-role";
      roleId: string;
      patch: UpdateRolePatch;
      expected?: Role;
    }
  | { type: "duplicate-role"; roleId: string; name?: string }
  | { type: "delete-role"; roleId: string }
  | { type: "apply-role-template"; roleId: string; templateId: string }
  | { type: "create-group"; input: CreateGroupInput }
  | {
      type: "update-group";
      groupId: string;
      patch: Partial<Pick<AccessGroup, "name" | "description" | "memberIds">>;
      expected?: AccessGroup;
    }
  | { type: "delete-group"; groupId: string }
  | { type: "set-group-members"; groupId: string; memberIds: string[] }
  | { type: "upsert-rule"; rule: AccessRule }
  | { type: "upsert-rules"; rules: AccessRule[] }
  | { type: "delete-rule"; ruleId: string }
  | { type: "update-defaults"; patch: Partial<AccessDefaults> }
  | { type: "create-review-campaign"; input: CreateReviewCampaignInput }
  | {
      type: "record-review-decision";
      reviewId: string;
      targetId: string;
      decision: Exclude<
        AccessReview["decisions"][number]["decision"],
        "pending"
      >;
    }
  | { type: "complete-review"; reviewId: string }
  | { type: "apply-history-restore"; historyId: string }
  | { type: "import-policy-bundle"; text: string; mode: "merge" | "replace" };

export type AccessCommandContext = {
  now: string;
  id: (prefix: string) => string;
};

export type AccessCommandResult =
  | {
      ok: true;
      state: AccessControllerSnapshot;
      summary: string;
      value?:
        AccessIdentity | Role | AccessGroup | AccessReview | BulkIdentityImpact;
    }
  | { ok: false; error: string };

type AccessCommandValue =
  AccessIdentity | Role | AccessGroup | AccessReview | BulkIdentityImpact;

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function displayDepartment(id: string): string {
  return (
    departments.find((name) => `department:${slug(name)}` === id) ??
    id.replace(/^department:/, "").replaceAll("-", " ")
  );
}

function internalFromPerson(person: Person): InternalIdentity {
  const departmentIds = person.departments.map(
    (name) => `department:${slug(name)}`,
  );
  return {
    kind: "internal",
    id: person.id,
    name: person.name,
    email: person.email,
    status: person.accessStatus ?? (person.active ? "active" : "disabled"),
    roleId: person.role,
    groupIds: [...(person.groupIds ?? [])],
    departmentIds,
    primaryDepartmentId: person.primary
      ? `department:${slug(person.primary)}`
      : "",
    title: person.title,
    ...(person.expiresAt ? { expiresAt: person.expiresAt } : {}),
  };
}

function personFromInternal(
  identity: InternalIdentity,
  previous?: Person,
): Person {
  return {
    id: identity.id,
    name: identity.name,
    email: identity.email,
    role: identity.roleId,
    active: identity.status === "active",
    departments: identity.departmentIds.map(displayDepartment),
    primary: identity.primaryDepartmentId
      ? displayDepartment(identity.primaryDepartmentId)
      : "",
    title: identity.title,
    activity: [...(previous?.activity ?? [])],
    accessStatus: identity.status === "deleted" ? "disabled" : identity.status,
    groupIds: [...identity.groupIds],
    ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {}),
  };
}

export function getControllerIdentities(
  state: AccessControllerSnapshot,
): AccessIdentity[] {
  return [
    ...state.people.map(internalFromPerson),
    ...state.guests.map((identity) => structuredClone(identity)),
    ...state.services.map((identity) => structuredClone(identity)),
  ];
}

function fail(error: string): AccessCommandResult {
  return { ok: false, error };
}

function policySnapshot(state: AccessControllerSnapshot): AccessPolicyBundleV1 {
  return createPolicyBundle(state);
}

function appendHistory(
  state: AccessControllerSnapshot,
  context: AccessCommandContext,
  summary: string,
  target: string,
  snapshot?: AccessPolicyBundleV1,
  result: ControllerHistoryEntry["result"] = "applied",
): void {
  state.history = [
    ...state.history,
    {
      id: context.id("history"),
      actorId: "sample-mara",
      target,
      occurredAt: context.now,
      summary,
      result,
      restorable: snapshot !== undefined,
      ...(snapshot ? { policySnapshot: snapshot } : {}),
    },
  ].slice(-100);
}

function success(
  state: AccessControllerSnapshot,
  context: AccessCommandContext,
  summary: string,
  target: string,
  value?: AccessCommandValue,
  snapshot?: AccessPolicyBundleV1,
  result: ControllerHistoryEntry["result"] = "applied",
): AccessCommandResult {
  appendHistory(state, context, summary, target, snapshot, result);
  return { ok: true, state, summary, ...(value ? { value } : {}) };
}

function findIdentity(
  state: AccessControllerSnapshot,
  id: string,
): AccessIdentity | undefined {
  return getControllerIdentities(state).find((identity) => identity.id === id);
}

function activeAdminCount(state: AccessControllerSnapshot): number {
  return state.people.filter(
    (person) =>
      internalFromPerson(person).status === "active" &&
      person.role === "sample-admin",
  ).length;
}

function validEmail(
  state: AccessControllerSnapshot,
  email: string,
  exceptId?: string,
): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    ![
      ...state.people.map((person) => ({ id: person.id, email: person.email })),
      ...state.guests.map((guest) => ({ id: guest.id, email: guest.email })),
    ].some(
      (entry) =>
        entry.id !== exceptId &&
        entry.email.trim().toLowerCase() === normalized,
    )
  );
}

function validateIdentityReferences(
  state: AccessControllerSnapshot,
  identity: AccessIdentity,
): string | null {
  const validation = validateAccessIdentity(identity);
  if (!validation.valid) return validation.issues[0];
  if (!state.roles.some((role) => role.id === identity.roleId))
    return "The selected role is unknown.";
  if (
    identity.groupIds.some(
      (id) => !state.groups.some((group) => group.id === id),
    )
  )
    return "An assigned group is unknown.";
  if (identity.kind === "service" && identity.groupIds.length)
    return "Services cannot belong to groups.";
  if (
    identity.kind !== "service" &&
    !validEmail(state, identity.email, identity.id)
  )
    return "Email addresses must be non-empty and unique.";
  return null;
}

function applyIdentity(
  state: AccessControllerSnapshot,
  identity: AccessIdentity,
): void {
  if (identity.kind === "internal") {
    const index = state.people.findIndex((person) => person.id === identity.id);
    const person = personFromInternal(
      identity,
      index >= 0 ? state.people[index] : undefined,
    );
    if (index >= 0) state.people[index] = person;
    else state.people.push(person);
  } else if (identity.kind === "guest") {
    const index = state.guests.findIndex((guest) => guest.id === identity.id);
    const previous = index >= 0 ? state.guests[index] : undefined;
    const managed: ManagedGuestIdentity = {
      ...identity,
      invitation: previous?.invitation ?? { sentAt: "", resendCount: 0 },
    };
    if (index >= 0) state.guests[index] = managed;
    else state.guests.push(managed);
  } else {
    const index = state.services.findIndex(
      (service) => service.id === identity.id,
    );
    if (index >= 0) state.services[index] = identity;
    else state.services.push(identity);
  }
  state.groups = state.groups.map((group) => ({
    ...group,
    memberIds:
      identity.kind === "service"
        ? group.memberIds.filter((id) => id !== identity.id)
        : identity.groupIds.includes(group.id)
          ? [...new Set([...group.memberIds, identity.id])]
          : group.memberIds.filter((id) => id !== identity.id),
  }));
}

function patchIdentity(
  identity: AccessIdentity,
  patch: UpdateIdentityPatch,
): AccessIdentity {
  if (identity.kind === "internal")
    return {
      ...identity,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.roleId !== undefined ? { roleId: patch.roleId } : {}),
      ...(patch.groupIds !== undefined
        ? { groupIds: [...patch.groupIds] }
        : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      email: patch.email?.trim() ?? identity.email,
      departmentIds: patch.departmentIds
        ? [...patch.departmentIds]
        : identity.departmentIds,
      primaryDepartmentId:
        patch.primaryDepartmentId ?? identity.primaryDepartmentId,
      title: patch.title ?? identity.title,
    };
  if (identity.kind === "guest")
    return {
      ...identity,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.roleId !== undefined ? { roleId: patch.roleId } : {}),
      ...(patch.groupIds !== undefined
        ? { groupIds: [...patch.groupIds] }
        : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      email: patch.email?.trim() ?? identity.email,
      sponsorId: patch.sponsorId ?? identity.sponsorId,
    };
  return {
    ...identity,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.roleId !== undefined ? { roleId: patch.roleId } : {}),
    ...(patch.groupIds !== undefined ? { groupIds: [...patch.groupIds] } : {}),
    ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    ownerId: patch.ownerId ?? identity.ownerId,
    purpose: patch.purpose ?? identity.purpose,
  };
}

function wouldRemoveLastAdmin(
  state: AccessControllerSnapshot,
  before: AccessIdentity,
  after: AccessIdentity,
): boolean {
  return (
    before.kind === "internal" &&
    before.status === "active" &&
    before.roleId === "sample-admin" &&
    (after.kind !== "internal" ||
      after.status !== "active" ||
      after.roleId !== "sample-admin") &&
    activeAdminCount(state) === 1
  );
}

export function previewBulkIdentityUpdate(
  state: AccessControllerSnapshot,
  input: BulkIdentityUpdateInput,
): BulkIdentityImpact {
  const ids = [...new Set(input.identityIds)];
  const identities = ids
    .map((id) => findIdentity(state, id))
    .filter((value): value is AccessIdentity => value !== undefined);
  let blocked = ids.length - identities.length;
  const groupIntentError =
    input.patch.groupIds !== undefined &&
    (input.addGroupId !== undefined || input.removeGroupId !== undefined)
      ? "Choose either replacement memberships or add/remove membership intent."
      : input.addGroupId !== undefined &&
          input.addGroupId === input.removeGroupId
        ? "A bulk group action cannot add and remove the same group."
        : [input.addGroupId, input.removeGroupId].some(
              (id) =>
                id !== undefined &&
                !state.groups.some((group) => group.id === id),
            )
          ? "The bulk group is unknown."
          : undefined;
  if (groupIntentError)
    return {
      ok: false,
      affected: identities.length,
      blocked: Math.max(1, identities.length),
      summary: `${identities.length} identities affected; operation blocked.`,
      error: groupIntentError,
    };
  const projected = structuredClone(state);
  for (const identity of identities) {
    if (
      identity.kind === "service" &&
      (input.addGroupId !== undefined || input.removeGroupId !== undefined)
    ) {
      blocked += 1;
      continue;
    }
    const groupIds = input.patch.groupIds
      ? [...input.patch.groupIds]
      : [
          ...new Set([
            ...identity.groupIds.filter((id) => id !== input.removeGroupId),
            ...(input.addGroupId ? [input.addGroupId] : []),
          ]),
        ];
    const next = patchIdentity(identity, { ...input.patch, groupIds });
    const issue = validateIdentityReferences(projected, next);
    if (issue) blocked += 1;
    else applyIdentity(projected, next);
  }
  if (activeAdminCount(projected) === 0) blocked = Math.max(1, blocked);
  const ok = blocked === 0;
  return {
    ok,
    affected: identities.length,
    blocked,
    summary: `${identities.length} identities affected; ${blocked} blocked.`,
    ...(!ok
      ? {
          error:
            activeAdminCount(projected) === 0
              ? "Keep at least one active internal Administrator."
              : "One or more identity updates are invalid.",
        }
      : {}),
  };
}

function uniqueRoleName(
  state: AccessControllerSnapshot,
  name: string,
  exceptId?: string,
): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    !state.roles.some(
      (role) =>
        role.id !== exceptId && role.name.trim().toLowerCase() === normalized,
    )
  );
}

function uniqueGroupName(
  state: AccessControllerSnapshot,
  name: string,
  exceptId?: string,
): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    !state.groups.some(
      (group) =>
        group.id !== exceptId && group.name.trim().toLowerCase() === normalized,
    )
  );
}

function knownPermission(id: string): boolean {
  return permissionCatalog.some((permission) => permission.id === id);
}

function knownScope(
  scope: AccessScopeRef,
  state?: AccessControllerSnapshot,
): boolean {
  return [...scopeCatalog, ...(state?.federatedScopes ?? [])].some(
    (candidate) => candidate.id === scope.id && candidate.kind === scope.kind,
  );
}

function compatibleRuleProduct(
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

function legacyGrantFor(
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

function validRule(
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

function updateLegacyProjection(
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

function validateDefaults(
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

function applyBundle(
  state: AccessControllerSnapshot,
  bundle: AccessPolicyBundleV1,
  mode: "merge" | "replace",
): string | null {
  if (
    bundle.roles.some((role) =>
      state.roles.some((current) => current.builtin && current.id === role.id),
    )
  )
    return "Policy bundles cannot replace built-in roles.";
  const planned = planPolicyImport(
    policySnapshot(state),
    bundle,
    mode,
    state.roles,
  );
  const customRoles: Role[] = planned.bundle.roles.map((role) => ({
    ...role,
    builtin: false,
  }));
  const roles = [...planned.protectedRoles, ...customRoles];
  if (
    new Set(roles.map((role) => role.name.trim().toLowerCase())).size !==
    roles.length
  )
    return "Role names must be unique.";
  const currentMembers = new Map(
    state.groups.map((group) => [group.id, group.memberIds]),
  );
  const groups = planned.bundle.groups.map((group) => ({
    ...group,
    memberIds: [...(currentMembers.get(group.id) ?? [])],
  }));
  if (
    new Set(groups.map((group) => group.name.trim().toLowerCase())).size !==
      groups.length ||
    groups.some((group) => !group.name.trim())
  )
    return "Group names must be non-empty and unique.";
  const candidate = {
    ...state,
    roles,
    groups,
    defaults: planned.bundle.defaults,
    rules: planned.bundle.rules,
  };
  const defaultsIssue = validateDefaults(candidate, candidate.defaults);
  if (defaultsIssue) return defaultsIssue;
  for (const rule of candidate.rules) {
    const issue = validRule(candidate, rule);
    if (issue) return issue;
    if (rule.subject.kind === "identity")
      return "Policy bundles cannot contain identity rules.";
  }
  for (const identity of getControllerIdentities(candidate)) {
    const issue = validateIdentityReferences(candidate, identity);
    if (issue) return issue;
  }
  state.roles = roles;
  state.groups = groups;
  state.defaults = structuredClone(planned.bundle.defaults);
  state.rules = structuredClone(planned.bundle.rules);
  state.templates = structuredClone(planned.bundle.templates);
  return null;
}

export function executeAccessCommand(
  current: AccessControllerSnapshot,
  command: AccessCommand,
  context: AccessCommandContext,
): AccessCommandResult {
  const state = structuredClone(current);
  if (!Number.isFinite(Date.parse(context.now)))
    return fail("The operation time is invalid.");

  switch (command.type) {
    case "create-identity": {
      const id = command.input.id ?? context.id(command.input.kind);
      if (
        findIdentity(state, id) ||
        state.deletedIdentities.some((item) => item.identity.id === id)
      )
        return fail("That identity identifier is already in use.");
      const input = { ...command.input, id, name: command.input.name.trim() };
      let identity: AccessIdentity;
      if (input.kind === "internal")
        identity = {
          ...input,
          departmentIds: [...input.departmentIds],
          groupIds: [...input.groupIds],
        };
      else if (input.kind === "guest")
        identity = { ...input, groupIds: [...input.groupIds] };
      else identity = { ...input, groupIds: [] };
      const issue = validateIdentityReferences(state, identity);
      if (issue) return fail(issue);
      applyIdentity(state, identity);
      if (identity.kind === "guest") {
        const guest = state.guests.find((item) => item.id === identity.id);
        if (guest) guest.invitation = { sentAt: context.now, resendCount: 0 };
      }
      return success(
        state,
        context,
        "Identity created; no message or secret was generated.",
        identity.id,
        identity,
      );
    }
    case "update-identity":
    case "set-identity-status": {
      const identityId = command.identityId;
      const before = findIdentity(state, identityId);
      if (!before) return fail("Identity not found.");
      const patch =
        command.type === "update-identity"
          ? command.patch
          : { status: command.status };
      const after = patchIdentity(before, patch);
      const issue = validateIdentityReferences(state, after);
      if (issue) return fail(issue);
      if (wouldRemoveLastAdmin(state, before, after))
        return fail("Keep at least one active internal Administrator.");
      applyIdentity(state, after);
      return success(state, context, "Identity updated.", identityId, after);
    }
    case "resend-invite": {
      const identity = findIdentity(state, command.identityId);
      if (!identity || identity.kind === "service")
        return fail("Invitable identity not found.");
      if (identity.status !== "pending")
        return fail("Only pending invitations can be resent.");
      if (identity.kind === "guest") {
        const guest = state.guests.find((item) => item.id === identity.id);
        if (guest)
          guest.invitation = {
            sentAt: context.now,
            resendCount: guest.invitation.resendCount + 1,
          };
      } else {
        const person = state.people.find((item) => item.id === identity.id);
        if (person) person.activity.push("Invitation resent; no email sent");
      }
      return success(
        state,
        context,
        "Invitation marked resent; no email was sent.",
        identity.id,
        identity,
      );
    }
    case "revoke-invite": {
      const identity = findIdentity(state, command.identityId);
      if (!identity || identity.kind === "service")
        return fail("Invitable identity not found.");
      if (identity.status !== "pending")
        return fail("Only pending invitations can be revoked.");
      const next = patchIdentity(identity, { status: "revoked" });
      applyIdentity(state, next);
      return success(state, context, "Invitation revoked.", identity.id, next);
    }
    case "delete-identity": {
      const identity = findIdentity(state, command.identityId);
      if (!identity) return fail("Identity not found.");
      if (
        identity.kind === "internal" &&
        identity.status === "active" &&
        identity.roleId === "sample-admin" &&
        activeAdminCount(state) === 1
      )
        return fail("Keep at least one active internal Administrator.");
      if (
        state.rules.some(
          (rule) =>
            rule.subject.kind === "identity" && rule.subject.id === identity.id,
        ) ||
        state.guests.some((guest) => guest.sponsorId === identity.id) ||
        state.services.some((service) => service.ownerId === identity.id)
      )
        return fail(
          "Remove identity policy, sponsor, and owner references before deleting this identity.",
        );
      if (identity.kind === "internal") {
        const person = state.people.find((item) => item.id === identity.id);
        if (!person) return fail("Identity not found.");
        state.deletedIdentities.push({
          identity: { ...identity, status: "deleted" },
          person,
          deletedAt: context.now,
          deletedBy: "sample-mara",
        });
        state.people = state.people.filter((item) => item.id !== identity.id);
      } else if (identity.kind === "guest")
        state.guests = state.guests.filter((item) => item.id !== identity.id);
      else
        state.services = state.services.filter(
          (item) => item.id !== identity.id,
        );
      state.groups = state.groups.map((group) => ({
        ...group,
        memberIds: group.memberIds.filter((id) => id !== identity.id),
      }));
      state.sessions = state.sessions.filter(
        (session) => session.identityId !== identity.id,
      );
      return success(state, context, "Identity deleted.", identity.id);
    }
    case "restore-identity": {
      const deleted = state.deletedIdentities.find(
        (item) => item.identity.id === command.identityId,
      );
      if (deleted) {
        if (!validEmail(state, deleted.identity.email))
          return fail("Email addresses must be non-empty and unique.");
        const restored = { ...deleted.identity, status: "active" as const };
        const issue = validateIdentityReferences(state, restored);
        if (issue) return fail(issue);
        state.people.push(personFromInternal(restored, deleted.person));
        state.groups = state.groups.map((group) => ({
          ...group,
          memberIds: restored.groupIds.includes(group.id)
            ? [...new Set([...group.memberIds, restored.id])]
            : group.memberIds,
        }));
        state.deletedIdentities = state.deletedIdentities.filter(
          (item) => item.identity.id !== command.identityId,
        );
        return success(
          state,
          context,
          "Deleted internal identity restored.",
          restored.id,
          restored,
        );
      }
      const identity = findIdentity(state, command.identityId);
      if (!identity) return fail("Identity not found.");
      const restored = patchIdentity(identity, { status: "active" });
      applyIdentity(state, restored);
      return success(
        state,
        context,
        "Identity restored.",
        restored.id,
        restored,
      );
    }
    case "revoke-session": {
      const session = state.sessions.find(
        (item) =>
          item.id === command.sessionId &&
          item.identityId === command.identityId,
      );
      if (!session) return fail("Session not found.");
      if (session.current)
        return fail("The current session cannot be revoked.");
      session.status = "revoked";
      session.revocation = { kind: "manage-sessions", revokedAt: context.now };
      return success(
        state,
        context,
        "Session revoked through manage-sessions.",
        session.id,
      );
    }
    case "revoke-all-sessions": {
      if (!findIdentity(state, command.identityId))
        return fail("Identity not found.");
      const sessions = state.sessions.filter(
        (item) =>
          item.identityId === command.identityId &&
          !item.current &&
          item.status === "active",
      );
      for (const session of sessions) {
        session.status = "revoked";
        session.revocation = {
          kind: "manage-sessions",
          revokedAt: context.now,
        };
      }
      return success(
        state,
        context,
        `${sessions.length} non-current sessions revoked through manage-sessions.`,
        command.identityId,
      );
    }
    case "bulk-update-identities": {
      const impact = previewBulkIdentityUpdate(state, command.input);
      if (!impact.ok) return fail(impact.error ?? "Bulk update is not safe.");
      for (const id of [...new Set(command.input.identityIds)]) {
        const identity = findIdentity(state, id);
        if (identity) {
          const groupIds = command.input.patch.groupIds
            ? [...command.input.patch.groupIds]
            : [
                ...new Set([
                  ...identity.groupIds.filter(
                    (groupId) => groupId !== command.input.removeGroupId,
                  ),
                  ...(command.input.addGroupId
                    ? [command.input.addGroupId]
                    : []),
                ]),
              ];
          applyIdentity(
            state,
            patchIdentity(identity, { ...command.input.patch, groupIds }),
          );
        }
      }
      return success(state, context, impact.summary, "bulk-identities", impact);
    }
    case "create-role": {
      const snapshot = policySnapshot(state);
      if (!uniqueRoleName(state, command.input.name))
        return fail("Role names must be non-empty and unique.");
      const role: Role = {
        id: command.input.id ?? context.id("role"),
        name: command.input.name.trim(),
        description: command.input.description?.trim() ?? "",
        builtin: false,
        grants: [...new Set(command.input.grants ?? [])],
      };
      if (state.roles.some((item) => item.id === role.id))
        return fail("That role identifier is already in use.");
      state.roles.push(role);
      return success(state, context, "Role created.", role.id, role, snapshot);
    }
    case "update-role": {
      const snapshot = policySnapshot(state);
      const role = state.roles.find((item) => item.id === command.roleId);
      if (!role) return fail("Role not found.");
      if (role.builtin) return fail("Built-in roles are immutable.");
      if (
        command.expected &&
        JSON.stringify(role) !== JSON.stringify(command.expected)
      )
        return fail(
          "This role changed after review. Review the current values before applying your draft.",
        );
      const name = command.patch.name?.trim() ?? role.name;
      if (!uniqueRoleName(state, name, role.id))
        return fail("Role names must be non-empty and unique.");
      const next: Role = {
        ...role,
        ...command.patch,
        name,
        description: command.patch.description?.trim() ?? role.description,
        grants: command.patch.grants
          ? [...new Set(command.patch.grants)]
          : role.grants,
      };
      state.roles = state.roles.map((item) =>
        item.id === role.id ? next : item,
      );
      return success(state, context, "Role updated.", role.id, next, snapshot);
    }
    case "duplicate-role": {
      const snapshot = policySnapshot(state);
      const source = state.roles.find((item) => item.id === command.roleId);
      if (!source) return fail("Role not found.");
      const name = command.name?.trim() || `${source.name} copy`;
      if (!uniqueRoleName(state, name))
        return fail("Role names must be non-empty and unique.");
      const role: Role = {
        ...source,
        id: context.id("role"),
        name,
        builtin: false,
        grants: [...source.grants],
      };
      state.roles.push(role);
      return success(
        state,
        context,
        "Role duplicated.",
        role.id,
        role,
        snapshot,
      );
    }
    case "delete-role": {
      const snapshot = policySnapshot(state);
      const role = state.roles.find((item) => item.id === command.roleId);
      if (!role) return fail("Role not found.");
      if (role.builtin) return fail("Built-in roles cannot be deleted.");
      if (
        getControllerIdentities(state).some(
          (identity) => identity.roleId === role.id,
        ) ||
        state.defaults.defaultRoleId === role.id ||
        state.rules.some(
          (rule) => rule.subject.kind === "role" && rule.subject.id === role.id,
        )
      )
        return fail("Role is still referenced and cannot be deleted.");
      state.roles = state.roles.filter((item) => item.id !== role.id);
      return success(
        state,
        context,
        "Role deleted.",
        role.id,
        undefined,
        snapshot,
      );
    }
    case "apply-role-template": {
      const snapshot = policySnapshot(state);
      const role = state.roles.find((item) => item.id === command.roleId);
      const template = state.templates.find(
        (item) => item.id === command.templateId,
      );
      if (!role || !template) return fail("Role or template not found.");
      if (role.builtin) return fail("Built-in role grants are protected.");
      role.grants = [...new Set(template.grants)];
      return success(
        state,
        context,
        "Role template applied.",
        role.id,
        role,
        snapshot,
      );
    }
    case "create-group": {
      const snapshot = policySnapshot(state);
      if (!uniqueGroupName(state, command.input.name))
        return fail("Group names must be non-empty and unique.");
      const memberIds = [...new Set(command.input.memberIds ?? [])];
      if (
        memberIds.some((id) =>
          state.services.some((service) => service.id === id),
        )
      )
        return fail("Services cannot belong to groups.");
      if (
        memberIds.some(
          (id) =>
            !state.people.some((person) => person.id === id) &&
            !state.guests.some((guest) => guest.id === id),
        )
      )
        return fail("A group member is unknown.");
      const group: AccessGroup = {
        id: command.input.id ?? context.id("group"),
        name: command.input.name.trim(),
        description: command.input.description?.trim() ?? "",
        memberIds,
      };
      if (state.groups.some((item) => item.id === group.id))
        return fail("That group identifier is already in use.");
      state.groups.push(group);
      state.people = state.people.map((person) =>
        memberIds.includes(person.id)
          ? {
              ...person,
              groupIds: [...new Set([...(person.groupIds ?? []), group.id])],
            }
          : person,
      );
      state.guests = state.guests.map((guest) =>
        memberIds.includes(guest.id)
          ? { ...guest, groupIds: [...new Set([...guest.groupIds, group.id])] }
          : guest,
      );
      return success(
        state,
        context,
        "Group created.",
        group.id,
        group,
        snapshot,
      );
    }
    case "update-group": {
      const snapshot = policySnapshot(state);
      const group = state.groups.find((item) => item.id === command.groupId);
      if (!group) return fail("Group not found.");
      if (
        command.expected &&
        JSON.stringify(group) !== JSON.stringify(command.expected)
      )
        return fail(
          "This group changed after review. Review the current values before applying your draft.",
        );
      const name = command.patch.name?.trim() ?? group.name;
      if (!uniqueGroupName(state, name, group.id))
        return fail("Group names must be non-empty and unique.");
      const memberIds = command.patch.memberIds
        ? [...new Set(command.patch.memberIds)]
        : group.memberIds;
      if (
        memberIds.some((id) =>
          state.services.some((service) => service.id === id),
        )
      )
        return fail("Services cannot belong to groups.");
      if (
        memberIds.some(
          (id) =>
            !state.people.some((person) => person.id === id) &&
            !state.guests.some((guest) => guest.id === id),
        )
      )
        return fail("A group member is unknown.");
      Object.assign(group, command.patch, {
        name,
        description: command.patch.description?.trim() ?? group.description,
        memberIds,
      });
      state.people = state.people.map((person) => ({
        ...person,
        groupIds: memberIds.includes(person.id)
          ? [...new Set([...(person.groupIds ?? []), group.id])]
          : (person.groupIds ?? []).filter((id) => id !== group.id),
      }));
      state.guests = state.guests.map((guest) => ({
        ...guest,
        groupIds: memberIds.includes(guest.id)
          ? [...new Set([...guest.groupIds, group.id])]
          : guest.groupIds.filter((id) => id !== group.id),
      }));
      return success(
        state,
        context,
        "Group updated.",
        group.id,
        group,
        snapshot,
      );
    }
    case "delete-group": {
      const snapshot = policySnapshot(state);
      const group = state.groups.find((item) => item.id === command.groupId);
      if (!group) return fail("Group not found.");
      if (
        group.memberIds.length ||
        state.defaults.defaultGroupIds.includes(group.id) ||
        state.rules.some(
          (rule) =>
            rule.subject.kind === "group" && rule.subject.id === group.id,
        )
      )
        return fail("Group is still referenced and cannot be deleted.");
      state.groups = state.groups.filter((item) => item.id !== group.id);
      return success(
        state,
        context,
        "Group deleted.",
        group.id,
        undefined,
        snapshot,
      );
    }
    case "set-group-members": {
      const group = state.groups.find((item) => item.id === command.groupId);
      if (!group) return fail("Group not found.");
      const memberIds = [...new Set(command.memberIds)];
      if (
        memberIds.some((id) =>
          state.services.some((service) => service.id === id),
        )
      )
        return fail("Services cannot belong to groups.");
      if (
        memberIds.some(
          (id) =>
            !state.people.some((person) => person.id === id) &&
            !state.guests.some((guest) => guest.id === id),
        )
      )
        return fail("A group member is unknown.");
      group.memberIds = memberIds;
      state.people = state.people.map((person) => ({
        ...person,
        groupIds: memberIds.includes(person.id)
          ? [...new Set([...(person.groupIds ?? []), group.id])]
          : (person.groupIds ?? []).filter((id) => id !== group.id),
      }));
      state.guests = state.guests.map((guest) => ({
        ...guest,
        groupIds: memberIds.includes(guest.id)
          ? [...new Set([...guest.groupIds, group.id])]
          : guest.groupIds.filter((id) => id !== group.id),
      }));
      return success(
        state,
        context,
        "Group membership updated.",
        group.id,
        group,
      );
    }
    case "upsert-rule": {
      const snapshot = policySnapshot(state);
      const issue = validRule(state, command.rule);
      if (issue) return fail(issue);
      const index = state.rules.findIndex(
        (rule) => rule.id === command.rule.id,
      );
      if (index >= 0) state.rules[index] = structuredClone(command.rule);
      else state.rules.push(structuredClone(command.rule));
      updateLegacyProjection(state, command.rule);
      return success(
        state,
        context,
        "Policy rule saved and compatible legacy grants projected.",
        command.rule.id,
        undefined,
        snapshot,
      );
    }
    case "upsert-rules": {
      if (!command.rules.length)
        return fail("At least one policy rule is required.");
      if (
        new Set(command.rules.map((rule) => rule.id)).size !==
        command.rules.length
      )
        return fail("Policy rule identifiers must be unique within a batch.");
      for (const rule of command.rules) {
        const issue = validRule(state, rule);
        if (issue) return fail(issue);
      }
      const snapshot = policySnapshot(state);
      for (const rule of command.rules) {
        const index = state.rules.findIndex((item) => item.id === rule.id);
        if (index >= 0) state.rules[index] = structuredClone(rule);
        else state.rules.push(structuredClone(rule));
        updateLegacyProjection(state, rule);
      }
      return success(
        state,
        context,
        `${command.rules.length} policy rules saved atomically and compatible legacy grants projected.`,
        "policy-rules",
        undefined,
        snapshot,
      );
    }
    case "delete-rule": {
      const snapshot = policySnapshot(state);
      const rule = state.rules.find((item) => item.id === command.ruleId);
      if (!rule) return fail("Rule not found.");
      state.rules = state.rules.filter((item) => item.id !== rule.id);
      const roleId = rule.subject.kind === "role" ? rule.subject.id : undefined;
      if (
        roleId !== undefined &&
        !state.rules.some(
          (item) =>
            item.subject.kind === "role" &&
            item.subject.id === roleId &&
            item.scope.id === rule.scope.id &&
            item.permissionId === rule.permissionId &&
            item.decision === "allow",
        )
      )
        updateLegacyProjection(state, { ...rule, decision: "inherit" });
      return success(
        state,
        context,
        "Policy rule deleted.",
        rule.id,
        undefined,
        snapshot,
      );
    }
    case "update-defaults": {
      const snapshot = policySnapshot(state);
      const defaults = { ...state.defaults, ...command.patch };
      const issue = validateDefaults(state, defaults);
      if (issue) return fail(issue);
      state.defaults = defaults;
      return success(
        state,
        context,
        "Access defaults updated.",
        "defaults",
        undefined,
        snapshot,
      );
    }
    case "create-review-campaign": {
      if (!command.input.name.trim() || !command.input.targetIds.length)
        return fail("Review campaigns require a name and at least one target.");
      const reviewer = state.people.find(
        (person) => person.id === command.input.reviewerId,
      );
      if (
        !reviewer ||
        internalFromPerson(reviewer).status !== "active" ||
        reviewer.role !== "sample-admin"
      )
        return fail(
          "Reviews require an active internal Administrator reviewer.",
        );
      const subjectKnown =
        (command.input.subjectKind === "role" &&
          state.roles.some((role) => role.id === command.input.subjectId)) ||
        (command.input.subjectKind === "group" &&
          state.groups.some((group) => group.id === command.input.subjectId)) ||
        (command.input.subjectKind === "identity-kind" &&
          ["internal", "guest", "service"].includes(command.input.subjectId)) ||
        (command.input.subjectKind === "expiry-window" &&
          command.input.subjectId.trim().length > 0);
      if (!subjectKnown) return fail("The review subject is unknown.");
      if (
        command.input.targetIds.some(
          (targetId) => !findIdentity(state, targetId),
        )
      )
        return fail("A review target is unknown.");
      const review: AccessReview = {
        id: command.input.id ?? context.id("review"),
        name: command.input.name.trim(),
        reviewerId: command.input.reviewerId,
        status: "in-progress",
        subjectKind: command.input.subjectKind,
        subjectId: command.input.subjectId,
        decisions: [...new Set(command.input.targetIds)].map((targetId) => ({
          targetId,
          decision: "pending",
        })),
      };
      state.reviews.push(review);
      return success(
        state,
        context,
        "Review campaign created.",
        review.id,
        review,
      );
    }
    case "record-review-decision": {
      const review = state.reviews.find((item) => item.id === command.reviewId);
      if (!review || review.status === "complete")
        return fail("Active review campaign not found.");
      const decision = review.decisions.find(
        (item) => item.targetId === command.targetId,
      );
      if (!decision) return fail("Review target not found.");
      decision.decision = command.decision;
      return success(
        state,
        context,
        "Review decision recorded.",
        review.id,
        review,
      );
    }
    case "complete-review": {
      const review = state.reviews.find((item) => item.id === command.reviewId);
      if (!review) return fail("Review campaign not found.");
      if (review.decisions.some((decision) => decision.decision === "pending"))
        return fail(
          "Resolve every pending decision before completing the review.",
        );
      review.status = "complete";
      return success(
        state,
        context,
        "Review campaign completed.",
        review.id,
        review,
      );
    }
    case "import-policy-bundle": {
      const parsed = parsePolicyBundle(command.text);
      if (!parsed.ok) return fail(parsed.error);
      const snapshot = policySnapshot(state);
      const issue = applyBundle(state, parsed.value, command.mode);
      if (issue) return fail(issue);
      return success(
        state,
        context,
        `${command.mode === "merge" ? "Merge" : "Replace"} policy import applied.`,
        "policy-bundle",
        undefined,
        snapshot,
      );
    }
    case "apply-history-restore": {
      const entry = state.history.find((item) => item.id === command.historyId);
      if (!entry?.restorable || !entry.policySnapshot)
        return fail("This history entry cannot restore policy configuration.");
      const snapshot = policySnapshot(state);
      const issue = applyBundle(state, entry.policySnapshot, "replace");
      if (issue) return fail(issue);
      return success(
        state,
        context,
        "Policy configuration restored from history.",
        entry.id,
        undefined,
        snapshot,
        "restored",
      );
    }
  }
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
): AccessHealthFinding[] {
  const findings: AccessHealthFinding[] = [];
  const adminCount = activeAdminCount(state);
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
  const timestamp = Date.parse(now);
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
    if (role.grants.some((grant) => normalizeLegacyGrant(grant) === null))
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
