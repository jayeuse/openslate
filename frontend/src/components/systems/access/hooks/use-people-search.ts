"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  extendsRead,
  readStamp,
} from "../../openview/adapters/openview-queries";
import {
  peoplePickerOptions,
  type AccessPeopleSource,
  type AccessPickerPerson,
} from "../adapters/people-picker-queries";
import {
  listAccessMemberCandidates,
  listAccessUsers,
  type AccessPage,
} from "../state/api";

type Extension = {
  readAt: number;
  search: string;
  source: AccessPeopleSource;
  items: AccessPickerPerson[];
  hasMore: boolean;
  offset: number;
};

type PeopleRefusal = { denied: boolean; revision: number };
const refusalKey = (source: AccessPeopleSource) =>
  ["access", "people-picker-refusal", source] as const;
function refusePeople(client: QueryClient, source: AccessPeopleSource) {
  client.setQueryData<PeopleRefusal>(refusalKey(source), (current) => ({
    denied: true,
    revision: (current?.revision ?? 0) + 1,
  }));
}
async function trackPeopleRead<Value>(
  client: QueryClient,
  source: AccessPeopleSource,
  read: () => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (
      !signal?.aborted &&
      error instanceof ApiError &&
      [401, 403].includes(error.status)
    )
      refusePeople(client, source);
    throw error;
  }
}
function trackedPeopleOptions(
  client: QueryClient,
  source: AccessPeopleSource,
  request: Parameters<typeof peoplePickerOptions>[1],
) {
  const options = peoplePickerOptions(source, request);
  return {
    ...options,
    queryFn: (context: Parameters<NonNullable<typeof options.queryFn>>[0]) =>
      trackPeopleRead(
        client,
        source,
        async () => options.queryFn!(context),
        context.signal,
      ),
  };
}

// A stable combine retains item identities when unrelated view state changes.
// Consumers can memoize names/columns without remounting the invoking controls.
function combineSelectedPeople(
  results: readonly UseQueryResult<AccessPage<AccessPickerPerson>>[],
) {
  return {
    items: results.flatMap((result) => result.data?.items ?? []),
    errors: results.map((result) => result.error),
    pending: results.some((result) => result.isPending),
    failed: results.some((result) => result.isError),
    refetch: results.map((result) => result.refetch),
  };
}

