import { z } from "zod";

import type {
  AccessDefaults,
  AccessGroup,
  AccessIdentity,
  AccessRule,
  AccessScopeRef,
  AccessSubjectRef,
} from "../domain/policy";
import type { Role } from "../domain/model";

export const ACCESS_DRAFT_STORAGE_PREFIX = "openslate.access.draft.v1.";
const MAX_RECORD_LENGTH = 32_768;
type AccessDraftOwner = "rules" | "identity" | "role" | "group" | "defaults";

export type AccessDraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const subjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }).strict(),
  z.object({ kind: z.literal("role"), id: identifier }).strict(),
  z.object({ kind: z.literal("group"), id: identifier }).strict(),
  z.object({ kind: z.literal("identity"), id: identifier }).strict(),
]);
const scopeSchema = z
  .object({
    kind: z.enum([
      "workspace",
      "department",
      "module",
      "field",
      "board",
      "openview",
      "comms-category",
      "comms-channel",
    ]),
    id: identifier,
  })
  .strict();
const selectionSchema = z
  .object({ subject: subjectSchema, scope: scopeSchema })
  .strict();
const isoDateTime = z.iso.datetime({ offset: true }).max(64);
const ruleSchema = z
  .object({
    id: identifier,
    subject: subjectSchema,
    scope: scopeSchema,
    permissionId: identifier,
    decision: z.enum(["inherit", "allow", "deny"]),
    locked: z.boolean().optional(),
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
  })
  .strict();
const rulesPayloadSchema = z
  .object({
    selection: selectionSchema,
    drafts: z.array(ruleSchema).min(1).max(100),
    baselines: z.record(identifier, ruleSchema.nullable()),
  })
  .strict()
  .superRefine((payload, context) => {
    const seen = new Set<string>();
    for (const rule of payload.drafts) {
      if (seen.has(rule.permissionId)) {
        context.addIssue({ code: "custom", message: "Duplicate rule" });
        continue;
      }
      seen.add(rule.permissionId);
      if (
        rulesTarget({ subject: rule.subject, scope: rule.scope }) !==
        rulesTarget(payload.selection)
      )
        context.addIssue({ code: "custom", message: "Different rule target" });
      if (!Object.hasOwn(payload.baselines, rule.permissionId))
        context.addIssue({ code: "custom", message: "Missing baseline" });
      const baseline = payload.baselines[rule.permissionId];
      if (
        baseline &&
        (baseline.permissionId !== rule.permissionId ||
          rulesTarget({ subject: baseline.subject, scope: baseline.scope }) !==
            rulesTarget(payload.selection))
      )
        context.addIssue({
          code: "custom",
          message: "Different baseline target",
        });
    }
    if (Object.keys(payload.baselines).some((key) => !seen.has(key)))
      context.addIssue({ code: "custom", message: "Unmatched baseline" });
  });

export type AccessRulesDraft = {
  selection: { subject: AccessSubjectRef; scope: AccessScopeRef };
  drafts: AccessRule[];
  baselines: Record<string, AccessRule | null>;
};

const editableDefaultsSchema = z
  .object({
    defaultRoleId: identifier,
    defaultDepartmentIds: z.array(identifier).max(100),
    defaultGroupIds: z.array(identifier).max(100),
    invitationExpiryDays: z.number().int().min(0).max(999_999),
    guestDurationDays: z.number().int().min(0).max(999_999),
    serviceDurationDays: z.number().int().min(0).max(999_999),
  })
  .strict();
const defaultsPayloadSchema = z
  .object({
    baseline: editableDefaultsSchema,
    draft: editableDefaultsSchema,
  })
  .strict();

export type EditableAccessDefaults = Pick<
  AccessDefaults,
  | "defaultRoleId"
  | "defaultDepartmentIds"
  | "defaultGroupIds"
  | "invitationExpiryDays"
  | "guestDurationDays"
  | "serviceDurationDays"
>;
export type AccessDefaultsDraft = {
  baseline: EditableAccessDefaults;
  draft: EditableAccessDefaults;
};

const roleSchema = z
  .object({
    id: identifier,
    name: z.string().max(256),
    description: z.string().max(2_048).optional(),
    builtin: z.boolean(),
    grants: z.array(identifier).max(100),
  })
  .strict();
const roleValuesSchema = z
  .object({
    name: z.string().max(256),
    description: z.string().max(2_048),
    grants: z.array(identifier).max(100),
  })
  .strict();
const rolePayloadSchema = z
  .object({
    intent: z.enum(["create", "edit"]),
    baseline: roleSchema,
    values: roleValuesSchema,
  })
  .strict()
  .refine((value) => value.intent !== "edit" || !value.baseline.builtin);

export type AccessRoleDraft = {
  intent: "create" | "edit";
  baseline: Role;
  values: { name: string; description: string; grants: string[] };
};

