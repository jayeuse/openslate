import { changedPatch } from "./editor-helpers";
import type {
  AccessController,
  CreateIdentityInput,
  UpdateIdentityPatch,
} from "../state/controller";
import {
  type AccessIdentity,
  type AccessIdentityStatus,
} from "../domain/policy";

export type ConfirmationMode =
  "delete" | "admin-change" | "destructive-action" | null;
export type EditableField = keyof UpdateIdentityPatch;
export type ReviewedAction =
  | {
      type: "enable" | "disable" | "revoke-invite" | "delete";
      identity: AccessIdentity;
    }
  | {
      type: "revoke-session";
      identity: AccessIdentity;
      sessionId: string;
      sessionLabel: string;
    }
  | { type: "revoke-all-sessions"; identity: AccessIdentity; count: number };
export type PendingReview =
  | { kind: "create"; identity: AccessIdentity }
  | {
      kind: "update";
      before: AccessIdentity;
      after: AccessIdentity;
      patch: UpdateIdentityPatch;
    }
  | { kind: "action"; action: ReviewedAction };

export const statusLabels: Record<AccessIdentityStatus, string> = {
  active: "Active",
  pending: "Invitation pending",
  disabled: "Disabled",
  deleted: "Deleted",
  revoked: "Invitation revoked",
  suspended: "Suspended",
};

export function datetimeLocal(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
}

export function isoDate(value: string): string {
  return value ? new Date(value).toISOString() : "";
}

export function createDraft(
  kind: AccessIdentity["kind"],
  controller: AccessController,
): AccessIdentity {
  const { defaults } = controller.state;
  const expiry = new Date();
  expiry.setDate(
    expiry.getDate() +
      (kind === "guest"
        ? defaults.guestDurationDays
        : defaults.serviceDurationDays),
  );
  const base = {
    id: "draft",
    name: "",
    status: kind === "service" ? ("active" as const) : ("pending" as const),
    roleId: defaults.defaultRoleId,
    groupIds: kind === "service" ? [] : [...defaults.defaultGroupIds],
  };
  if (kind === "internal") {
    return {
      ...base,
      kind,
      email: "",
      departmentIds: [...defaults.defaultDepartmentIds],
      primaryDepartmentId: defaults.defaultDepartmentIds[0] ?? "",
      title: "",
    };
  }
  if (kind === "guest") {
    return {
      ...base,
      kind,
      email: "",
      sponsorId: "",
      expiresAt: expiry.toISOString(),
    };
  }
  return {
    ...base,
    kind,
    ownerId: "",
    purpose: "",
    expiresAt: expiry.toISOString(),
    credentialState: "not-created",
  };
}

export function copyIdentity(identity: AccessIdentity): AccessIdentity {
  return {
    ...identity,
    groupIds: [...identity.groupIds],
    ...(identity.kind === "internal"
      ? { departmentIds: [...identity.departmentIds] }
      : {}),
  };
}

export function identityToCreateInput(
  identity: AccessIdentity,
): CreateIdentityInput {
  const base = {
    name: identity.name,
    status: identity.status,
    roleId: identity.roleId,
    groupIds: identity.groupIds,
  };
  if (identity.kind === "internal")
    return {
      ...base,
      kind: "internal",
      email: identity.email,
      departmentIds: identity.departmentIds,
      primaryDepartmentId: identity.primaryDepartmentId,
      title: identity.title,
      ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {}),
    };
  if (identity.kind === "guest")
    return {
      ...base,
      kind: "guest",
      email: identity.email,
      sponsorId: identity.sponsorId,
      expiresAt: identity.expiresAt,
    };
  return {
    ...base,
    kind: "service",
    ownerId: identity.ownerId,
    purpose: identity.purpose,
    expiresAt: identity.expiresAt,
    ...(identity.credentialState
      ? { credentialState: identity.credentialState }
      : {}),
  };
}

export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function identityValue(
  identity: AccessIdentity,
  field: EditableField,
): unknown {
  if (field in identity) return identity[field as keyof AccessIdentity];
  return undefined;
}

