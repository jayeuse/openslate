import { z } from "zod";

// Response and request contracts of the Access API. Each schema mirrors one
// backend Pydantic model; the source is named above it. Strict objects reject
// fields the backend does not send, so a contract change fails visibly.

const uuid = z.uuid();
const dateTime = z.iso.datetime({ offset: true });

/** `app/systems/access/users/models.py` UserRole and UserStatus. */
export const userRoleSchema = z.enum(["admin", "member", "guest"]);
export const userStatusSchema = z.enum(["pending", "active", "disabled"]);
/** `app/systems/access/policy/models.py` AccessLevel. */
export const accessLevelSchema = z.enum(["read", "write", "manage"]);

/** `app/common/listing/schemas.py` PaginationMetadata. */
const paginationSchema = z.strictObject({
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
});

/** `app/common/listing/schemas.py` StandardListResponse. */
export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.strictObject({ items: z.array(item), pagination: paginationSchema });
}

/** `users/schemas.py` UserResponse. */
export const userSchema = z.strictObject({
  id: uuid,
  email: z.string().min(1),
  username: z.string().min(1),
  status: userStatusSchema,
  role: userRoleSchema,
  display_name: z.string().nullable(),
  job_title: z.string().nullable(),
  sponsor_user_id: uuid.nullable(),
  expires_at: dateTime.nullable(),
  invitation_sent_at: dateTime.nullable(),
  created_at: dateTime,
  updated_at: dateTime,
  deleted_at: dateTime.nullable(),
  is_deleted: z.boolean(),
  performed_by: uuid.nullable(),
});

/** `users/schemas.py` InvitationResponse. */
export const invitationSchema = z.strictObject({
  user: userSchema,
  delivery: z.literal("email"),
});

/** `users/schemas.py` InvitationCreate (= UserCreate). */
export const invitationCreateSchema = z.strictObject({
  email: z.string().min(3).max(320),
  username: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/),
  role: userRoleSchema.optional(),
  group_ids: z.array(uuid).max(100).optional(),
  display_name: z.string().max(200).nullable().optional(),
  job_title: z.string().max(200).nullable().optional(),
  sponsor_user_id: uuid.nullable().optional(),
  expires_at: dateTime.nullable().optional(),
});

/**
 * `users/schemas.py` UserUpdate. A role change cannot make a guest; status
 * can only move between active and disabled.
 */
export const userPatchSchema = z.strictObject({
  username: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullable()
    .optional(),
  role: z.enum(["admin", "member"]).nullable().optional(),
  status: z.enum(["active", "disabled"]).nullable().optional(),
  display_name: z.string().max(200).nullable().optional(),
  job_title: z.string().max(200).nullable().optional(),
  sponsor_user_id: uuid.nullable().optional(),
  expires_at: dateTime.nullable().optional(),
});

/** `users/sessions_schemas.py` AdminSessionResponse. */
export const sessionSchema = z.strictObject({
  id: uuid,
  created_at: dateTime,
  refreshed_at: dateTime,
  expires_at: dateTime,
  user_agent: z.string().nullable(),
  current: z.boolean(),
});

/**
 * `GET /api/users/{user_id}/access` (administrators only): a person's
 * effective access. A null module means the whole department. `groups` are
 * the groups whose row gives the entry; an entry's level already applies the
 * guest read limit, while each group keeps the level it grants. An active
 * administrator is `unrestricted` and has no entries.
 */
export const userAccessSchema = z.strictObject({
  user_id: uuid,
  role: userRoleSchema,
  unrestricted: z.boolean(),
  entries: z.array(
    z.strictObject({
      department_id: uuid,
      module_id: uuid.nullable(),
      level: accessLevelSchema,
      groups: z.array(
        z.strictObject({
          group_id: uuid,
          name: z.string().min(1),
          level: accessLevelSchema,
        }),
      ),
    }),
  ),
});

/** `policy/schemas.py` GroupAccessEntry: a null module means the whole department. */
export const groupAccessEntrySchema = z.strictObject({
  department_id: uuid,
  module_id: uuid.nullable(),
  level: accessLevelSchema,
});

/** `policy/schemas.py` GroupResponse. */
export const groupSchema = z.strictObject({
  id: uuid,
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  revision: z.number().int().nonnegative(),
  member_ids: z.array(uuid),
  access: z.array(groupAccessEntrySchema),
  created_at: dateTime,
  updated_at: dateTime,
  deleted_at: dateTime.nullable(),
  is_deleted: z.boolean(),
  performed_by: uuid.nullable(),
});

/** `policy/schemas.py` GroupCreate. */
export const groupCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  member_ids: z.array(uuid).max(100).optional(),
});

/** `policy/schemas.py` GroupUpdate: name and description only (D14). */
export const groupPatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
});

/** `policy/schemas.py` GroupAccessReplace. */
export const groupAccessReplaceSchema = z.strictObject({
  access: z.array(groupAccessEntrySchema).max(500),
});

