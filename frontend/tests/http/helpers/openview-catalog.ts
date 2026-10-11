/**
 * One page of an OpenView list response, as the API sends it.
 *
 * `offset` defaults to 0 and `total` to the number of items. `has_more` is
 * true while later items exist, unless `hasMore` sets it explicitly.
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