const groupSchema = z
  .object({
    id: identifier,
    name: z.string().max(256),
    description: z.string().max(2_048),
    memberIds: z.array(identifier).max(500),
  })
  .strict();
const groupValuesSchema = groupSchema.omit({ id: true });
const groupPayloadSchema = z
  .object({
    intent: z.enum(["create", "edit"]),
    baseline: groupSchema,
    values: groupValuesSchema,
  })
  .strict();

export type AccessGroupDraft = {
  intent: "create" | "edit";
  baseline: AccessGroup;
  values: { name: string; description: string; memberIds: string[] };
};

const identityBase = {
  id: identifier,
  name: z.string().max(256),
  status: z.enum([
    "active",
    "pending",
    "disabled",
    "deleted",
    "revoked",
    "suspended",
  ]),
  roleId: identifier,
  groupIds: z.array(identifier).max(100),
  expiresAt: isoDateTime.optional(),
};
const draftExpiry = z.union([isoDateTime, z.literal("")]);
const identitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...identityBase,
      kind: z.literal("internal"),
      email: z.string().max(320),
      departmentIds: z.array(identifier).max(100),
      primaryDepartmentId: z.string().max(256),
      title: z.string().max(256),
    })
    .strict(),
  z
    .object({
      ...identityBase,
      kind: z.literal("guest"),
      email: z.string().max(320),
      sponsorId: z.string().max(256),
      expiresAt: draftExpiry,
    })
    .strict(),
  z
    .object({
      ...identityBase,
      kind: z.literal("service"),
      ownerId: z.string().max(256),
      purpose: z.string().max(2_048),
      expiresAt: draftExpiry,
    })
    .strict(),
]);
const identityPayloadSchema = z
  .object({
    mode: z.enum(["create", "edit"]),
    baseline: identitySchema,
    draft: identitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.baseline.id !== value.draft.id ||
      value.baseline.kind !== value.draft.kind
    )
      context.addIssue({
        code: "custom",
        message: "Different identity target",
      });
    if ((value.mode === "create") !== (value.baseline.id === "draft"))
      context.addIssue({ code: "custom", message: "Invalid identity mode" });
  });

export type AccessIdentityDraft = {
  mode: "create" | "edit";
  baseline: AccessIdentity;
  draft: AccessIdentity;
};

export function editableAccessIdentity(value: AccessIdentity): AccessIdentity {
  const base = {
    id: value.id,
    name: value.name,
    status: value.status,
    roleId: value.roleId,
    groupIds: [...value.groupIds],
  };
  if (value.kind === "internal")
    return {
      ...base,
      kind: "internal",
      email: value.email,
      departmentIds: [...value.departmentIds],
      primaryDepartmentId: value.primaryDepartmentId,
      title: value.title,
      ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    };
  if (value.kind === "guest")
    return {
      ...base,
      kind: "guest",
      email: value.email,
      sponsorId: value.sponsorId,
      expiresAt: value.expiresAt,
    };
  return {
    ...base,
    kind: "service",
    ownerId: value.ownerId,
    purpose: value.purpose,
    expiresAt: value.expiresAt,
  };
}

export function editableAccessDefaults(
  value: AccessDefaults,
): EditableAccessDefaults {
  return {
    defaultRoleId: value.defaultRoleId,
    defaultDepartmentIds: [...value.defaultDepartmentIds],
    defaultGroupIds: [...value.defaultGroupIds],
    invitationExpiryDays: value.invitationExpiryDays,
    guestDurationDays: value.guestDurationDays,
    serviceDurationDays: value.serviceDurationDays,
  };
}

type ReadResult<T> = {
  status: "ready" | "invalid" | "unavailable";
  value: T | null;
};

function browserStorage(): AccessDraftStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function accessDraftStorageKey(
  userId: string,
  owner: AccessDraftOwner,
): string {
  return `${userStoragePrefix(userId)}${owner}`;
}

function userStoragePrefix(userId: string): string {
  // encodeURIComponent leaves dots untouched; encode them to keep user keys
  // from prefix-matching another account's key during cleanup.
  return `${ACCESS_DRAFT_STORAGE_PREFIX}${encodeURIComponent(userId).replaceAll(".", "%2E")}.`;
}

function rulesTarget(selection: {
  subject: AccessSubjectRef;
  scope: AccessScopeRef;
}): string {
  const subject =
    selection.subject.kind === "everyone"
      ? "everyone"
      : `${selection.subject.kind}:${selection.subject.id}`;
  return `${subject}|${selection.scope.kind}:${selection.scope.id}`;
}

