import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

const uuidSchema = z.string().uuid();
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

const levelRank = { read: 1, write: 2, manage: 3 } as const;
/**
 * A user's level on a Board. ``view``, ``edit`` and ``manage`` are derived from
 * the level so each flag matches the server's own ``read``, ``write`` and
 * ``manage``.
 */
const accessPreviewSchema = z
  .object({
    level: z.enum(["read", "write", "manage"]).nullable(),
    read: z.boolean(),
    write: z.boolean(),
    manage: z.boolean(),
  })
  .strict()
  .refine(({ level, read, write, manage }) => {
    const rank = level === null ? 0 : levelRank[level];
    return read === rank >= 1 && write === rank >= 2 && manage === rank >= 3;
  })
  .transform(({ level, read, write, manage }) => ({
    level,
    view: read,
    edit: write,
    manage,
  }));
const myAccessSchema = accessPreviewSchema.refine(({ view }) => view);
const previewUserSchema = z
  .object({ id: uuidSchema, username: z.string().min(1).max(100) })
  .strict();
const activitySchema = z
  .object({
    id: uuidSchema,
    created_at: z.iso.datetime({ offset: true }),
    kind: z.enum(["board", "group"]),
    action: z.enum(["create", "update", "delete"]),
    summary: z.string().min(1).max(100),
    actor_label: z.string().min(1).max(100).nullable(),
  })
  .strict()
  .transform(({ created_at, actor_label, ...event }) => ({
    ...event,
    createdAt: created_at,
    actorLabel: actor_label,
  }));

function listSchema<Item extends z.ZodType>(itemSchema: Item) {
  return z
    .object({ items: z.array(itemSchema), pagination: paginationSchema })
    .strict()
    .refine(({ items, pagination }) => items.length === pagination.count);
}

const previewUserListSchema = listSchema(previewUserSchema);
const activityListSchema = listSchema(activitySchema);

const pageOptions = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
};
const previewUserListOptionsSchema = z
  .object({
    ...pageOptions,
    sortBy: z.literal("username").default("username"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const activityListOptionsSchema = z
  .object({
    ...pageOptions,
    sortBy: z.literal("created_at").default("created_at"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

export type BoardToolsPage<T> = {
  items: T[];
  pagination: z.output<typeof paginationSchema>;
};
export type BoardAccessPreview = z.output<typeof accessPreviewSchema>;
export type BoardMyAccess = z.output<typeof myAccessSchema>;
export type BoardPreviewUser = z.output<typeof previewUserSchema>;
export type BoardActivity = z.output<typeof activitySchema>;
export type BoardPreviewUserListOptions = z.input<
  typeof previewUserListOptionsSchema
>;
export type BoardActivityListOptions = z.input<
  typeof activityListOptionsSchema
>;

function queryString(values: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    query.set(key, String(value));
  return query.toString();
}

export async function getMyBoardAccess(
  boardId: string,
): Promise<BoardMyAccess> {
  const validBoardId = uuidSchema.parse(boardId);
  try {
    return await apiFetch(`/boards/${validBoardId}/my-access`, myAccessSchema, {
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(
        error.status,
        error.status === 404
          ? "Board not found"
          : "Request could not be completed",
      );
    }
    throw error;
  }
}

export async function getBoardAccessPreview(
  boardId: string,
  userId: string,
): Promise<BoardAccessPreview> {
  const validBoardId = uuidSchema.parse(boardId);
  const validUserId = uuidSchema.parse(userId);
  return apiFetch(
    `/boards/${validBoardId}/access-preview?${queryString({ user_id: validUserId })}`,
    accessPreviewSchema,
    { cache: "no-store" },
  );
}

export async function listBoardPreviewUsers(
  boardId: string,
  options: BoardPreviewUserListOptions = {},
): Promise<BoardToolsPage<BoardPreviewUser>> {
  const validBoardId = uuidSchema.parse(boardId);
  const { limit, offset, sortBy, sortOrder, search } =
    previewUserListOptionsSchema.parse(options);
  const parameters: Record<string, string | number> = {
    limit,
    offset,
    sort_by: sortBy,
    sort_order: sortOrder,
  };
  if (search !== undefined) parameters.search = search;
  return apiFetch(
    `/boards/${validBoardId}/preview-users?${queryString(parameters)}`,
    previewUserListSchema,
    { cache: "no-store" },
  );
}

export async function listBoardActivity(
  boardId: string,
  options: BoardActivityListOptions = {},
): Promise<BoardToolsPage<BoardActivity>> {
  const validBoardId = uuidSchema.parse(boardId);
  const { limit, offset, sortBy, sortOrder } =
    activityListOptionsSchema.parse(options);
  return apiFetch(
    `/boards/${validBoardId}/activity?${queryString({
      limit,
      offset,
      sort_by: sortBy,
      sort_order: sortOrder,
    })}`,
    activityListSchema,
    { cache: "no-store" },
  );
}
