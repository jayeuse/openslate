import type { AccessPage, AccessVersioned } from "./api-contracts";

// Complete-collection loaders for Access lists. The backend caps a page at
// 100 items, so pickers and directories that need every row read bounded
// pages and fail closed when the pages disagree with each other.

export const ACCESS_PAGE_LIMIT = 100;
export const ACCESS_PAGE_MAXIMUM = 20;
const VERSION_READ_CONCURRENCY = 8;

export class AccessLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessLoadError";
  }
}

type PageRequest = { limit: number; offset: number; signal?: AbortSignal };
export type AccessPageReader<Item extends { id: string }> = (
  request: PageRequest,
) => Promise<AccessPage<Item>>;

export async function loadAllAccessPages<Item extends { id: string }>(
  read: AccessPageReader<Item>,
  options: { signal?: AbortSignal; maximumPages?: number } = {},
): Promise<Item[]> {
  const maximumPages = options.maximumPages ?? ACCESS_PAGE_MAXIMUM;
  if (!Number.isInteger(maximumPages) || maximumPages < 1) {
    throw new AccessLoadError("Access page limit is invalid.");
  }
  const seenOffsets = new Set<number>();
  const seenIds = new Set<string>();
  const items: Item[] = [];
  let expectedTotal: number | null = null;
  let offset = 0;

  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    throwIfAborted(options.signal);
    if (seenOffsets.has(offset)) {
      throw new AccessLoadError("Access pagination repeated an offset.");
    }
    seenOffsets.add(offset);
    const page = await read({
      limit: ACCESS_PAGE_LIMIT,
      offset,
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    const pagination = page.pagination;
    if (
      pagination.limit !== ACCESS_PAGE_LIMIT ||
      pagination.offset !== offset ||
      pagination.count !== page.items.length ||
      pagination.count > ACCESS_PAGE_LIMIT ||
      pagination.total < pagination.count
    ) {
      throw new AccessLoadError("Access pagination response is inconsistent.");
    }
    if (expectedTotal === null) expectedTotal = pagination.total;
    if (pagination.total !== expectedTotal) {
      throw new AccessLoadError(
        "Access pagination total changed during loading.",
      );
    }
    for (const item of page.items) {
      if (seenIds.has(item.id)) {
        throw new AccessLoadError("Access pagination repeated an item.");
      }
      seenIds.add(item.id);
      items.push(item);
    }
    const nextOffset = offset + pagination.count;
    if (pagination.has_more !== nextOffset < pagination.total) {
      throw new AccessLoadError(
        "Access pagination continuation is inconsistent.",
      );
    }
    if (!pagination.has_more) {
      if (nextOffset !== pagination.total) {
        throw new AccessLoadError("Access pagination ended before its total.");
      }
      return items;
    }
    if (nextOffset <= offset) {
      throw new AccessLoadError("Access pagination did not progress.");
    }
    offset = nextOffset;
  }
  throw new AccessLoadError("Access pagination exceeded its safe page limit.");
}

export async function loadVersionedAccessDetails<Item extends { id: string }>(
  items: readonly Item[],
  read: (
    id: string,
    options: { signal?: AbortSignal },
  ) => Promise<AccessVersioned<Item>>,
  options: { signal?: AbortSignal } = {},
): Promise<{ items: Item[]; etags: Record<string, string> }> {
  const result: Item[] = [];
  const etags: Record<string, string> = {};
  for (let index = 0; index < items.length; index += VERSION_READ_CONCURRENCY) {
    throwIfAborted(options.signal);
    const batch = items.slice(index, index + VERSION_READ_CONCURRENCY);
    const versions = await Promise.all(
      batch.map((item) =>
        read(item.id, { signal: options.signal }).then((version) => ({
          item,
          version,
        })),
      ),
    );
    throwIfAborted(options.signal);
    for (const { item, version } of versions) {
      if (
        version.data.id !== item.id ||
        typeof version.etag !== "string" ||
        !version.etag.trim()
      ) {
        throw new AccessLoadError("Access resource detail is inconsistent.");
      }
      result.push(version.data);
      etags[item.id] = version.etag;
    }
  }
  return { items: result, etags };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
}