export function usePeopleSearch({
  source = "users",
  selectedIds = [],
  enabled = true,
}: {
  source?: AccessPeopleSource;
  selectedIds?: readonly string[];
  enabled?: boolean;
} = {}) {
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [extension, setExtension] = useState<Extension | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  const refusal = useQuery({
    queryKey: refusalKey(source),
    queryFn: async (): Promise<PeopleRefusal> => ({
      denied: false,
      revision: 0,
    }),
    initialData: { denied: false, revision: 0 },
    enabled: false,
    // Survive dialog remounts until fresh Retry; the account owns this client.
    gcTime: Infinity,
  });
  const ids = [...new Set(selectedIds)].sort();
  const currentInputs = useRef<object | null>(null);
  const recovery = useRef<object | null>(null);
  const inputScope = JSON.stringify([
    source,
    search.trim(),
    appliedSearch,
    ids,
    enabled,
  ]);
  useLayoutEffect(() => {
    const inputs = {};
    currentInputs.current = inputs;
    return () => {
      currentInputs.current = null;
    };
  }, [client, inputScope]);
  const options = trackedPeopleOptions(client, source, {
    search: appliedSearch,
    limit: 25,
    offset: 0,
  });
  const query = useQuery({
    ...options,
    enabled,
  });
  // A saved/current membership comparison can name two sets of100 people.
  // Each existing selected-ID request remains inside the D22 limit; no search
  // page is followed to resolve these already-known IDs.
  const selectedOptions = Array.from(
    { length: Math.ceil(ids.length / 100) },
    (_, index) => ({
      ...trackedPeopleOptions(client, source, {
        ids: ids.slice(index * 100, (index + 1) * 100),
        limit: 100,
        offset: 0,
      }),
      enabled,
    }),
  );
  const selected = useQueries({
    combine: combineSelectedPeople,
    queries: selectedOptions,
  });
  const currentRefused = [query.error, ...selected.errors].some(
    (error) => error instanceof ApiError && [401, 403].includes(error.status),
  );
  const denied = refusal.data.denied || currentRefused;
  // Also admit refusals already cached before this observer mounted.
  useLayoutEffect(() => {
    if (currentRefused && !refusal.data.denied) refusePeople(client, source);
  }, [client, source, currentRefused, refusal.data.denied]);
  const matching = search.trim() === appliedSearch;
  const more =
    extension &&
    extension.search === appliedSearch &&
    extension.source === source &&
    extendsRead(extension.readAt, query)
      ? extension
      : null;
  const items = useMemo(
    () =>
      enabled && !denied && matching
        ? [...(query.data?.items ?? []), ...(more?.items ?? [])]
        : [],
    [denied, enabled, matching, more, query.data],
  );
  const selectedItems = useMemo(
    () => (enabled && !denied ? selected.items : []),
    [enabled, denied, selected.items],
  );
  const hasMore =
    enabled &&
    !denied &&
    matching &&
    (more?.hasMore ?? query.data?.pagination.has_more ?? false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(search.trim());
      setPageError("");
      setLoadingMore(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const loadMore = async () => {
    const stamp = readStamp(query);
    if (!hasMore || loadingMore || !stamp || !query.data) return;
    const offset =
      more?.offset ??
      query.data.pagination.offset + query.data.pagination.count;
    setLoadingMore(true);
    setPageError("");
    try {
      const request = { search: appliedSearch, limit: 25, offset };
      const page = await trackPeopleRead<AccessPage<AccessPickerPerson>>(
        client,
        source,
        () =>
          source === "users"
            ? listAccessUsers({
                ...request,
                deleted: "include",
                sort_by: "name",
              })
            : listAccessMemberCandidates({
                ...request,
                sort_by: "display_name",
              }),
      );
      setExtension({
        readAt: stamp,
        search: appliedSearch,
        source,
        items: [...(more?.items ?? []), ...page.items],
        hasMore: page.pagination.has_more,
        offset: offset + page.pagination.count,
      });
    } catch (error) {
      setPageError(
        apiErrorMessage(error, "More people could not be loaded. Try again."),
      );
    } finally {
      setLoadingMore(false);
    }
  };
  const retry = async () => {
    const inputs = currentInputs.current;
    if (!enabled || !matching || !inputs) return;
    const attempt = {};
    recovery.current = attempt;
    const revision = client.getQueryData<PeopleRefusal>(
      refusalKey(source),
    )?.revision;
    setPageError("");
    await Promise.all(
      [options, ...selectedOptions].map((option) =>
        client.cancelQueries({ queryKey: option.queryKey, exact: true }),
      ),
    );
    if (currentInputs.current !== inputs || recovery.current !== attempt)
      return;
    const results = await Promise.all([
      query.refetch(),
      ...selected.refetch.map((refetch) => refetch()),
    ]);
    if (
      currentInputs.current === inputs &&
      recovery.current === attempt &&
      results.every((result) => !result.isError)
    ) {
      client.setQueryData<PeopleRefusal>(refusalKey(source), (current) =>
        current && current.revision === revision
          ? { ...current, denied: false }
          : current,
      );
      setExtension(null);
    }
  };
  const error = denied
    ? "People are unavailable. Sign in or ask for access, then retry."
    : pageError ||
      (query.error || selected.failed
        ? "People could not be loaded. Try again."
        : "");
  return {
    search,
    onSearchChange: (value: string) => {
      recovery.current = null;
      setSearch(value);
    },
    items,
    selectedItems,
    loading: enabled && (!matching || query.isPending),
    selectedLoading: enabled && selected.pending,
    loadingMore,
    hasMore,
    loadMore,
    error,
    retry,
  };
}
