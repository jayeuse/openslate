import type { Route } from "next";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";

export const SEARCH_KINDS = ["record", "person", "post", "event"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
const itemSchema = z
  .object({
    kind: z.enum(SEARCH_KINDS),
    id: z.uuid(),
    title: z.string(),
    context_label: z.string(),
    module_id: z.uuid().nullable(),
    board_id: z.uuid().nullable(),
    can_open: z.boolean(),
  })
  .strict()
  .refine((item) =>
    item.kind === "record"
      ? item.module_id !== null && item.board_id === null
      : item.kind === "person"
        ? item.module_id === null && item.board_id === null
        : item.module_id === null && item.board_id !== null,
  );
const pageSchema = z
  .object({
    items: z.array(itemSchema),
    pagination: z
      .object({
        limit: z.number().int().min(1).max(100),
        offset: z.number().int().nonnegative(),
        count: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PlatformSearchItem = z.output<typeof itemSchema>;
export async function readPlatformSearch(
  search: string,
  kind: SearchKind,
  offset: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    search,
    kind,
    limit: "10",
    offset: String(offset),
    sort_by: "relevance",
    sort_order: "desc",
    deleted: "exclude",
  });
  const page = await apiFetch(`/search?${params}`, pageSchema, {
    signal,
    cache: "no-store",
  });
  if (
    page.items.some((item) => item.kind !== kind) ||
    page.pagination.limit !== 10 ||
    page.pagination.offset !== offset ||
    page.pagination.count !== page.items.length ||
    page.items.length > 10 ||
    (page.pagination.total < offset + page.items.length &&
      page.items.length > 0)
  )
    throw new ApiContractError();
  return page;
}
export const platformSearchOptions = (
  search: string,
  kind: SearchKind,
  offset: number,
) =>
  queryOptions({
    queryKey: ["platform", "search", { search, kind, offset, limit: 10 }],
    enabled: search.length > 0 && search.length <= 100,
    queryFn: ({ signal }) => readPlatformSearch(search, kind, offset, signal),
  });
export function searchDestination(item: PlatformSearchItem): Route | null {
  if (!item.can_open) return null;
  const id = encodeURIComponent(item.id);
  switch (item.kind) {
    case "record":
      return `/openview?section=views&module=${encodeURIComponent(item.module_id!)}&record=${id}` as Route;
    case "person":
      return `/access?view=people&user=${id}` as Route;
    case "post":
      return `/boards?board=${encodeURIComponent(item.board_id!)}&section=posts&post=${id}` as Route;
    case "event":
      return `/boards?board=${encodeURIComponent(item.board_id!)}&section=calendar&event=${id}` as Route;
  }
}
