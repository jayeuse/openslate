import { z } from "zod";
import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";
import { defaultOrganizationBlockedSchema } from "@/lib/auth-api";
import {
  fileWireSchema,
  reserveFile,
  uploadFileContent,
  throwFileRequestError,
} from "@/components/systems/shared/adapters/files-api";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const nullableText = z.string().nullable();
const membershipSchema = z
  .object({
    org_id: uuid,
    name: z.string(),
    slug: z.string(),
    role: z.enum(["admin", "member", "guest"]),
  })
  .strict();
const selfSchema = z
  .object({
    id: uuid,
    email: z.string(),
    username: z.string(),
    status: z.enum(["pending", "active", "disabled"]),
    role: z.enum(["admin", "member", "guest"]).nullable(),
    display_name: nullableText,
    job_title: nullableText,
    phone: nullableText,
    bio: nullableText,
    avatar_file_id: uuid.nullable(),
    sponsor_user_id: uuid.nullable(),
    expires_at: timestamp.nullable(),
    invitation_sent_at: timestamp.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp.nullable(),
    is_deleted: z.boolean(),
    performed_by: uuid.nullable(),
    access: z.array(
      z
        .object({
          department_id: uuid,
          module_id: uuid.nullable(),
          level: z.enum(["read", "write", "manage"]),
        })
        .strict(),
    ),
  })
  .strict();
const accountSchema = selfSchema.omit({
  role: true,
  sponsor_user_id: true,
  expires_at: true,
  invitation_sent_at: true,
  access: true,
});
const profileSchema = selfSchema.extend({
  default_organization_blocked: defaultOrganizationBlockedSchema,
  account: accountSchema,
  memberships: z.array(membershipSchema),
  pending_invitations: z.array(
    membershipSchema.extend({ id: uuid, expires_at: timestamp }),
  ),
  current_organization: membershipSchema
    .extend({ access: selfSchema.shape.access })
    .nullable(),
});
export type ProfileSelf = z.output<typeof profileSchema>;
export type PersonCardViewer = {
  id: string;
  role: "admin" | "member" | "guest";
};
const publicCardSchema = z
  .object({
    display_name: z.string().refine((value) => Boolean(value.trim())),
    job_title: nullableText,
    avatar_url: nullableText,
  })
  .strict();
const memberCardSchema = publicCardSchema
  .extend({
    email: nullableText,
    phone: nullableText,
    bio: nullableText,
  })
  .strict();
export type PersonCard = {
  viewer: PersonCardViewer;
  targetId: string;
  data: z.output<typeof publicCardSchema> | z.output<typeof memberCardSchema>;
};

/** The card response carries no id: bind it to its requested target and viewer. */
export async function getPersonCard(
  viewer: PersonCardViewer,
  targetId: string,
  signal?: AbortSignal,
): Promise<PersonCard> {
  uuid.parse(viewer.id);
  const id = uuid.parse(targetId);
  const schema = viewer.role === "guest" ? publicCardSchema : memberCardSchema;
  const data = await apiFetch(`/users/${id}/card`, schema, {
    signal,
    cache: "no-store",
    refreshOnUnauthorized: false,
  });
  if (data.avatar_url !== null && data.avatar_url !== `/api/users/${id}/avatar`)
    throw new ApiContractError();
  signal?.throwIfAborted();
  return { viewer: { ...viewer }, targetId: id, data };
}
export type IdentityField = "display_name" | "job_title" | "phone" | "bio";
export const identityLimits = {
  display_name: 200,
  job_title: 200,
  phone: 32,
  bio: 280,
} as const;
const codepoints = (limit: number) =>
  nullableText.refine(
    (value) => value === null || Array.from(value).length <= limit,
  );
