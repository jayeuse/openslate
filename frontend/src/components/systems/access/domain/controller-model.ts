import { departments, type Person, type Role } from "./model";
import type { AccessPolicyBundleV1 } from "./policy-bundle";
import type {
  AccessDefaults,
  AccessGroup,
  AccessHistoryEntry,
  AccessIdentity,
  AccessIdentityStatus,
  AccessReview,
  AccessRule,
  AccessScopeRef,
  AccessTemplate,
  GuestIdentity,
  InternalIdentity,
  ServiceIdentity,
} from "./policy";
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

export type AccessCommandValue =
  AccessIdentity | Role | AccessGroup | AccessReview | BulkIdentityImpact;

export function slug(value: string): string {
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

export function internalFromPerson(person: Person): InternalIdentity {
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

export function personFromInternal(
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

export function findIdentity(
  state: AccessControllerSnapshot,
  id: string,
): AccessIdentity | undefined {
  return getControllerIdentities(state).find((identity) => identity.id === id);
}

export function activeAdminCount(
  state: AccessControllerSnapshot,
  roleId: string,
  timestamp: number,
): number {
  return state.people.filter(
    (person) =>
      internalFromPerson(person).status === "active" &&
      person.role === roleId &&
      (!person.expiresAt || Date.parse(person.expiresAt) > timestamp),
  ).length;
}
