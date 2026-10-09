import { z } from "zod";
import {
  apiFetch,
  apiFetchWithMetadata,
  ApiContractError,
  type ApiRequestInit,
} from "@/lib/api";
import {
  departmentSchema,
  directoryUserSchema,
  groupAccessReplaceSchema,
  groupCreateSchema,
  groupMembersReplaceSchema,
  groupPatchSchema,
  groupSchema,
  invitationCreateSchema,
  invitationSchema,
  invitationSettingsPatchSchema,
  invitationSettingsSchema,
  memberCandidateSchema,
  moduleSchema,
  pageSchema,
  sessionSchema,
  userAccessSchema,
  userPatchSchema,
  userSchema,
  userSummarySchema,
  type AccessDepartment,
  type AccessDirectoryUser,
  type AccessDepartmentListOptions,
  type AccessGroup,
  type AccessGroupAccessEntry,
  type AccessGroupCreate,
  type AccessGroupListOptions,
  type AccessGroupPatch,
  type AccessInvitationCreate,
  type AccessInvitationResponse,
  type AccessInvitationSettings,
  type AccessInvitationSettingsPatch,
  type AccessMemberCandidate,
  type AccessMemberCandidateListOptions,
  type AccessModule,
  type AccessModuleListOptions,
  type AccessPage,
  type AccessSession,
  type AccessSessionListOptions,
  type AccessUser,
  type AccessUserAccess,
  type AccessUserListOptions,
  type AccessUserPatch,
  type AccessUserSummary,
  type AccessUserSummaryOptions,
  type AccessVersioned,
  type RequestOptions,
  type StandardListOptions,
} from "./api-contracts";

export type * from "./api-contracts";

type ConditionalRequestOptions = RequestOptions & { etag: string };

function lookupIds(ids: readonly string[] | undefined): string[] | undefined {
  return ids === undefined
    ? undefined
    : z.array(z.uuid()).min(1).max(100).parse(ids);
}

function queryPath(
  path: string,
  values: Record<
    string,
    string | number | boolean | readonly string[] | undefined
  >,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined) query.set(key, String(value));
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

function userPath(userId: string): string {
  return `/users/${encodeURIComponent(userId)}`;
}

function groupPath(groupId: string): string {
  return `/access/groups/${encodeURIComponent(groupId)}`;
}

// Users and invitations

export async function listAccessUsers(
  options: AccessUserListOptions = {},
): Promise<AccessPage<AccessDirectoryUser>> {
  return apiFetch(
    queryPath("/users", {
      ...listValues(options),
      role: options.role,
      status: options.status,
      group_id: options.group_id,
      department_id: options.department_id,
      mfa: options.mfa,
      history: options.history,
      inactive_days: options.inactive_days,
      ids: lookupIds(options.ids),
    }),
    pageSchema(directoryUserSchema),
    { cache: "no-store", signal: options.signal },
  );
}