export function changedIdentityPatch(
  baseline: AccessIdentity,
  draft: AccessIdentity,
): UpdateIdentityPatch {
  const fields: EditableField[] = [
    "name",
    "status",
    "roleId",
    "groupIds",
    "expiresAt",
  ];
  if (baseline.kind === "internal" && draft.kind === "internal")
    fields.push("email", "departmentIds", "primaryDepartmentId", "title");
  else if (baseline.kind === "guest" && draft.kind === "guest")
    fields.push("email", "sponsorId");
  else if (baseline.kind === "service" && draft.kind === "service")
    fields.push("ownerId", "purpose");
  return changedPatch(
    baseline,
    draft,
    fields as (keyof AccessIdentity)[],
    sameValue,
  ) as UpdateIdentityPatch;
}

export const fieldLabels: Record<EditableField, string> = {
  name: "Name",
  status: "Status",
  roleId: "Role",
  groupIds: "Groups",
  expiresAt: "Expiry",
  email: "Email",
  departmentIds: "Departments",
  primaryDepartmentId: "Primary department",
  title: "Job title",
  sponsorId: "Sponsor",
  ownerId: "Owner",
  purpose: "Purpose",
};

export function comparisonFields(
  kind: AccessIdentity["kind"],
): EditableField[] {
  const common: EditableField[] = [
    "name",
    "status",
    "roleId",
    "groupIds",
    "expiresAt",
  ];
  if (kind === "internal")
    return [
      ...common,
      "email",
      "departmentIds",
      "primaryDepartmentId",
      "title",
    ];
  if (kind === "guest") return [...common, "email", "sponsorId"];
  return [...common, "ownerId", "purpose"];
}

export function comparisonValue(
  identity: AccessIdentity | null,
  field: EditableField,
  controller: AccessController,
): string {
  if (!identity) return "No matching identity";
  const roleName = (id: string) =>
    controller.state.roles.find((role) => role.id === id)?.name ?? id;
  const groupName = (id: string) =>
    controller.state.groups.find((group) => group.id === id)?.name ?? id;
  const departmentName = (id: string) => {
    const active = controller.departmentCatalog.find(
      (department) => department.id === id,
    );
    if (active) return active.name;
    for (const person of controller.state.people) {
      const index = person.departmentIds?.indexOf(id) ?? -1;
      if (index >= 0) return person.departments[index] ?? id;
    }
    return id;
  };
  const identityName = (id: string) =>
    [
      ...controller.state.identities,
      ...controller.state.deletedIdentities.map((item) => item.identity),
    ].find((item) => item.id === id)?.name ?? id;
  const list = (values: string[]) => values.join(", ") || "None";

  switch (field) {
    case "name":
      return identity.name || "None";
    case "status":
      return statusLabels[identity.status];
    case "roleId":
      return roleName(identity.roleId);
    case "groupIds":
      return list(identity.groupIds.map(groupName));
    case "expiresAt":
      return identity.expiresAt
        ? new Date(identity.expiresAt).toLocaleString()
        : "None";
    case "email":
      return identity.kind === "service" ? "Not applicable" : identity.email;
    case "departmentIds":
      return identity.kind === "internal"
        ? list(identity.departmentIds.map(departmentName))
        : "Not applicable";
    case "primaryDepartmentId":
      return identity.kind === "internal"
        ? identity.primaryDepartmentId
          ? departmentName(identity.primaryDepartmentId)
          : "None"
        : "Not applicable";
    case "title":
      return identity.kind === "internal"
        ? identity.title || "None"
        : "Not applicable";
    case "sponsorId":
      return identity.kind === "guest"
        ? identity.sponsorId
          ? identityName(identity.sponsorId)
          : "None"
        : "Not applicable";
    case "ownerId":
      return identity.kind === "service"
        ? identity.ownerId
          ? identityName(identity.ownerId)
          : "None"
        : "Not applicable";
    case "purpose":
      return identity.kind === "service"
        ? identity.purpose || "None"
        : "Not applicable";
  }
}

export const reviewedActionLabels: Record<ReviewedAction["type"], string> = {
  enable: "Enable identity",
  disable: "Disable identity",
  "revoke-invite": "Revoke invitation",
  delete: "Delete identity",
  "revoke-session": "Revoke one session",
  "revoke-all-sessions": "Revoke all remote sessions",
};

