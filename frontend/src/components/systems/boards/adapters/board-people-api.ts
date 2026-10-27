import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";

const uuid = z.string().uuid();
/** The board people read sends at most this many people a page. */
export const BOARD_PEOPLE_PAGE_SIZE = 100;

const personWire = z
  .object({
    id: uuid,
    display_name: z.string().min(1),
    avatar_url: z.string().nullable(),
  })
  .strict()
  .transform(({ id, display_name, avatar_url }) => ({
    id,
    name: display_name,
    avatarUrl: avatar_url,
  }));
const pageWire = z
  .object({
    items: z.array(personWire).max(BOARD_PEOPLE_PAGE_SIZE),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(BOARD_PEOPLE_PAGE_SIZE),
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
      new Set(items.map((person) => person.id)).size !== items.length
    )
      context.addIssue({
        code: "custom",
        message: "People page is inconsistent",
      });
  })
  .transform(({ items, pagination: { has_more, ...pagination } }) => ({
    items,
    pagination: { ...pagination, hasMore: has_more },
  }));

export type BoardPerson = z.output<typeof personWire>;
export type BoardPeoplePage = z.output<typeof pageWire>;

/**
 * The people who can read a board now, by name: whom a writer can pick as
 * a card's assignee (BR64). Writers and managers only; a reader gets 403.
 */
export async function listBoardPeople(
  rawBoardId: string,
  options: { offset?: number; search?: string; signal?: AbortSignal } = {},
): Promise<BoardPeoplePage> {
  const boardId = uuid.parse(rawBoardId);
  const offset = z
    .number()
    .int()
    .min(0)
    .parse(options.offset ?? 0);
  const search = z
    .string()
    .trim()
    .max(100)
    .parse(options.search ?? "");
  const query = new URLSearchParams({
    limit: String(BOARD_PEOPLE_PAGE_SIZE),
    offset: String(offset),
  });
  if (search) query.set("search", search);
  const page = await apiFetch(`/boards/${boardId}/people?${query}`, pageWire, {
    cache: "no-store",
    signal: options.signal,
  });
  if (
    page.pagination.limit !== BOARD_PEOPLE_PAGE_SIZE ||
    page.pagination.offset !== offset
  )
    throw new ApiContractError();
  return page;
}
