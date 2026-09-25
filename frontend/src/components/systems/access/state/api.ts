import { z } from "zod";
import {
  accessCheckRequestSchema,
  accessCheckResponseSchema,
  capabilitySchema,
  userSchema,
  departmentSchema,
  invitationSchema,
  sessionSchema,
  roleSchema,
  accessGroupSchema,
  accessDefaultsSchema,
  serviceIdentitySchema,
  accessPolicyRuleCommandSchema,
  accessPolicyRuleSchema,
  accessPolicyRulePatchSchema,
  accessPolicyRuleBatchRequestSchema,
  accessPolicyRuleBatchPreviewSchema,
  accessPolicyRuleBatchApplySchema,
  pageSchema,
} from "./api-contracts";
import type {
  AccessCapability,
  AccessCheckRequest,
  AccessCheckResponse,
  AccessUserListOptions,
  AccessPage,
  AccessUser,
  AccessDepartmentListOptions,
  AccessDepartment,
  AccessUserCreate,
  AccessInvitationResponse,
  AccessUserPatch,
  AccessSessionListOptions,
  AccessSession,
  AccessRoleListOptions,
  AccessRole,
  AccessRoleCreate,
  AccessRolePatch,
  AccessVersioned,
  AccessGroupListOptions,
  AccessGroup,
  AccessGroupCreate,
  AccessGroupPatch,
  AccessDefaults,
  AccessDefaultsPatch,
  AccessServiceIdentityListOptions,
  AccessServiceIdentity,
  AccessServiceIdentityCreate,
  AccessServiceIdentityPatch,
  AccessPolicyRuleListOptions,
  AccessPolicyRule,
  AccessPolicyRuleCreate,
  AccessPolicyRulePatch,
  AccessPolicyRuleBatchRequest,
  AccessPolicyRuleBatchPreview,
  AccessPolicyRuleBatchApply,
  RequestOptions,
  StandardListOptions,
} from "./api-contracts";
import {
  apiFetch,
  apiFetchWithMetadata,
  ApiContractError,
  type ApiRequestInit,
} from "@/lib/api";

export { ACCESS_CAPABILITY_IDS } from "./api-contracts";
export type {
  AccessCapabilityId,
  AccessUserStatus,
  AccessIdentityKind,
  AccessDeletedFilter,
  AccessSortOrder,
  AccessCapability,
  AccessPagination,
  AccessPage,
  AccessUser,
  AccessDepartment,
  AccessInvitationResponse,
  AccessUserCreate,
  AccessUserPatch,
  AccessRolePermissions,
  AccessRole,
  AccessRoleCreate,
  AccessRolePatch,
  AccessSession,
  AccessCheckRequest,
  AccessCheckReason,
  AccessCheckResponse,
  AccessUserListOptions,
  AccessRoleListOptions,
  AccessDepartmentListOptions,
  AccessSessionListOptions,
  AccessVersioned,
  AccessGroup,
  AccessGroupCreate,
  AccessGroupPatch,
  AccessDefaults,
  AccessDefaultsPatch,
  AccessServiceIdentityStatus,
  AccessServiceIdentityEffectiveStatus,
  AccessRuleSubjectKind,
  AccessRuleScopeKind,
  AccessRuleDecision,
  AccessPolicyRule,
  AccessPolicyRuleCreate,
  AccessPolicyRulePatch,
  AccessPolicyRuleListOptions,
  AccessPolicyRuleBatchOperation,
  AccessPolicyRuleBatchRequest,
  AccessPolicyRuleBatchPreview,
  AccessPolicyRuleBatchApply,
  AccessServiceIdentity,
  AccessServiceIdentityCreate,
  AccessServiceIdentityPatch,
  AccessGroupListOptions,
  AccessServiceIdentityListOptions,
} from "./api-contracts";

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