export function reviewedActionImpact(action: ReviewedAction): string {
  if (action.type === "enable")
    return "Status becomes active. Expiry and policy may still limit access.";
  if (action.type === "disable")
    return "Removed: this identity will lose active access until restored.";
  if (action.type === "revoke-invite")
    return "The existing invitation link will no longer grant access. The profile remains in Access and can be resent.";
  if (action.type === "delete")
    return "Removed: the identity, memberships, and sessions leave the active directory.";
  if (action.type === "revoke-session")
    return `Removed: ${action.sessionLabel} will end; other identity access remains.`;
  if (action.type === "revoke-all-sessions")
    return `Removed: ${action.count} remote ${action.count === 1 ? "session" : "sessions"} will end; the current session remains protected.`;
  return "Removed: access will be reduced.";
}

export function membershipLabels(
  identity: AccessIdentity,
  controller: AccessController,
  historical: AccessIdentity = identity,
): string[] {
  const groups = identity.groupIds.map(
    (id) =>
      controller.state.groups.find((group) => group.id === id)?.name ?? id,
  );
  if (identity.kind !== "internal") return groups;
  const historicalPerson = controller.state.people.find(
    (person) => person.id === historical.id,
  );
  const historicalNames = new Map(
    historicalPerson
      ? (
          historicalPerson.departmentIds ??
          (historical.kind === "internal" ? historical.departmentIds : [])
        ).map((id, index) => [id, historicalPerson.departments[index]])
      : [],
  );
  return [
    ...identity.departmentIds.map(
      (id) =>
        controller.departmentCatalog.find((department) => department.id === id)
          ?.name ??
        historicalNames.get(id) ??
        "Closed department",
    ),
    ...groups,
  ];
}

export function accessImpact(
  before: AccessIdentity | null,
  after: AccessIdentity,
  controller: AccessController,
): string {
  if (!before && after.roleId === controller.adminRoleId)
    return "Elevated: new Administrator access is prepared and remains pending until active.";
  if (!before)
    return after.status === "active"
      ? "Elevated: a new active identity will receive access."
      : "Prepared: access remains unavailable until the invitation is active.";
  if (before.status !== "active" && after.status === "active")
    return "Elevated: inactive access will become active.";
  if (before.status === "active" && after.status !== "active")
    return "Removed: active access will be unavailable.";
  if (before.roleId !== after.roleId) {
    if (after.roleId === controller.adminRoleId)
      return "Elevated: the identity will become an Administrator.";
    if (before.roleId === controller.adminRoleId)
      return "Removed: Administrator access will be removed.";
    const beforeCount =
      controller.state.roles.find((role) => role.id === before.roleId)?.grants
        .length ?? 0;
    const afterCount =
      controller.state.roles.find((role) => role.id === after.roleId)?.grants
        .length ?? 0;
    if (afterCount > beforeCount)
      return "Elevated: the selected role has more explicit grants.";
    if (afterCount < beforeCount)
      return "Removed: the selected role has fewer explicit grants.";
    return "Changed: the role changes without a clear grant-count increase.";
  }
  if (before.expiresAt !== after.expiresAt) {
    if (!before.expiresAt && after.expiresAt)
      return "Removed: access now has an expiry boundary.";
    if (before.expiresAt && !after.expiresAt)
      return "Elevated: the previous expiry boundary is removed.";
    const beforeExpiry = Date.parse(before.expiresAt ?? "");
    const afterExpiry = Date.parse(after.expiresAt ?? "");
    if (afterExpiry > beforeExpiry)
      return "Elevated: the access period is extended.";
    if (afterExpiry < beforeExpiry)
      return "Removed: the access period is shortened.";
  }
  const beforeMembership = new Set(membershipLabels(before, controller));
  const afterMembership = new Set(membershipLabels(after, controller, before));
  const added = [...afterMembership].some(
    (item) => !beforeMembership.has(item),
  );
  const removed = [...beforeMembership].some(
    (item) => !afterMembership.has(item),
  );
  if (added && removed)
    return "Changed: memberships are both added and removed.";
  if (added) return "Elevated: one or more memberships are added.";
  if (removed) return "Removed: one or more memberships are removed.";
  return "Unchanged: no direct role, status, or membership access change.";
}