const patchSchema = z
  .object({
    display_name: codepoints(200).optional(),
    job_title: codepoints(200).optional(),
    phone: codepoints(32).optional(),
    bio: codepoints(280).optional(),
    avatar_file_id: uuid.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
export type ProfilePatch = z.output<typeof patchSchema>;

function requireOwner(self: ProfileSelf, userId: string): ProfileSelf {
  if (self.id !== userId)
    throw new ApiError(
      403,
      "Profile belongs to another account",
      undefined,
      "profile_owner_mismatch",
    );
  return self;
}
export async function readProfileSelf(userId: string, signal?: AbortSignal) {
  return requireOwner(
    await apiFetch("/auth/me", profileSchema, {
      signal,
      cache: "no-store",
      refreshOnUnauthorized: false,
    }),
    userId,
  );
}
export async function saveProfile(
  userId: string,
  patch: ProfilePatch,
  signal?: AbortSignal,
) {
  return requireOwner(
    await apiFetch("/auth/me/profile", profileSchema, {
      method: "PATCH",
      body: JSON.stringify(patchSchema.parse(patch)),
      signal,
      refreshOnUnauthorized: false,
    }),
    userId,
  );
}
export function profileNeedsSessionRecheck(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.code === "profile_owner_mismatch")
  );
}
export function profileCleanupPartial(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    error.code === "profile_avatar_cleanup_partial"
  );
}

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const imageTypes = ["image/png", "image/jpeg"] as const;
export function validAvatarSelection(file: File) {
  return (
    file.size > 0 &&
    file.size <= MAX_AVATAR_BYTES &&
    imageTypes.some((type) => type === file.type)
  );
}
function avatarSchema(userId: string, state: "awaiting_upload" | "ready") {
  return fileWireSchema
    .extend({
      purpose: z.literal("user_avatar"),
      creator_id: z.literal(userId),
      record_id: z.null(),
      department_id: z.null(),
      board_id: z.null(),
      state: z.literal(state),
      is_deleted: z.literal(false),
      failure_code: z.null(),
      expected_size: z.number().int().min(1).max(MAX_AVATAR_BYTES),
      actual_size: z.number().int().min(1).max(MAX_AVATAR_BYTES).nullable(),
    })
    .superRefine((file, context) => {
      if (
        state === "ready" &&
        (file.actual_size === null ||
          !imageTypes.some((type) => type === file.media_type))
      )
        context.addIssue({
          code: "custom",
          message: "Ready avatar metadata is invalid",
        });
    });
}
export async function reserveAvatar(
  userId: string,
  file: File,
  signal?: AbortSignal,
) {
  if (!validAvatarSelection(file)) throw new ApiContractError();
  return reserveFile({ filename: file.name, expectedSize: file.size }, (body) =>
    apiFetch("/files", avatarSchema(userId, "awaiting_upload"), {
      method: "POST",
      body: JSON.stringify({ ...body, purpose: "user_avatar" }),
      signal,
      refreshOnUnauthorized: false,
    }),
  );
}
export async function uploadAvatar(
  userId: string,
  fileId: string,
  file: File,
  signal?: AbortSignal,
) {
  const id = uuid.parse(fileId);
  if (!validAvatarSelection(file)) throw new ApiContractError();
  return uploadFileContent(
    id,
    file,
    avatarSchema(userId, "ready"),
    async () => {
      const response = await apiRequest(`/files/${id}/content`, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "application/octet-stream" },
        signal,
        refreshOnUnauthorized: false,
      });
      if (!response.ok)
        return throwFileRequestError(
          response,
          "Photo upload outcome unavailable",
        );
      return response;
    },
    signal,
  );
}

/** Private, bounded inline image bytes. No provider URL or persisted Blob cache. */
export async function readOwnAvatar(
  userId: string,
  expectedId: string,
  signal?: AbortSignal,
) {
  uuid.parse(expectedId);
  const blob = await readAvatarBytes(userId, signal);
  const self = await readProfileSelf(userId, signal);
  if (self.avatar_file_id !== expectedId) throw new ApiContractError();
  signal?.throwIfAborted();
  return blob;
}

/** Other-person bytes have a separate current-card guard, never the private self guard. */
export async function readPersonAvatar(
  card: { viewer: PersonCardViewer; targetId: string; avatarUrl: string },
  signal?: AbortSignal,
) {
  if (card.avatarUrl !== `/api/users/${uuid.parse(card.targetId)}/avatar`)
    throw new ApiContractError();
  const blob = await readAvatarBytes(card.targetId, signal);
  let current: PersonCard;
  try {
    current = await getPersonCard(card.viewer, card.targetId, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return {
      status: "card-unavailable" as const,
      error: error instanceof Error ? error : new ApiContractError(),
    };
  }
  signal?.throwIfAborted();
  return {
    status: "ready" as const,
    card: current,
    blob: current.data.avatar_url === card.avatarUrl ? blob : null,
  };
}

async function readAvatarBytes(userId: string, signal?: AbortSignal) {
  const response = await apiRequest(`/users/${uuid.parse(userId)}/avatar`, {
    signal,
    redirect: "error",
    cache: "no-store",
    refreshOnUnauthorized: false,
  });
  if (!response.ok) return throwFileRequestError(response, "Photo unavailable");
  const type = response.headers
    .get("Content-Type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const cache = response.headers
    .get("Cache-Control")
    ?.toLowerCase()
    .split(/\s*,\s*/);
  if (
    response.status !== 200 ||
    !imageTypes.some((value) => value === type) ||
    response.headers.get("X-Content-Type-Options")?.toLowerCase() !==
      "nosniff" ||
    !cache?.includes("private") ||
    !cache.includes("no-store") ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiContractError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_AVATAR_BYTES) throw new ApiContractError();
      chunks.push(new Uint8Array(next.value));
    }
    if (!size) throw new ApiContractError();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  return new Blob(chunks, { type });
}
