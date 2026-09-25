import { z } from "zod";

import {
  apiFetch,
  apiFetchWithMetadata,
  ApiContractError,
  type ApiRequestInit,
} from "@/lib/api";

export const ACCESS_CAPABILITY_IDS = [
  "departments.read",
  "departments.write",
  "modules.read",
  "modules.write",
  "fields.read",
  "fields.write",
  "records.read",
  "records.write",
  "relationships.read",
  "relationships.write",
] as const;

export type AccessCapabilityId = (typeof ACCESS_CAPABILITY_IDS)[number];
export type AccessUserStatus = "pending" | "active" | "disabled";
export type AccessIdentityKind = "internal" | "guest";
export type AccessDeletedFilter = "exclude" | "include" | "only";
export type AccessSortOrder = "asc" | "desc";

export type AccessCapability = {
  id: AccessCapabilityId;
  label: string;
  description: string;
  group: string;
};

export type AccessPagination = {
  limit: number;
  offset: number;
  count: number;
  total: number;
  has_more: boolean;
};

export type AccessPage<Item> = {
  items: Item[];
  pagination: AccessPagination;
};

export type AccessUser = {
  id: string;
  email: string;
  username: string;
  status: AccessUserStatus;
  role_id: string;
  display_name: string | null;
  identity_kind: AccessIdentityKind;
  job_title: string | null;
  sponsor_user_id: string | null;
  expires_at: string | null;
  department_ids: string[];
  primary_department_id: string | null;
  invitation_sent_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type AccessDepartment = {
  id: string;
  department_name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type AccessInvitationResponse = {
  user: AccessUser;
  delivery: "temporary_password" | "email";
  temporary_password: string | null;
};

export type AccessUserCreate = {
  email: string;
  username: string;
  role_id?: string | null;
  display_name?: string | null;
  identity_kind?: AccessIdentityKind;
  job_title?: string | null;
  sponsor_user_id?: string | null;
  expires_at?: string | null;
  department_ids?: string[];
  primary_department_id?: string | null;
};

export type AccessUserPatch = {
  username?: string;
  role_id?: string;
  status?: Extract<AccessUserStatus, "active" | "disabled">;
  display_name?: string | null;
  job_title?: string | null;
  sponsor_user_id?: string;
  expires_at?: string | null;
  department_ids?: string[];
  primary_department_id?: string | null;
};

export type AccessRolePermissions = Partial<
  Record<AccessCapabilityId, boolean>
>;

export type AccessRole = {
  id: string;
  role: string;
  description: string | null;
  permissions: AccessRolePermissions;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type AccessRoleCreate = {
  role: string;
  description?: string | null;
  permissions?: AccessRolePermissions;
};

export type AccessRolePatch = {
  role?: string;
  description?: string | null;
  permissions?: AccessRolePermissions;
};

export type AccessSession = {
  id: string;
  created_at: string;
  refreshed_at: string;
  expires_at: string;
  user_agent: string | null;
  current: boolean;
};

export type AccessCheckRequest = {
  principal_kind: "user" | "service";
  principal_id: string;
  permission_id: AccessCapabilityId;
  scope_kind: "workspace";
};

export type AccessCheckReason =
  | "administrator_protected"
  | "principal_inactive"
  | "principal_deleted"
  | "principal_expired"
  | "invalid_input"
  | "invalid_rule"
  | "rule_allow"
  | "rule_deny"
  | "legacy_role_allow"
  | "default_deny";

export type AccessCheckResponse = AccessCheckRequest & {
  policy_decision: "allow" | "deny";
  reason: AccessCheckReason;
  source_rule_id: string | null;
  policy_revision: number;
  checked_at: string;
  runtime_supported: boolean;
};

type RequestOptions = { signal?: AbortSignal };

type StandardListOptions<SortBy extends string> = RequestOptions & {
  limit?: number;
  offset?: number;
  sort_by?: SortBy;
  sort_order?: AccessSortOrder;
  search?: string;
  deleted?: AccessDeletedFilter;
};

export type AccessUserListOptions = StandardListOptions<
  "email" | "username" | "created_at" | "updated_at"
> & { role_id?: string };

export type AccessRoleListOptions = StandardListOptions<
  "role" | "created_at" | "updated_at"
>;

export type AccessDepartmentListOptions = StandardListOptions<
  "department_name" | "created_at" | "updated_at"
>;

export type AccessSessionListOptions = RequestOptions & {
  limit?: number;
  offset?: number;
};

const capabilityIdSchema = z.enum(ACCESS_CAPABILITY_IDS);
const dateTimeSchema = z.string().datetime({ offset: true });
const accessCheckRequestSchema = z.strictObject({
  principal_kind: z.enum(["user", "service"]),
  principal_id: z.string().uuid(),
  permission_id: capabilityIdSchema,
  scope_kind: z.literal("workspace"),
});
const accessCheckResponseSchema = z.strictObject({
  ...accessCheckRequestSchema.shape,
  policy_decision: z.enum(["allow", "deny"]),
  reason: z.enum([
    "administrator_protected",
    "principal_inactive",
    "principal_deleted",
    "principal_expired",
    "invalid_input",
    "invalid_rule",
    "rule_allow",
    "rule_deny",
    "legacy_role_allow",
    "default_deny",
  ]),
  source_rule_id: z.string().uuid().nullable(),
  policy_revision: z.number().int().positive(),
  checked_at: dateTimeSchema,
  runtime_supported: z.boolean(),
});
const paginationSchema = z.strictObject({
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
const capabilitySchema = z.strictObject({
  id: capabilityIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  group: z.string().min(1),
});
const userSchema = z.strictObject({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string().min(1),
  status: z.enum(["pending", "active", "disabled"]),
  role_id: z.string().uuid(),
  display_name: z.string().nullable(),
  identity_kind: z.enum(["internal", "guest"]),
  job_title: z.string().nullable(),
  sponsor_user_id: z.string().uuid().nullable(),
  expires_at: dateTimeSchema.nullable(),
  department_ids: z.array(z.string().uuid()),
  primary_department_id: z.string().uuid().nullable(),
  invitation_sent_at: dateTimeSchema.nullable(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  deleted_at: dateTimeSchema.nullable(),
  is_deleted: z.boolean(),
  performed_by: z.string().uuid().nullable(),
});
const departmentSchema = z.strictObject({
  id: z.string().uuid(),
  department_name: z.string().min(1),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  deleted_at: dateTimeSchema.nullable(),
  is_deleted: z.boolean(),
  performed_by: z.string().uuid().nullable(),
});
const rolePermissionsSchema = z
  .record(z.string(), z.boolean())
  .refine((permissions) =>
    Object.keys(permissions).every((key) =>
      ACCESS_CAPABILITY_IDS.includes(key as AccessCapabilityId),
    ),
  );
const roleSchema = z.strictObject({
  id: z.string().uuid(),
  role: z.string().min(1),
  description: z.string().nullable(),
  permissions: rolePermissionsSchema,
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  deleted_at: dateTimeSchema.nullable(),
  is_deleted: z.boolean(),
  performed_by: z.string().uuid().nullable(),
});
const invitationSchema = z.strictObject({
  user: userSchema,
  delivery: z.enum(["temporary_password", "email"]),
  temporary_password: z.string().nullable(),
});
const sessionSchema = z.strictObject({
  id: z.string().uuid(),
  created_at: dateTimeSchema,
  refreshed_at: dateTimeSchema,
  expires_at: dateTimeSchema,
  user_agent: z.string().nullable(),
  current: z.boolean(),
});
const accessGroupSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  revision: z.number().int().nonnegative(),
  member_ids: z.array(z.string().uuid()).max(100),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  deleted_at: dateTimeSchema.nullable(),
  is_deleted: z.boolean(),
  performed_by: z.string().uuid().nullable(),
});
const accessDefaultsSchema = z.strictObject({
  id: z.string().uuid(),
  default_role_id: z.string().uuid(),
  group_ids: z.array(z.string().uuid()).max(100),
  department_ids: z.array(z.string().uuid()).max(100),
  invitation_expiry_days: z.number().int().min(1).max(365),
  guest_duration_days: z.number().int().min(1).max(365),
  service_duration_days: z.number().int().min(1).max(365),
  default_deny: z.boolean(),
  require_guest_sponsor: z.boolean(),
  require_service_owner: z.boolean(),
  revision: z.number().int().nonnegative(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  deleted_at: dateTimeSchema.nullable(),
  is_deleted: z.boolean(),
  performed_by: z.string().uuid().nullable(),
});
const serviceIdentitySchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  purpose: z.string().min(1),
  owner_id: z.string().uuid(),
  role_id: z.string().uuid(),
  expires_at: dateTimeSchema,
  status: z.enum(["active", "disabled"]),
  effective_status: z.enum(["active", "disabled", "expired", "deleted"]),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  deleted_at: dateTimeSchema.nullable(),
  is_deleted: z.boolean(),
  performed_by: z.string().uuid().nullable(),
});
const accessRuleSubjectKindSchema = z.enum([
  "everyone",
  "role",
  "group",
  "user",
  "service",
]);
const accessRuleScopeKindSchema = z.enum([
  "workspace",
  "department",
  "module",
  "field",
]);
const accessRuleDecisionSchema = z.enum(["inherit", "allow", "deny"]);
const accessPolicyRuleCommandSchema = z
  .strictObject({
    subject_kind: accessRuleSubjectKindSchema,
    subject_id: z.string().uuid().nullable(),
    scope_kind: accessRuleScopeKindSchema,
    scope_id: z.string().uuid().nullable(),
    permission_id: capabilityIdSchema,
    decision: accessRuleDecisionSchema,
    starts_at: dateTimeSchema.nullable(),
    ends_at: dateTimeSchema.nullable(),
    locked: z.boolean(),
  })
  .superRefine((value, context) => {
    if ((value.subject_kind === "everyone") !== (value.subject_id === null))
      context.addIssue({ code: "custom", message: "Invalid rule subject." });
    if ((value.scope_kind === "workspace") !== (value.scope_id === null))
      context.addIssue({ code: "custom", message: "Invalid rule scope." });
    if (
      value.starts_at !== null &&
      value.ends_at !== null &&
      Date.parse(value.starts_at) >= Date.parse(value.ends_at)
    )
      context.addIssue({ code: "custom", message: "Invalid rule window." });
  });
const accessPolicyRuleSchema = accessPolicyRuleCommandSchema.extend({
  id: z.string().uuid(),
  policy_version: z.number().int().positive(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  deleted_at: dateTimeSchema.nullable(),
  is_deleted: z.boolean(),
  performed_by: z.string().uuid().nullable(),
});
const accessPolicyRulePatchSchema = z
  .strictObject({
    subject_kind: accessRuleSubjectKindSchema.optional(),
    subject_id: z.string().uuid().nullable().optional(),
    scope_kind: accessRuleScopeKindSchema.optional(),
    scope_id: z.string().uuid().nullable().optional(),
    permission_id: capabilityIdSchema.optional(),
    decision: accessRuleDecisionSchema.optional(),
    starts_at: dateTimeSchema.nullable().optional(),
    ends_at: dateTimeSchema.nullable().optional(),
    locked: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Rule patch must include at least one field",
  });
const accessPolicyRuleBatchOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    rule: accessPolicyRuleCommandSchema,
  }),
  z.strictObject({
    type: z.literal("update"),
    rule_id: z.string().uuid(),
    patch: accessPolicyRulePatchSchema,
  }),
  z.strictObject({ type: z.literal("delete"), rule_id: z.string().uuid() }),
]);
const accessPolicyRuleBatchRequestSchema = z.strictObject({
  base_revision: z.number().int().positive(),
  operations: z.array(accessPolicyRuleBatchOperationSchema).min(1).max(100),
});
const accessPolicyRuleBatchCountsSchema = z.strictObject({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
const accessPolicyRuleBatchBlockerSchema = z.strictObject({
  operation_index: z.number().int().nonnegative(),
  code: z.string().min(1),
  message: z.string().min(1),
  rule_id: z.string().uuid().nullable(),
});
const accessPolicyRuleBatchPreviewSchema = z.strictObject({
  base_revision: z.number().int().positive(),
  current_revision: z.number().int().positive(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  can_apply: z.boolean(),
  blockers: z.array(accessPolicyRuleBatchBlockerSchema),
  counts: accessPolicyRuleBatchCountsSchema,
  affected_principals: z.number().int().nonnegative().nullable(),
});
const accessPolicyRuleBatchApplySchema = z.strictObject({
  base_revision: z.number().int().positive(),
  current_revision: z.number().int().positive(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  counts: accessPolicyRuleBatchCountsSchema,
  affected_principals: z.number().int().nonnegative().nullable(),
});

function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.strictObject({ items: z.array(item), pagination: paginationSchema });
}

function queryPath(
  path: string,
  values: Record<string, string | number | boolean | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function listValues<SortBy extends string>(
  options: StandardListOptions<SortBy>,
): Record<string, string | number | boolean | undefined> {
  return {
    limit: options.limit,
    offset: options.offset,
    sort_by: options.sort_by,
    sort_order: options.sort_order,
    search: options.search,
    deleted: options.deleted,
  };
}

function userPath(userId: string): string {
  return `/users/${encodeURIComponent(userId)}`;
}

function rolePath(roleId: string): string {
  return `/roles/${encodeURIComponent(roleId)}`;
}

export function listAccessCapabilities(
  options: RequestOptions = {},
): Promise<{ items: AccessCapability[] }> {
  return apiFetch(
    "/access/capabilities",
    z.strictObject({ items: z.array(capabilitySchema) }),
    { cache: "no-store", signal: options.signal },
  );
}

export function checkWorkspaceAccess(
  request: AccessCheckRequest,
  options: RequestOptions = {},
): Promise<AccessCheckResponse> {
  const payload = accessCheckRequestSchema.parse(request);
  return apiFetch("/access/checks", accessCheckResponseSchema, {
    method: "POST",
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: options.signal,
  });
}

export function listAccessUsers(
  options: AccessUserListOptions = {},
): Promise<AccessPage<AccessUser>> {
  return apiFetch(
    queryPath("/users", { ...listValues(options), role_id: options.role_id }),
    pageSchema(userSchema),
    { cache: "no-store", signal: options.signal },
  );
}

export function listAccessDepartments(
  options: AccessDepartmentListOptions = {},
): Promise<AccessPage<AccessDepartment>> {
  return apiFetch(
    queryPath("/departments", listValues(options)),
    pageSchema(departmentSchema),
    { cache: "no-store", signal: options.signal },
  );
}

export function getAccessUser(
  userId: string,
  options: RequestOptions = {},
): Promise<AccessUser> {
  return apiFetch(userPath(userId), userSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

export function createAccessUser(
  request: AccessUserCreate & RequestOptions,
): Promise<AccessInvitationResponse> {
  const { signal, ...payload } = request;
  return apiFetch("/auth/invitations", invitationSchema, {
    method: "POST",
    body: JSON.stringify({ ...payload, delivery: "email" }),
    signal,
  });
}

export function updateAccessUser(
  userId: string,
  patch: AccessUserPatch & RequestOptions,
): Promise<AccessUser> {
  const { signal, ...payload } = patch;
  return apiFetch(userPath(userId), userSchema, {
    method: "PATCH",
    body: JSON.stringify(payload),
    signal,
  });
}

export function deleteAccessUser(
  userId: string,
  options: RequestOptions = {},
): Promise<null> {
  return apiFetch(userPath(userId), z.null(), {
    method: "DELETE",
    signal: options.signal,
  });
}

export function restoreAccessUser(
  userId: string,
  options: RequestOptions = {},
): Promise<AccessUser> {
  return apiFetch(`${userPath(userId)}/restore`, userSchema, {
    method: "POST",
    signal: options.signal,
  });
}

/**
 * Resend through the email delivery path. The Access controller deliberately
 * does not surface temporary passwords returned by invitation endpoints.
 */
export function resendAccessInvitation(
  userId: string,
  options: RequestOptions = {},
): Promise<AccessInvitationResponse> {
  return apiFetch(
    `/auth/invitations/${encodeURIComponent(userId)}/resend`,
    invitationSchema,
    {
      method: "POST",
      body: JSON.stringify({ delivery: "email" }),
      signal: options.signal,
    },
  );
}

export function revokeAccessInvitation(
  userId: string,
  options: RequestOptions = {},
): Promise<null> {
  return apiFetch(`/auth/invitations/${encodeURIComponent(userId)}`, z.null(), {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listAccessUserSessions(
  userId: string,
  options: AccessSessionListOptions = {},
): Promise<AccessPage<AccessSession>> {
  return apiFetch(
    queryPath(`${userPath(userId)}/sessions`, {
      limit: options.limit,
      offset: options.offset,
    }),
    pageSchema(sessionSchema),
    { cache: "no-store", signal: options.signal },
  );
}

export function revokeAccessUserSession(
  userId: string,
  sessionId: string,
  options: RequestOptions = {},
): Promise<null> {
  return apiFetch(
    `${userPath(userId)}/sessions/${encodeURIComponent(sessionId)}`,
    z.null(),
    { method: "DELETE", signal: options.signal },
  );
}

export function revokeAccessUserSessions(
  userId: string,
  options: RequestOptions = {},
): Promise<null> {
  return apiFetch(`${userPath(userId)}/sessions`, z.null(), {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listAccessRoles(
  options: AccessRoleListOptions = {},
): Promise<AccessPage<AccessRole>> {
  return apiFetch(
    queryPath("/roles", listValues(options)),
    pageSchema(roleSchema),
    {
      cache: "no-store",
      signal: options.signal,
    },
  );
}

export function getAccessRole(
  roleId: string,
  options: RequestOptions = {},
): Promise<AccessRole> {
  return apiFetch(rolePath(roleId), roleSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

export function createAccessRole(
  request: AccessRoleCreate & RequestOptions,
): Promise<AccessRole> {
  const { signal, ...payload } = request;
  return apiFetch("/roles", roleSchema, {
    method: "POST",
    body: JSON.stringify(payload),
    signal,
  });
}

export function updateAccessRole(
  roleId: string,
  patch: AccessRolePatch & RequestOptions,
): Promise<AccessRole> {
  const { signal, ...payload } = patch;
  return apiFetch(rolePath(roleId), roleSchema, {
    method: "PATCH",
    body: JSON.stringify(payload),
    signal,
  });
}

export function deleteAccessRole(
  roleId: string,
  options: RequestOptions = {},
): Promise<null> {
  return apiFetch(rolePath(roleId), z.null(), {
    method: "DELETE",
    signal: options.signal,
  });
}

export function restoreAccessRole(
  roleId: string,
  options: RequestOptions = {},
): Promise<AccessRole> {
  return apiFetch(`${rolePath(roleId)}/restore`, roleSchema, {
    method: "POST",
    signal: options.signal,
  });
}

export type AccessVersioned<Data> = { data: Data; etag: string };

export type AccessGroup = {
  id: string;
  name: string;
  description: string;
  revision: number;
  member_ids: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type AccessGroupCreate = {
  name: string;
  description?: string;
  member_ids?: string[];
};

export type AccessGroupPatch = {
  name?: string;
  description?: string;
  member_ids?: string[];
};

export type AccessDefaults = {
  id: string;
  default_role_id: string;
  group_ids: string[];
  department_ids: string[];
  invitation_expiry_days: number;
  guest_duration_days: number;
  service_duration_days: number;
  default_deny: boolean;
  require_guest_sponsor: boolean;
  require_service_owner: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type AccessDefaultsPatch = {
  default_role_id?: string;
  group_ids?: string[];
  department_ids?: string[];
  invitation_expiry_days?: number;
  guest_duration_days?: number;
  service_duration_days?: number;
  default_deny?: boolean;
  require_guest_sponsor?: boolean;
  require_service_owner?: boolean;
};

export type AccessServiceIdentityStatus = "active" | "disabled";
export type AccessServiceIdentityEffectiveStatus =
  "active" | "disabled" | "expired" | "deleted";

export type AccessRuleSubjectKind =
  "everyone" | "role" | "group" | "user" | "service";
export type AccessRuleScopeKind =
  "workspace" | "department" | "module" | "field";
export type AccessRuleDecision = "inherit" | "allow" | "deny";

export type AccessPolicyRule = {
  id: string;
  subject_kind: AccessRuleSubjectKind;
  subject_id: string | null;
  scope_kind: AccessRuleScopeKind;
  scope_id: string | null;
  permission_id: AccessCapabilityId;
  decision: AccessRuleDecision;
  starts_at: string | null;
  ends_at: string | null;
  locked: boolean;
  policy_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type AccessPolicyRuleCreate = Omit<
  AccessPolicyRule,
  | "id"
  | "policy_version"
  | "created_at"
  | "updated_at"
  | "deleted_at"
  | "is_deleted"
  | "performed_by"
>;
export type AccessPolicyRulePatch = Partial<AccessPolicyRuleCreate>;
export type AccessPolicyRuleListOptions = StandardListOptions<
  "created_at" | "updated_at" | "permission_id"
> & {
  subject_kind?: AccessRuleSubjectKind;
  subject_id?: string;
  scope_kind?: AccessRuleScopeKind;
  scope_id?: string;
  permission_id?: AccessCapabilityId;
  decision?: AccessRuleDecision;
  locked?: boolean;
};

export type AccessPolicyRuleBatchOperation =
  | { type: "create"; rule: AccessPolicyRuleCreate }
  | { type: "update"; rule_id: string; patch: AccessPolicyRulePatch }
  | { type: "delete"; rule_id: string };

export type AccessPolicyRuleBatchRequest = {
  base_revision: number;
  operations: AccessPolicyRuleBatchOperation[];
};
export type AccessPolicyRuleBatchPreview = {
  base_revision: number;
  digest: string;
  can_apply: boolean;
  current_revision: number;
  blockers: {
    operation_index: number;
    code: string;
    message: string;
    rule_id: string | null;
  }[];
  counts: {
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
  };
  affected_principals: number | null;
};
export type AccessPolicyRuleBatchApply = {
  base_revision: number;
  current_revision: number;
  digest: string;
  counts: {
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
  };
  affected_principals: number | null;
};

export type AccessServiceIdentity = {
  id: string;
  name: string;
  purpose: string;
  owner_id: string;
  role_id: string;
  expires_at: string;
  status: AccessServiceIdentityStatus;
  effective_status: AccessServiceIdentityEffectiveStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type AccessServiceIdentityCreate = {
  name: string;
  purpose: string;
  owner_id: string;
  role_id: string;
  expires_at: string;
  status?: AccessServiceIdentityStatus;
};

export type AccessServiceIdentityPatch = {
  name?: string;
  purpose?: string;
  owner_id?: string;
  role_id?: string;
  expires_at?: string;
  status?: AccessServiceIdentityStatus;
};

export type AccessGroupListOptions = StandardListOptions<
  "name" | "created_at" | "updated_at"
>;

export type AccessServiceIdentityListOptions = StandardListOptions<
  "name" | "expires_at" | "updated_at"
> & {
  status?: AccessServiceIdentityStatus;
  owner_id?: string;
  role_id?: string;
};

type ConditionalRequestOptions = RequestOptions & { etag: string };

function accessGroupPath(groupId: string): string {
  return `/access/groups/${encodeURIComponent(groupId)}`;
}

function accessServiceIdentityPath(serviceIdentityId: string): string {
  return `/access/service-identities/${encodeURIComponent(serviceIdentityId)}`;
}

function requiredEtag(etag: string | null): string {
  if (etag === null || !etag.trim()) throw new ApiContractError();
  return etag;
}

function ifMatchHeaders(etag: string): Headers {
  const headers = new Headers();
  headers.set("If-Match", requiredEtag(etag));
  return headers;
}

async function fetchAccessVersioned<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit,
): Promise<AccessVersioned<z.output<Schema>>> {
  const result = await apiFetchWithMetadata(path, schema, init);
  return { data: result.data, etag: requiredEtag(result.etag) };
}

export function listAccessGroups(
  options: AccessGroupListOptions = {},
): Promise<AccessPage<AccessGroup>> {
  return apiFetch(
    queryPath("/access/groups", listValues(options)),
    pageSchema(accessGroupSchema),
    {
      cache: "no-store",
      signal: options.signal,
    },
  );
}

export function getAccessGroup(
  groupId: string,
  options: RequestOptions = {},
): Promise<AccessVersioned<AccessGroup>> {
  return fetchAccessVersioned(accessGroupPath(groupId), accessGroupSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

export function createAccessGroup(
  request: AccessGroupCreate & RequestOptions,
): Promise<AccessVersioned<AccessGroup>> {
  const { signal, ...payload } = request;
  return fetchAccessVersioned("/access/groups", accessGroupSchema, {
    method: "POST",
    body: JSON.stringify(payload),
    signal,
  });
}

export async function updateAccessGroup(
  groupId: string,
  request: AccessGroupPatch & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessGroup>> {
  const { etag, signal, ...payload } = request;
  return fetchAccessVersioned(accessGroupPath(groupId), accessGroupSchema, {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: ifMatchHeaders(etag),
    signal,
  });
}

export async function deleteAccessGroup(
  groupId: string,
  options: ConditionalRequestOptions,
): Promise<null> {
  return apiFetch(accessGroupPath(groupId), z.null(), {
    method: "DELETE",
    headers: ifMatchHeaders(options.etag),
    signal: options.signal,
  });
}

export function getAccessDefaults(
  options: RequestOptions = {},
): Promise<AccessVersioned<AccessDefaults>> {
  return fetchAccessVersioned("/access/defaults", accessDefaultsSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

export async function updateAccessDefaults(
  request: AccessDefaultsPatch & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessDefaults>> {
  const { etag, signal, ...payload } = request;
  return fetchAccessVersioned("/access/defaults", accessDefaultsSchema, {
    method: "PATCH",
    body: JSON.stringify(payload),
    headers: ifMatchHeaders(etag),
    signal,
  });
}

export function listAccessServiceIdentities(
  options: AccessServiceIdentityListOptions = {},
): Promise<AccessPage<AccessServiceIdentity>> {
  return apiFetch(
    queryPath("/access/service-identities", {
      ...listValues(options),
      status: options.status,
      owner_id: options.owner_id,
      role_id: options.role_id,
    }),
    pageSchema(serviceIdentitySchema),
    { cache: "no-store", signal: options.signal },
  );
}

export function getAccessServiceIdentity(
  serviceIdentityId: string,
  options: RequestOptions = {},
): Promise<AccessVersioned<AccessServiceIdentity>> {
  return fetchAccessVersioned(
    accessServiceIdentityPath(serviceIdentityId),
    serviceIdentitySchema,
    { cache: "no-store", signal: options.signal },
  );
}

export function createAccessServiceIdentity(
  request: AccessServiceIdentityCreate & RequestOptions,
): Promise<AccessVersioned<AccessServiceIdentity>> {
  const { signal, ...payload } = request;
  return fetchAccessVersioned(
    "/access/service-identities",
    serviceIdentitySchema,
    {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
    },
  );
}

export async function updateAccessServiceIdentity(
  serviceIdentityId: string,
  request: AccessServiceIdentityPatch & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessServiceIdentity>> {
  const { etag, signal, ...payload } = request;
  return fetchAccessVersioned(
    accessServiceIdentityPath(serviceIdentityId),
    serviceIdentitySchema,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
      headers: ifMatchHeaders(etag),
      signal,
    },
  );
}

export async function deleteAccessServiceIdentity(
  serviceIdentityId: string,
  options: ConditionalRequestOptions,
): Promise<null> {
  return apiFetch(accessServiceIdentityPath(serviceIdentityId), z.null(), {
    method: "DELETE",
    headers: ifMatchHeaders(options.etag),
    signal: options.signal,
  });
}

export async function restoreAccessServiceIdentity(
  serviceIdentityId: string,
  options: ConditionalRequestOptions,
): Promise<AccessVersioned<AccessServiceIdentity>> {
  return fetchAccessVersioned(
    `${accessServiceIdentityPath(serviceIdentityId)}/restore`,
    serviceIdentitySchema,
    {
      method: "POST",
      headers: ifMatchHeaders(options.etag),
      signal: options.signal,
    },
  );
}

function accessRulePath(ruleId: string): string {
  return `/access/rules/${encodeURIComponent(ruleId)}`;
}

export function listAccessPolicyRules(
  options: AccessPolicyRuleListOptions = {},
): Promise<AccessVersioned<AccessPage<AccessPolicyRule>>> {
  return fetchAccessVersioned(
    queryPath("/access/rules", {
      ...listValues(options),
      subject_kind: options.subject_kind,
      subject_id: options.subject_id,
      scope_kind: options.scope_kind,
      scope_id: options.scope_id,
      permission_id: options.permission_id,
      decision: options.decision,
      locked: options.locked,
    }),
    pageSchema(accessPolicyRuleSchema),
    { cache: "no-store", signal: options.signal },
  );
}

export function getAccessPolicyRule(
  ruleId: string,
  options: RequestOptions = {},
): Promise<AccessVersioned<AccessPolicyRule>> {
  return fetchAccessVersioned(accessRulePath(ruleId), accessPolicyRuleSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

export function createAccessPolicyRule(
  request: AccessPolicyRuleCreate & RequestOptions,
): Promise<AccessVersioned<AccessPolicyRule>> {
  const { signal, ...payload } = request;
  const body = accessPolicyRuleCommandSchema.parse(payload);
  return fetchAccessVersioned("/access/rules", accessPolicyRuleSchema, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

export function updateAccessPolicyRule(
  ruleId: string,
  request: AccessPolicyRulePatch & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessPolicyRule>> {
  const { etag, signal, ...payload } = request;
  const body = accessPolicyRulePatchSchema.parse(payload);
  return fetchAccessVersioned(accessRulePath(ruleId), accessPolicyRuleSchema, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: ifMatchHeaders(etag),
    signal,
  });
}

export async function deleteAccessPolicyRule(
  ruleId: string,
  options: ConditionalRequestOptions,
): Promise<AccessVersioned<null>> {
  return fetchAccessVersioned(accessRulePath(ruleId), z.null(), {
    method: "DELETE",
    headers: ifMatchHeaders(options.etag),
    signal: options.signal,
  });
}

export function previewAccessPolicyRuleBatch(
  request: AccessPolicyRuleBatchRequest & RequestOptions,
): Promise<AccessVersioned<AccessPolicyRuleBatchPreview>> {
  const { signal, ...payload } = request;
  const body = accessPolicyRuleBatchRequestSchema.parse(payload);
  return fetchAccessVersioned(
    "/access/rules/impact-preview",
    accessPolicyRuleBatchPreviewSchema,
    { method: "POST", body: JSON.stringify(body), signal },
  );
}

export function applyAccessPolicyRuleBatch(
  request: AccessPolicyRuleBatchRequest & {
    digest: string;
  } & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessPolicyRuleBatchApply>> {
  const { etag, signal, ...payload } = request;
  const body = accessPolicyRuleBatchRequestSchema
    .extend({ digest: z.string().regex(/^[0-9a-f]{64}$/) })
    .parse(payload);
  return fetchAccessVersioned(
    "/access/rules/apply",
    accessPolicyRuleBatchApplySchema,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: ifMatchHeaders(etag),
      signal,
    },
  );
}