function readDraft<T>(
  userId: string,
  owner: AccessDraftOwner,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): ReadResult<T> {
  if (!storage) return { status: "unavailable", value: null };
  let raw: string | null;
  try {
    raw = storage.getItem(accessDraftStorageKey(userId, owner));
  } catch {
    return { status: "unavailable", value: null };
  }
  if (raw === null) return { status: "ready", value: null };
  if (raw.length > MAX_RECORD_LENGTH) return { status: "invalid", value: null };
  try {
    const data: unknown = JSON.parse(raw);
    const retired = z
      .object({
        version: z.literal(1),
        userId: identifier,
        owner: z.literal(owner),
        target: z.literal("retired"),
        state: z.literal("retired"),
      })
      .strict()
      .safeParse(data);
    if (retired.success)
      return retired.data.userId === userId
        ? { status: "ready", value: null }
        : { status: "invalid", value: null };
    const record = z
      .object({
        version: z.literal(1),
        userId: identifier,
        owner: z.literal(owner),
        target: z.string().min(1).max(600),
        payload: schema,
      })
      .strict()
      .safeParse(data);
    if (
      !record.success ||
      record.data.userId !== userId ||
      record.data.target !== target(record.data.payload)
    )
      return { status: "invalid", value: null };
    return { status: "ready", value: record.data.payload };
  } catch {
    return { status: "invalid", value: null };
  }
}

function writeDraft<T>(
  userId: string,
  owner: AccessDraftOwner,
  payload: T,
  schema: z.ZodType<T>,
  target: (value: T) => string,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  const parsed = schema.safeParse(payload);
  if (!identifier.safeParse(userId).success || !parsed.success) return false;
  const raw = JSON.stringify({
    version: 1,
    userId,
    owner,
    target: target(parsed.data),
    payload: parsed.data,
  });
  if (raw.length > MAX_RECORD_LENGTH) return false;
  try {
    storage.setItem(accessDraftStorageKey(userId, owner), raw);
    return true;
  } catch {
    return false;
  }
}

function clearDraft(
  userId: string,
  owner: AccessDraftOwner,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  const key = accessDraftStorageKey(userId, owner);
  let retired = false;
  try {
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        userId,
        owner,
        target: "retired",
        state: "retired",
      }),
    );
    retired = true;
  } catch {
    // Removal may still succeed when writing is unavailable.
  }
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return retired;
  }
}

export function readAccessRulesDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessRulesDraft> {
  return readDraft(
    userId,
    "rules",
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
  );
}

export function writeAccessRulesDraft(
  userId: string,
  payload: AccessRulesDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "rules",
    payload,
    rulesPayloadSchema,
    (value) => rulesTarget(value.selection),
    storage,
  );
}

export function clearAccessRulesDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, "rules", storage);
}

export function readAccessDefaultsDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessDefaultsDraft> {
  return readDraft(
    userId,
    "defaults",
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
  );
}

export function writeAccessDefaultsDraft(
  userId: string,
  payload: AccessDefaultsDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "defaults",
    payload,
    defaultsPayloadSchema,
    () => "workspace-defaults",
    storage,
  );
}

export function clearAccessDefaultsDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, "defaults", storage);
}

export function readAccessRoleDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessRoleDraft> {
  return readDraft(
    userId,
    "role",
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function writeAccessRoleDraft(
  userId: string,
  payload: AccessRoleDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "role",
    payload,
    rolePayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function clearAccessRoleDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, "role", storage);
}

export function readAccessGroupDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessGroupDraft> {
  return readDraft(
    userId,
    "group",
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function writeAccessGroupDraft(
  userId: string,
  payload: AccessGroupDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "group",
    payload,
    groupPayloadSchema,
    (value) => `${value.intent}:${value.baseline.id}`,
    storage,
  );
}

export function clearAccessGroupDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, "group", storage);
}

export function readAccessIdentityDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): ReadResult<AccessIdentityDraft> {
  return readDraft(
    userId,
    "identity",
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
  );
}

export function writeAccessIdentityDraft(
  userId: string,
  payload: AccessIdentityDraft,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return writeDraft(
    userId,
    "identity",
    {
      mode: payload.mode,
      baseline: editableAccessIdentity(payload.baseline),
      draft: editableAccessIdentity(payload.draft),
    },
    identityPayloadSchema,
    (value) => `${value.mode}:${value.baseline.id}`,
    storage,
  );
}

export function clearAccessIdentityDraft(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearDraft(userId, "identity", storage);
}

function clearKeys(
  shouldClear: (key: string) => boolean,
  storage: AccessDraftStorage | undefined,
): boolean {
  if (!storage) return false;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && shouldClear(key)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function clearAccessDraftStorageForUser(
  userId: string,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  return clearKeys((key) => key.startsWith(userStoragePrefix(userId)), storage);
}

export function clearAccessDraftStorageExcept(
  userId: string | null,
  storage: AccessDraftStorage | undefined = browserStorage(),
): boolean {
  const keep = userId === null ? null : userStoragePrefix(userId);
  return clearKeys(
    (key) =>
      key.startsWith(ACCESS_DRAFT_STORAGE_PREFIX) &&
      (keep === null || !key.startsWith(keep)),
    storage,
  );
}