export function getAccessUserSummary(
  options: AccessUserSummaryOptions = {},
): Promise<AccessUserSummary> {
  return apiFetch(
    queryPath("/users/summary", { inactive_days: options.inactive_days }),
    userSummarySchema,
    {
      cache: "no-store",
      signal: options.signal,
    },
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

/** Invite a person by email with a role and their first groups. */
export async function inviteAccessUser(
  request: AccessInvitationCreate & RequestOptions,
): Promise<AccessInvitationResponse> {
  const { signal, ...payload } = request;
  return apiFetch("/auth/invitations", invitationSchema, {
    method: "POST",
    body: JSON.stringify(invitationCreateSchema.parse(payload)),
    signal,
  });
}

export async function updateAccessUser(
  userId: string,
  patch: AccessUserPatch & RequestOptions,
): Promise<AccessUser> {
  const { signal, ...payload } = patch;
  return apiFetch(userPath(userId), userSchema, {
    method: "PATCH",
    body: JSON.stringify(userPatchSchema.parse(payload)),
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

/** Complete a pending invitation that has not yet been sent. */
export async function reconcileAccessInvitation(
  userId: string,
  options: RequestOptions = {},
): Promise<AccessUser> {
  const user = await apiFetch(
    `/auth/invitations/${encodeURIComponent(userId)}/reconcile`,
    userSchema,
    { method: "POST", body: JSON.stringify({}), signal: options.signal },
  );
  if (user.id !== userId) throw new ApiContractError();
  return user;
}

/** Request another Supabase invitation email. */
export function resendAccessInvitation(
  userId: string,
  options: RequestOptions = {},
): Promise<AccessInvitationResponse> {
  return apiFetch(
    `/auth/invitations/${encodeURIComponent(userId)}/resend`,
    invitationSchema,
    { method: "POST", body: JSON.stringify({}), signal: options.signal },
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

/** A person's effective access per department and module. Administrators only. */
export function getAccessUserAccess(
  userId: string,
  options: RequestOptions = {},
): Promise<AccessUserAccess> {
  return apiFetch(`${userPath(userId)}/access`, userAccessSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

// Sessions of one user

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

// Groups

export function listAccessGroups(
  options: AccessGroupListOptions & { member_id?: string } = {},
): Promise<AccessPage<AccessGroup>> {
  return apiFetch(
    queryPath("/access/groups", {
      ...listValues(options),
      without_access: options.without_access,
      without_members: options.without_members,
      member_id:
        options.member_id === undefined
          ? undefined
          : z.uuid().parse(options.member_id),
    }),
    pageSchema(groupSchema),
    { cache: "no-store", signal: options.signal },
  );
}

export function getAccessGroup(
  groupId: string,
  options: RequestOptions = {},
): Promise<AccessVersioned<AccessGroup>> {
  return fetchAccessVersioned(groupPath(groupId), groupSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

export async function createAccessGroup(
  request: AccessGroupCreate & RequestOptions,
): Promise<AccessVersioned<AccessGroup>> {
  const { signal, ...payload } = request;
  return fetchAccessVersioned("/access/groups", groupSchema, {
    method: "POST",
    body: JSON.stringify(groupCreateSchema.parse(payload)),
    signal,
  });
}

/** Rename or describe a group. Administrators only. */
export async function updateAccessGroup(
  groupId: string,
  request: AccessGroupPatch & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessGroup>> {
  const { etag, signal, ...payload } = request;
  return fetchAccessVersioned(groupPath(groupId), groupSchema, {
    method: "PATCH",
    body: JSON.stringify(groupPatchSchema.parse(payload)),
    headers: ifMatchHeaders(etag),
    signal,
  });
}

/** Replace every department and module level of a group. Administrators only. */
export async function replaceAccessGroupAccess(
  groupId: string,
  request: { access: AccessGroupAccessEntry[] } & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessGroup>> {
  const { etag, signal, ...payload } = request;
  return fetchAccessVersioned(`${groupPath(groupId)}/access`, groupSchema, {
    method: "PUT",
    body: JSON.stringify(groupAccessReplaceSchema.parse(payload)),
    headers: ifMatchHeaders(etag),
    signal,
  });
}

/** Replace the members of a group. Administrators and its managers (D14). */
export async function replaceAccessGroupMembers(
  groupId: string,
  request: { member_ids: string[] } & ConditionalRequestOptions,
): Promise<AccessVersioned<AccessGroup>> {
  const { etag, signal, ...payload } = request;
  return fetchAccessVersioned(`${groupPath(groupId)}/members`, groupSchema, {
    method: "PUT",
    body: JSON.stringify(groupMembersReplaceSchema.parse(payload)),
    headers: ifMatchHeaders(etag),
    signal,
  });
}

export async function deleteAccessGroup(
  groupId: string,
  options: ConditionalRequestOptions,
): Promise<null> {
  return apiFetch(groupPath(groupId), z.null(), {
    method: "DELETE",
    headers: ifMatchHeaders(options.etag),
    signal: options.signal,
  });
}

/** People a manager may add to a group: never administrators. */
export async function listAccessMemberCandidates(
  options: AccessMemberCandidateListOptions = {},
): Promise<AccessPage<AccessMemberCandidate>> {
  return apiFetch(
    queryPath("/access/member-candidates", {
      ...listValues(options),
      ids: lookupIds(options.ids),
    }),
    pageSchema(memberCandidateSchema),
    { cache: "no-store", signal: options.signal },
  );
}

// Departments and modules for the access pickers

export function getAccessDepartment(
  departmentId: string,
  options: RequestOptions = {},
): Promise<AccessDepartment> {
  return apiFetch(
    `/departments/${encodeURIComponent(departmentId)}`,
    departmentSchema.refine((item) => item.id === departmentId),
    { signal: options.signal },
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

export function getAccessModule(
  moduleId: string,
  options: RequestOptions = {},
): Promise<AccessModule> {
  return apiFetch(
    `/modules/${encodeURIComponent(moduleId)}`,
    moduleSchema.refine((item) => item.id === moduleId),
    { signal: options.signal },
  );
}

export function listAccessModules(
  options: AccessModuleListOptions = {},
): Promise<AccessPage<AccessModule>> {
  return apiFetch(
    queryPath("/modules", {
      ...listValues(options),
      department_id: options.department_id,
    }),
    pageSchema(moduleSchema),
    { cache: "no-store", signal: options.signal },
  );
}

// Invitation settings (part of the workspace resource)

export function getAccessInvitationSettings(
  options: RequestOptions = {},
): Promise<AccessInvitationSettings> {
  return apiFetch("/workspace", invitationSettingsSchema, {
    cache: "no-store",
    signal: options.signal,
  });
}

/** A stale revision fails with 409 from the workspace route. */
export async function updateAccessInvitationSettings(
  request: AccessInvitationSettingsPatch & RequestOptions,
): Promise<AccessInvitationSettings> {
  const { signal, ...payload } = request;
  return apiFetch("/workspace", invitationSettingsSchema, {
    method: "PATCH",
    body: JSON.stringify(invitationSettingsPatchSchema.parse(payload)),
    signal,
  });
}
