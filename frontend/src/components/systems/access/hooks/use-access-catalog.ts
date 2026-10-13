"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  queryOptions,
  useQuery,
  useQueries,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import {
  extendsRead,
  readStamp,
} from "../../openview/adapters/openview-queries";
import {
  type AccessDeletedFilter,
  type AccessDepartment,
  type AccessModule,
  type AccessGroup,
  type AccessPage,
} from "../state/api-contracts";
import {
  getAccessGroup,
  getAccessDepartment,
  getAccessModule,
  listAccessDepartments,
  listAccessModules,
  listAccessGroups,
} from "../state/api";
import {
  clearRefusal,
  refusalRevision,
  trackRefusal,
  useRefusalLatch,
} from "./refusal-latch";

type CatalogItem = AccessDepartment | AccessModule | AccessGroup;
type Kind = "departments" | "modules" | "groups";
type Request = {
  limit: number;
  offset: number;
  search: string;
  deleted: AccessDeletedFilter;
  departmentId?: string;
  signal?: AbortSignal;
};

const refusalKey = (kind: Kind) => ["access", "catalog-refusal", kind] as const;
const trackCatalogRead = <Value>(
  client: QueryClient,
  kind: Kind,
  read: () => Promise<Value>,
  signal?: AbortSignal,
) => trackRefusal(client, refusalKey(kind), read, signal);

