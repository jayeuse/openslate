/** Complete results are required for all-results exports, grouping and metrics. */
export type CompleteCollection<T> = {
  kind: "complete";
  queryKey: string;
  items: readonly T[];
};

/** A page's total describes the full filtered query, never just its items. */
export type PageResult<T> = {
  kind: "page";
  queryKey: string;
  items: readonly T[];
  total: number;
  offset: number;
  limit: number;
};

export function completeCollection<T>(
  items: readonly T[],
  queryKey: string,
): CompleteCollection<T> {
  return { kind: "complete", queryKey, items };
}

/** Call after domain filtering and sorting; never pass an already sliced list. */
export function pageCollection<T>(
  source: CompleteCollection<T>,
  offset: number,
  limit: number,
): PageResult<T> {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(offset))
    throw new RangeError(
      "A page requires a positive integer limit and a finite offset.",
    );
  const total = source.items.length;
  const lastOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
  const safeOffset = Math.max(0, Math.min(Math.trunc(offset), lastOffset));
  return {
    kind: "page",
    queryKey: source.queryKey,
    items: source.items.slice(safeOffset, safeOffset + limit),
    total,
    offset: safeOffset,
    limit,
  };
}