/** `policy/schemas.py` GroupMembersReplace (D14). */
export const groupMembersReplaceSchema = z.strictObject({
  member_ids: z.array(uuid).max(100),
});

/**
 * `policy/schemas.py` MemberCandidateResponse (D14). The route never lists
 * administrators, so an administrator here is a contract change.
 */
export const memberCandidateSchema = z.strictObject({
  id: uuid,
  display_name: z.string().nullable(),
  username: z.string().min(1),
  email: z.string().min(1),
  role: z.enum(["member", "guest"]),
  status: userStatusSchema,
});

/** `sandbox/departments/schemas.py` DepartmentResponse. */
export const departmentSchema = z.strictObject({
  id: uuid,
  department_name: z.string().min(1),
  created_at: dateTime,
  updated_at: dateTime,
  deleted_at: dateTime.nullable(),
  is_deleted: z.boolean(),
  performed_by: uuid.nullable(),
});

/** `sandbox/modules/schemas.py` ModuleResponse. */
export const moduleSchema = z.strictObject({
  id: uuid,
  department_id: uuid,
  module_name: z.string().min(1),
  created_at: dateTime,
  updated_at: dateTime,
  deleted_at: dateTime.nullable(),
  is_deleted: z.boolean(),
  performed_by: uuid.nullable(),
});

/**
 * The invitation settings of `manage/workspace/schemas.py` WorkspaceResponse.
 * Access reads only these fields of the workspace resource, so the object is
 * not strict: Manage owns the rest of it.
 */
export const invitationSettingsSchema = z.object({
  invitation_expiry_days: z.number().int().min(1).max(365),
  guest_duration_days: z.number().int().min(1).max(365),
  revision: z.number().int().positive(),
});

/**
 * `manage/workspace/schemas.py` WorkspaceUpdate limited to the invitation
 * settings. The revision travels in the body, not in If-Match.
 */
export const invitationSettingsPatchSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    invitation_expiry_days: z.number().int().min(1).max(365).optional(),
    guest_duration_days: z.number().int().min(1).max(365).optional(),
  })
  .refine(
    (patch) =>
      patch.invitation_expiry_days !== undefined ||
      patch.guest_duration_days !== undefined,
    { message: "At least one invitation setting is required" },
  );

export type AccessUserRole = z.output<typeof userRoleSchema>;
export type AccessUserStatus = z.output<typeof userStatusSchema>;
export type AccessLevel = z.output<typeof accessLevelSchema>;
export type AccessDeletedFilter = "exclude" | "include" | "only";
export type AccessSortOrder = "asc" | "desc";
export type AccessPage<Item> = {
  items: Item[];
  pagination: z.output<typeof paginationSchema>;
};
export type AccessVersioned<Data> = { data: Data; etag: string };

export type AccessUser = z.output<typeof userSchema>;
export type AccessInvitationResponse = z.output<typeof invitationSchema>;
export type AccessInvitationCreate = z.input<typeof invitationCreateSchema>;
export type AccessUserPatch = z.input<typeof userPatchSchema>;
export type AccessSession = z.output<typeof sessionSchema>;
export type AccessUserAccess = z.output<typeof userAccessSchema>;
export type AccessGroupAccessEntry = z.output<typeof groupAccessEntrySchema>;
export type AccessGroup = z.output<typeof groupSchema>;
export type AccessGroupCreate = z.input<typeof groupCreateSchema>;
export type AccessGroupPatch = z.input<typeof groupPatchSchema>;
export type AccessMemberCandidate = z.output<typeof memberCandidateSchema>;
export type AccessDepartment = z.output<typeof departmentSchema>;
export type AccessModule = z.output<typeof moduleSchema>;
export type AccessInvitationSettings = z.output<
  typeof invitationSettingsSchema
>;
export type AccessInvitationSettingsPatch = z.input<
  typeof invitationSettingsPatchSchema
>;

export type RequestOptions = { signal?: AbortSignal };

export type StandardListOptions<SortBy extends string> = RequestOptions & {
  limit?: number;
  offset?: number;
  sort_by?: SortBy;
  sort_order?: AccessSortOrder;
  search?: string;
  deleted?: AccessDeletedFilter;
};

export type AccessUserListOptions = StandardListOptions<
  "email" | "username" | "created_at" | "updated_at"
> & { role?: AccessUserRole };
export type AccessGroupListOptions = StandardListOptions<
  "name" | "created_at" | "updated_at"
>;
export type AccessDepartmentListOptions = StandardListOptions<
  "department_name" | "created_at" | "updated_at"
>;
export type AccessModuleListOptions = StandardListOptions<
  "module_name" | "created_at" | "updated_at"
> & { department_id?: string };
/** Deleted accounts are never candidates, so there is no deleted filter. */
export type AccessMemberCandidateListOptions = Omit<
  StandardListOptions<"username" | "email" | "display_name">,
  "deleted"
>;
export type AccessSessionListOptions = RequestOptions & {
  limit?: number;
  offset?: number;
};