function readPage(
  kind: Kind,
  request: Request,
): Promise<AccessPage<CatalogItem>> {
  const { departmentId, ...page } = request;
  if (kind === "departments")
    return listAccessDepartments({ ...page, sort_by: "department_name" });
  if (kind === "modules")
    return listAccessModules({
      ...page,
      department_id: departmentId,
      sort_by: "module_name",
    });
  return listAccessGroups({ ...page, sort_by: "name" });
}
async function readItem(
  kind: Kind,
  id: string,
  signal: AbortSignal,
): Promise<CatalogItem | null> {
  try {
    if (kind === "groups") return (await getAccessGroup(id, { signal })).data;
    return kind === "departments"
      ? await getAccessDepartment(id, { signal })
      : await getAccessModule(id, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
export const accessCatalogOptions = (
  kind: Kind,
  request: Omit<Request, "signal">,
) =>
  queryOptions({
    queryKey: [
      "access",
      kind === "groups" ? "groups" : "catalog",
      "search",
      kind,
      request,
    ],
    queryFn: ({ signal }) => readPage(kind, { ...request, signal }),
  });

/** A bounded search with explicit continuation and independent selected-ID reads. */
export function useAccessCatalog({
  kind,
  selectedIds = [],
  departmentId,
  deleted = "exclude",
  enabled = true,
  listEnabled = true,
}: {
  kind: Kind;
  selectedIds?: readonly string[];
  departmentId?: string;
  deleted?: AccessDeletedFilter;
  enabled?: boolean;
  listEnabled?: boolean;
}) {
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [extension, setExtension] = useState<{
    scope: string;
    readAt: number;
    items: CatalogItem[];
    offset: number;
    hasMore: boolean;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  const latchKey = useMemo(() => refusalKey(kind), [kind]);
  const request = {
    limit: 25,
    offset: 0,
    search: applied,
    deleted,
    departmentId,
  };
  const scope = JSON.stringify([kind, request]);
  const options = accessCatalogOptions(kind, request);
  const query = useQuery({
    ...options,
    queryFn: ({ signal }) =>
      trackCatalogRead(
        client,
        kind,
        () => readPage(kind, { ...request, signal }),
        signal,
      ),
    enabled: enabled && listEnabled,
  });
  const ids = [...new Set(selectedIds)]
    .filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      ),
    )
    .sort();
  const currentInputs = useRef<object | null>(null);
  const recovery = useRef<object | null>(null);
  const inputScope = JSON.stringify([
    kind,
    request,
    search.trim(),
    ids,
    enabled,
    listEnabled,
  ]);
  useLayoutEffect(() => {
    const inputs = {};
    currentInputs.current = inputs;
    return () => {
      currentInputs.current = null;
    };
  }, [client, inputScope]);
  const selectedOptions = ids.map((id) => ({
    queryKey: [
      "access",
      kind === "groups" ? "groups" : "catalog",
      "selected",
      kind,
      id,
    ],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      trackCatalogRead(client, kind, () => readItem(kind, id, signal), signal),
    enabled,
  }));
  const selected = useQueries({
    queries: selectedOptions,
  });
  const denied = useRefusalLatch(latchKey, [
    query.error,
    ...selected.map((item) => item.error),
  ]);
  const matching = search.trim() === applied;
  const more =
    extension?.scope === scope && extendsRead(extension.readAt, query)
      ? extension
      : null;
  const items = useMemo(
    () =>
      enabled && !denied && matching
        ? [...(query.data?.items ?? []), ...(more?.items ?? [])]
        : [],
    [enabled, denied, matching, query.data, more],
  );
  const selectedItems =
    enabled && !denied
      ? selected.flatMap((result) => (result.data ? [result.data] : []))
      : [];
  const combined = [
    ...new Map(
      [...items, ...selectedItems].map((item) => [item.id, item]),
    ).values(),
  ];
  const hasMore =
    enabled &&
    !denied &&
    matching &&
    (more?.hasMore ?? query.data?.pagination.has_more ?? false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setApplied(search.trim());
      setPageError("");
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const loadMore = async () => {
    const stamp = readStamp(query);
    if (!hasMore || loadingMore || !stamp || !query.data) return;
    setLoadingMore(true);
    setPageError("");
    try {
      const offset =
        more?.offset ??
        query.data.pagination.offset + query.data.pagination.count;
      const page = await trackCatalogRead(client, kind, () =>
        readPage(kind, { ...request, offset }),
      );
      setExtension({
        scope,
        readAt: stamp,
        items: [...(more?.items ?? []), ...page.items],
        offset: offset + page.pagination.count,
        hasMore: page.pagination.has_more,
      });
    } catch {
      setPageError("More options could not be loaded. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };
  const retry = async () => {
    const inputs = currentInputs.current;
    if (!enabled || !matching || !inputs) return;
    const attempt = {};
    recovery.current = attempt;
    const revision = refusalRevision(client, latchKey);
    setPageError("");
    await Promise.all(
      [...(listEnabled ? [options] : []), ...selectedOptions].map((option) =>
        client.cancelQueries({ queryKey: option.queryKey, exact: true }),
      ),
    );
    if (currentInputs.current !== inputs || recovery.current !== attempt)
      return;
    const results = await Promise.all([
      ...(listEnabled ? [query.refetch()] : []),
      ...selected.map((item) => item.refetch()),
    ]);
    if (
      currentInputs.current === inputs &&
      recovery.current === attempt &&
      results.length > 0 &&
      results.every((result) => !result.isError)
    ) {
      clearRefusal(client, latchKey, revision);
      setExtension(null);
    }
  };
  return {
    search,
    onSearchChange: (value: string) => {
      recovery.current = null;
      setSearch(value);
    },
    items,
    selectedItems,
    combined,
    denied,
    loading: enabled && (!matching || query.isPending),
    selectedLoading: enabled && selected.some((item) => item.isPending),
    hasMore,
    loadingMore,
    loadMore,
    error: denied
      ? "Options are unavailable. Ask for access, then retry."
      : pageError ||
        (query.isError || selected.some((item) => item.isError)
          ? "Options could not be loaded. Try again."
          : ""),
    retry,
    query,
  };
}
export type AccessCatalogSearch = ReturnType<typeof useAccessCatalog>;
export const catalogDepartments = (
  items: readonly CatalogItem[],
): AccessDepartment[] =>
  items.filter((item): item is AccessDepartment => "department_name" in item);
export const catalogModules = (items: readonly CatalogItem[]): AccessModule[] =>
  items.filter((item): item is AccessModule => "module_name" in item);
export const catalogGroups = (items: readonly CatalogItem[]): AccessGroup[] =>
  items.filter((item): item is AccessGroup => "member_ids" in item);
