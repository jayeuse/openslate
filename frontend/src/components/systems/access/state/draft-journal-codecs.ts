import { z } from "zod";

import { draftIdentifier } from "./draft-journal-storage";

import type {
  AccessDefaults,
  AccessGroup,
  AccessIdentity,
  AccessRule,
  AccessScopeRef,
  AccessSubjectRef,
} from "../domain/policy";
import type { Role } from "../domain/model";

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("everyone") }).strict(),
  z.object({ kind: z.literal("role"), id: draftIdentifier }).strict(),
  z.object({ kind: z.literal("group"), id: draftIdentifier }).strict(),
  z.object({ kind: z.literal("identity"), id: draftIdentifier }).strict(),
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
    id: draftIdentifier,
  })
  .strict();
const selectionSchema = z
  .object({ subject: subjectSchema, scope: scopeSchema })
  .strict();
const isoDateTime = z.iso.datetime({ offset: true }).max(64);
const ruleSchema = z
  .object({
    id: draftIdentifier,
    subject: subjectSchema,
    scope: scopeSchema,
    permissionId: draftIdentifier,
    decision: z.enum(["inherit", "allow", "deny"]),
    locked: z.boolean().optional(),
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
  })
  .strict();
export const rulesPayloadSchema = z
  .object({
    selection: selectionSchema,
    drafts: z.array(ruleSchema).min(1).max(100),
    baselines: z.record(draftIdentifier, ruleSchema.nullable()),
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
    defaultRoleId: draftIdentifier,
    defaultDepartmentIds: z.array(draftIdentifier).max(100),
    defaultGroupIds: z.array(draftIdentifier).max(100),
    invitationExpiryDays: z.number().int().min(0).max(999_999),
    guestDurationDays: z.number().int().min(0).max(999_999),
    serviceDurationDays: z.number().int().min(0).max(999_999),
  })
  .strict();
export const defaultsPayloadSchema = z
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
    id: draftIdentifier,
    name: z.string().max(256),
    description: z.string().max(2_048).optional(),
    builtin: z.boolean(),
    grants: z.array(draftIdentifier).max(100),
  })
  .strict();
const roleValuesSchema = z
  .object({
    name: z.string().max(256),
    description: z.string().max(2_048),
    grants: z.array(draftIdentifier).max(100),
  })
  .strict();
export const rolePayloadSchema = z
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
    id: draftIdentifier,
    name: z.string().max(256),
    description: z.string().max(2_048),
    memberIds: z.array(draftIdentifier).max(500),
  })
  .strict();
const groupValuesSchema = groupSchema.omit({ id: true });
export const groupPayloadSchema = z
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
  id: draftIdentifier,
  name: z.string().max(256),
  status: z.enum([
    "active",
    "pending",
    "disabled",
    "deleted",
    "revoked",
    "suspended",
  ]),
  roleId: draftIdentifier,
  groupIds: z.array(draftIdentifier).max(100),
  expiresAt: isoDateTime.optional(),
};
const draftExpiry = z.union([isoDateTime, z.literal("")]);
const identitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...identityBase,
      kind: z.literal("internal"),
      email: z.string().max(320),
      departmentIds: z.array(draftIdentifier).max(100),
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
export const identityPayloadSchema = z
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

export function rulesTarget(selection: {
  subject: AccessSubjectRef;
  scope: AccessScopeRef;
}): string {
  const subject =
    selection.subject.kind === "everyone"
      ? "everyone"
      : `${selection.subject.kind}:${selection.subject.id}`;
  return `${subject}|${selection.scope.kind}:${selection.scope.id}`;
}
