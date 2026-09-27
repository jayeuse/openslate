import { z } from "zod";
import {
  ApiContractError,
  ApiError,
  apiFetch,
  type ApiRequestInit,
} from "@/lib/api";

const uuidSchema = z.string().uuid();
const revisionSchema = z.number().int().min(1);
const timestampSchema = z.iso.datetime({ offset: true });
const principalTypeSchema = z.enum(["user", "everyone"]);
const permissionSchema = z.enum(["view", "edit", "manage"]);
const effectSchema = z.enum(["allow", "deny"]);

const grantSchema = z
  .object({
    id: uuidSchema,
    principal_type: principalTypeSchema,
    principal_user_id: uuidSchema.nullable(),
    principal_label: z.string().trim().min(1).max(100),
    principal_available: z.boolean(),
    permission: permissionSchema,
    effect: effectSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .strict()
  .refine((grant) => {
    if (grant.principal_type === "user")
      return (
        grant.principal_user_id !== null &&
        (grant.principal_available ||
          grant.principal_label === "Unavailable user")
      );
    return (
      grant.principal_user_id === null &&
      grant.principal_available &&
      grant.principal_label === "Everyone"
    );
  })
  .transform(
    ({
      principal_type,
      principal_user_id,
      principal_label,
      principal_available,
      created_at,
      updated_at,
      ...grant
    }) => ({
      ...grant,
      principalType: principal_type,
      principalUserId: principal_user_id,
      principalLabel: principal_label,
      principalAvailable: principal_available,
      createdAt: created_at,
      updatedAt: updated_at,
    }),
  );
const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0),
    count: z.number().int().min(0),
    total: z.number().int().min(0),
    has_more: z.boolean(),
  })
  .strict()
  .refine(({ count, limit }) => count <= limit)
  .transform(({ has_more, ...page }) => ({ ...page, hasMore: has_more }));
const listSchema = z
  .object({
    items: z.array(grantSchema),
    pagination: paginationSchema,
    board_revision: revisionSchema,
  })
  .strict()
  .refine(
    ({ items, pagination }) =>
      items.length === pagination.count &&
      new Set(items.map((grant) => grant.id)).size === items.length,
  )
  .transform(({ board_revision, ...list }) => ({
    ...list,
    boardRevision: board_revision,
  }));
const mutationSchema = z
  .object({ grant: grantSchema, board_revision: revisionSchema })
  .strict()
  .transform(({ board_revision, ...result }) => ({
    ...result,
    boardRevision: board_revision,
  }));

const listOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    sortBy: z
      .enum(["principal_type", "permission", "effect", "created_at"])
      .default("principal_type"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
const commonCreateFields = {
  revision: revisionSchema,
  permission: permissionSchema,
  effect: effectSchema,
};
const createSchema = z.discriminatedUnion("principalType", [
  z
    .object({
      ...commonCreateFields,
      principalType: z.literal("user"),
      principalUserId: uuidSchema,
    })
    .strict(),
  z
    .object({
      ...commonCreateFields,
      principalType: z.literal("everyone"),
    })
    .strict(),
]);

export type BoardGrant = z.output<typeof grantSchema>;
export type BoardGrantList = z.output<typeof listSchema>;
export type BoardGrantMutation = z.output<typeof mutationSchema>;
export type BoardGrantListOptions = z.input<typeof listOptionsSchema>;
export type BoardGrantCreate = z.input<typeof createSchema>;

const safeConflicts = new Map([
  ["stale_revision", "Board changed; reload before saving"],
  ["board_archived", "Restore the Board before changing grants"],
  ["grant_exists", "This Board grant already exists"],
  ["grantee_unavailable", "The selected grantee is unavailable"],
  ["grant_invalid", "Unable to save Board grant"],
]);
const conflictSchema = z
  .object({
    code: z.string(),
    current_revision: revisionSchema.optional(),
  })
  .passthrough();

function throwSafeGrantError(error: ApiError): never {
  if (
    error.status === 404 &&
    (error.details === "Board not found" ||
      error.details === "Board grant not found")
  ) {
    throw new ApiError(error.status, error.details);
  }
  if (error.status === 409) {
    const detail = conflictSchema.safeParse(error.details);
    const message = detail.success && safeConflicts.get(detail.data.code);
    if (detail.success && message) {
      const safeDetail = {
        code: detail.data.code,
        message,
        ...(detail.data.code === "stale_revision" &&
        detail.data.current_revision !== undefined
          ? { current_revision: detail.data.current_revision }
          : {}),
      };
      throw new ApiError(error.status, message, safeDetail, detail.data.code);
    }
  }
  throw new ApiError(error.status, "Request could not be completed");
}

async function safeGrantJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { ...init, cache: "no-store" });
  } catch (error) {
    if (error instanceof ApiError) return throwSafeGrantError(error);
    throw error;
  }
}

export async function listBoardGrants(
  rawBoardId: string,
  options: BoardGrantListOptions = {},
): Promise<BoardGrantList> {
  const boardId = uuidSchema.parse(rawBoardId);
  const { limit, offset, sortBy, sortOrder } = listOptionsSchema.parse(options);
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort_by: sortBy,
    sort_order: sortOrder,
  });
  return safeGrantJson(`/boards/${boardId}/grants?${query}`, listSchema);
}

export async function createBoardGrant(
  rawBoardId: string,
  input: BoardGrantCreate,
): Promise<BoardGrantMutation> {
  const boardId = uuidSchema.parse(rawBoardId);
  const grant = createSchema.parse(input);
  const body = {
    revision: grant.revision,
    principal_type: grant.principalType,
    ...("principalUserId" in grant
      ? { principal_user_id: grant.principalUserId }
      : {}),
    permission: grant.permission,
    effect: grant.effect,
  };
  const result = await safeGrantJson(
    `/boards/${boardId}/grants`,
    mutationSchema,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  if (
    result.boardRevision !== grant.revision + 1 ||
    result.grant.principalType !== grant.principalType ||
    result.grant.principalUserId !==
      ("principalUserId" in grant ? grant.principalUserId : null) ||
    result.grant.permission !== grant.permission ||
    result.grant.effect !== grant.effect
  )
    throw new ApiContractError();
  return result;
}

export async function revokeBoardGrant(
  rawBoardId: string,
  rawGrantId: string,
  rawRevision: number,
): Promise<void> {
  const boardId = uuidSchema.parse(rawBoardId);
  const grantId = uuidSchema.parse(rawGrantId);
  const revision = revisionSchema.parse(rawRevision);
  await safeGrantJson(
    `/boards/${boardId}/grants/${grantId}?revision=${revision}`,
    z.null(),
    { method: "DELETE" },
  );
}
