import type { Role } from "./model";
import type {
  AccessDefaults,
  AccessGroup,
  AccessRule,
  AccessTemplate,
} from "./policy";

export type PolicyBundleGroup = Omit<AccessGroup, "memberIds">;
export type PolicyBundleRole = Omit<Role, "builtin"> & { description: string };

export type AccessPolicyBundleV1 = {
  version: 1;
  defaults: AccessDefaults;
  groups: PolicyBundleGroup[];
  roles: PolicyBundleRole[];
  rules: AccessRule[];
  templates: AccessTemplate[];
};

const MAX_BUNDLE_BYTES = 1024 * 1024;
const scopeKinds = new Set([
  "workspace",
  "department",
  "module",
  "field",
  "board",
  "openview",
  "comms-category",
  "comms-channel",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validDefaults(value: unknown): value is AccessDefaults {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "defaultRoleId",
      "defaultDepartmentIds",
      "defaultGroupIds",
      "invitationExpiryDays",
      "guestDurationDays",
      "serviceDurationDays",
      "defaultDeny",
      "requireGuestSponsor",
      "requireServiceOwner",
    ])
  )
    return false;
  return (
    typeof value.defaultRoleId === "string" &&
    isStringArray(value.defaultDepartmentIds) &&
    isStringArray(value.defaultGroupIds) &&
    isPositiveInteger(value.invitationExpiryDays) &&
    isPositiveInteger(value.guestDurationDays) &&
    isPositiveInteger(value.serviceDurationDays) &&
    value.defaultDeny === true &&
    value.requireGuestSponsor === true &&
    value.requireServiceOwner === true
  );
}

function validGroup(value: unknown): value is PolicyBundleGroup {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "description"]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string"
  );
}

function validRole(value: unknown): value is PolicyBundleRole {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "description", "grants"]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isStringArray(value.grants)
  );
}

function validSubject(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "everyone") return hasOnlyKeys(value, ["kind"]);
  return (
    (value.kind === "role" || value.kind === "group") &&
    hasOnlyKeys(value, ["kind", "id"]) &&
    typeof value.id === "string"
  );
}

function validScope(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "id"]) &&
    typeof value.kind === "string" &&
    scopeKinds.has(value.kind) &&
    typeof value.id === "string"
  );
}

function validOptionalTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function validRule(value: unknown): value is AccessRule {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(
      value,
      ["id", "subject", "scope", "permissionId", "decision"],
      ["locked", "startsAt", "endsAt"],
    )
  )
    return false;
  return (
    typeof value.id === "string" &&
    validSubject(value.subject) &&
    validScope(value.scope) &&
    typeof value.permissionId === "string" &&
    ["inherit", "allow", "deny"].includes(String(value.decision)) &&
    (value.locked === undefined || typeof value.locked === "boolean") &&
    validOptionalTimestamp(value.startsAt) &&
    validOptionalTimestamp(value.endsAt) &&
    !(
      typeof value.startsAt === "string" &&
      typeof value.endsAt === "string" &&
      Date.parse(value.startsAt) >= Date.parse(value.endsAt)
    )
  );
}

function validTemplate(value: unknown): value is AccessTemplate {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "name",
      "description",
      "identityKind",
      "grants",
    ]) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    ["internal", "guest", "service"].includes(String(value.identityKind)) &&
    isStringArray(value.grants)
  );
}

function uniqueIds(values: readonly { id: string }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}

function cloneBundle(value: AccessPolicyBundleV1): AccessPolicyBundleV1 {
  return structuredClone(value);
}

export function createPolicyBundle(input: {
  defaults: AccessDefaults;
  groups: readonly AccessGroup[];
  roles: readonly Role[];
  rules: readonly AccessRule[];
  templates: readonly AccessTemplate[];
}): AccessPolicyBundleV1 {
  return {
    version: 1,
    defaults: structuredClone(input.defaults),
    groups: input.groups.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    roles: input.roles
      .filter((role) => !role.builtin)
      .map(({ id, name, description, grants }) => ({
        id,
        name,
        description: description ?? "",
        grants: [...grants],
      })),
    rules: input.rules
      .filter((rule) => rule.subject.kind !== "identity")
      .map((rule) => structuredClone(rule)),
    templates: input.templates.map((template) => structuredClone(template)),
  };
}

export function parsePolicyBundle(
  text: string,
): { ok: true; value: AccessPolicyBundleV1 } | { ok: false; error: string } {
  if (new TextEncoder().encode(text).byteLength > MAX_BUNDLE_BYTES)
    return { ok: false, error: "Policy bundle exceeds the 1 MiB limit." };

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "Policy bundle is not valid JSON." };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "defaults",
      "groups",
      "roles",
      "rules",
      "templates",
    ]) ||
    value.version !== 1 ||
    !validDefaults(value.defaults) ||
    !Array.isArray(value.groups) ||
    !value.groups.every(validGroup) ||
    !Array.isArray(value.roles) ||
    !value.roles.every(validRole) ||
    !Array.isArray(value.rules) ||
    !value.rules.every(validRule) ||
    !Array.isArray(value.templates) ||
    !value.templates.every(validTemplate) ||
    !uniqueIds(value.groups) ||
    !uniqueIds(value.roles) ||
    !uniqueIds(value.rules) ||
    !uniqueIds(value.templates)
  )
    return {
      ok: false,
      error: "Policy bundle does not match the version 1 schema.",
    };

  return { ok: true, value: value as AccessPolicyBundleV1 };
}

function mergeById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const additions = incoming.filter(
    (incomingItem) => !current.some((item) => item.id === incomingItem.id),
  );
  return [
    ...current.map(
      (item) => incoming.find((candidate) => candidate.id === item.id) ?? item,
    ),
    ...additions,
  ].map((item) => structuredClone(item));
}

export function planPolicyImport(
  current: AccessPolicyBundleV1,
  incoming: AccessPolicyBundleV1,
  mode: "merge" | "replace",
  protectedRoles: readonly Role[],
): {
  bundle: AccessPolicyBundleV1;
  protectedRoles: Role[];
  summary: string;
} {
  const bundle =
    mode === "replace"
      ? cloneBundle(incoming)
      : {
          version: 1 as const,
          defaults: structuredClone(incoming.defaults),
          groups: mergeById(current.groups, incoming.groups),
          roles: mergeById(current.roles, incoming.roles),
          rules: mergeById(current.rules, incoming.rules),
          templates: mergeById(current.templates, incoming.templates),
        };
  return {
    bundle,
    protectedRoles: protectedRoles
      .filter((role) => role.builtin)
      .map((role) => structuredClone(role)),
    summary: `${mode === "merge" ? "Merge" : "Replace"} ${bundle.roles.length} custom roles, ${bundle.groups.length} groups, and ${bundle.rules.length} rules.`,
  };
}
