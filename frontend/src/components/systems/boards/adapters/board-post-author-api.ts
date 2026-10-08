import { z } from "zod";
import { ApiContractError, ApiError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
const authorSchema = z
  .object({ id: uuid, label: z.string().min(1).max(100) })
  .strict();
const pageRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
    search: z.string().trim().max(100).optional(),
    ids: z.array(uuid).min(1).max(100).optional(),
  })
  .strict();
const choicesSchema = z
  .object({
    items: z.array(authorSchema).max(100),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().min(0),
        count: z.number().int().min(0),
        total: z.number().int().min(0),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ items, pagination }, context) => {
    if (
      pagination.count !== items.length ||
      pagination.count > pagination.limit ||
      (pagination.count > 0 &&
        pagination.offset + pagination.count > pagination.total) ||
      pagination.has_more !==
        pagination.offset + pagination.count < pagination.total ||
      (pagination.has_more && items.length === 0) ||
      new Set(items.map((choice) => choice.id)).size !== items.length
    )
      context.addIssue({
        code: "custom",
        message: "Author page is inconsistent",
      });
  })
  .transform(({ items, pagination: { has_more, ...pagination } }) => ({
    items,
    pagination: { ...pagination, hasMore: has_more },
  }));
export type BoardPostAuthorChoice = z.infer<typeof authorSchema>;
export type BoardPostAuthorPage = z.output<typeof choicesSchema>;
export type BoardPostAuthorListOptions = {
  limit?: number;
  offset?: number;
  search?: string;
  ids?: readonly string[];
  signal?: AbortSignal;
};

export async function listBoardPostAuthors(
  rawBoardId: string,
  options: BoardPostAuthorListOptions = {},
): Promise<BoardPostAuthorPage> {
  const boardId = uuid.parse(rawBoardId);
  const { signal, ...rawPage } = options;
  const page = pageRequestSchema.parse(rawPage);
  const query = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset),
  });
  if (page.search) query.set("search", page.search);
  for (const id of page.ids ?? []) query.append("ids", id);
  let choices: BoardPostAuthorPage;
  try {
    choices = await apiFetch(
      `/boards/${boardId}/post-authors?${query}`,
      choicesSchema,
      {
        cache: "no-store",
        signal,
      },
    );
  } catch (error) {
    if (error instanceof ApiError)
      throw new ApiError(error.status, "Author choices are unavailable");
    throw error;
  }
  if (
    choices.pagination.limit !== page.limit ||
    choices.pagination.offset !== page.offset ||
    (page.ids !== undefined &&
      (choices.items.some((choice) => !page.ids?.includes(choice.id)) ||
        choices.pagination.total > new Set(page.ids).size))
  )
    throw new ApiContractError();
  return choices;
}
