import type { Pagination } from "../../src/lib/api";

// Pagination blocks for mock bodies and fixtures. `wirePagination` and
// `parsedPagination` return the literal fields they are given; only the
// first-page defaults (offset 0, no more items) are filled in, and nothing is
// derived from the items. Keep expected values in assertions spelled out
// instead of building them here.

type PaginationFields = {
  limit: number;
  offset?: number;
  count: number;
  total: number;
};

/** The API wire block, as list endpoints send it (`has_more`). */
export function wirePagination({
  limit,
  offset = 0,
  count,
  total,
  has_more = false,
}: PaginationFields & { has_more?: boolean }): Pagination {
  return { limit, offset, count, total, has_more };
}

/** The parsed block that adapters return (`hasMore`). */
export function parsedPagination({
  limit,
  offset = 0,
  count,
  total,
  hasMore = false,
}: PaginationFields & { hasMore?: boolean }) {
  return { limit, offset, count, total, hasMore };
}

/**
 * One page of a list response, as the API sends it, for fakes that page a
 * list.
 *
 * `count` is the number of items, `offset` defaults to 0 and `total` to the
 * number of items. `has_more` is true while later items exist, unless
 * `hasMore` sets it explicitly.
 */
export function pageOf<T>(
  items: T[],
  {
    limit,
    offset = 0,
    total = items.length,
    hasMore = offset + items.length < total,
  }: { limit: number; offset?: number; total?: number; hasMore?: boolean },
) {
  return {
    items,
    pagination: {
      limit,
      offset,
      count: items.length,
      total,
      has_more: hasMore,
    },
  };
}
