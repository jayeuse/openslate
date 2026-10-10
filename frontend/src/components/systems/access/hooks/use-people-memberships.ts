"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import {
  extendsRead,
  readStamp,
} from "../../openview/adapters/openview-queries";
import { groupListOptions } from "../adapters/access-queries";
import type { NamedItem } from "../helpers/people";
import {
  listAccessGroups,
  type AccessGroup,
  type AccessUser,
} from "../state/api";

type Refusal = { denied: boolean; revision: number };
const refusalKey = ["access", "people-membership-refusal"] as const;
function refuse(client: QueryClient) {
  client.setQueryData<Refusal>(refusalKey, (current) => ({
    denied: true,
    revision: (current?.revision ?? 0) + 1,
  }));
}
async function membershipRead<Value>(
  client: QueryClient,
  signal: AbortSignal,
  read: () => Promise<Value>,
): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (
      !signal.aborted &&
      error instanceof ApiError &&
      [401, 403].includes(error.status)
    )
      refuse(client);
    throw error;
  }
}

type Extension = {
  readAt: number;
  items: AccessGroup[];
  nextOffset: number;
  total: number;
  hasMore: boolean;
};
export type PersonMemberships = {
  groups: NamedItem[];
  departments: NamedItem[];
  loaded: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  recovering: boolean;
  denied: boolean;
  error: string;
  /** A refused or failed first page needs fresh Retry, even with retained names. */
  retryFirstPage: boolean;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
};

/** One membership state for every visible or selected person. Department reach
 * comes from those same groups, including for inactive and deleted accounts. */
export function usePeopleMemberships(people: readonly AccessUser[]) {
  const client = useQueryClient();
  const ids = [
    ...new Set(
      people
        .filter((person) => person.role !== "admin")
        .map((person) => person.id),
    ),
  ].sort();
  const scope = JSON.stringify(ids);
  const [extensions, setExtensions] = useState<Record<string, Extension>>({});
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(new Set());
  const [pageErrors, setPageErrors] = useState<Record<string, string>>({});
  const [recovering, setRecovering] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  const currentInputs = useRef<object | null>(null);
  const recovery = useRef<object | null>(null);
  useLayoutEffect(() => {
    currentInputs.current = {};
    const ownedControllers = controllers.current;
    return () => {
      currentInputs.current = null;
      recovery.current = null;
      for (const controller of ownedControllers.values()) controller.abort();
      ownedControllers.clear();
    };
  }, [client, scope]);

  const refusal = useQuery({
    queryKey: refusalKey,
    queryFn: async (): Promise<Refusal> => ({ denied: false, revision: 0 }),
    initialData: { denied: false, revision: 0 },
    enabled: false,
    // A remount must retain refusal until fresh Retry; account replacement
    // discards the owning QueryClient and every membership read with it.
    gcTime: Infinity,
  });
  const options = ids.map((id) => {
    const request = {
      member_id: id,
      limit: 25,
      offset: 0,
      sort_by: "name" as const,
    };
    return {
      ...groupListOptions("exclude", request),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        membershipRead(client, signal, () =>
          listAccessGroups({ ...request, deleted: "exclude", signal }),
        ),
    };
  });
  const queries = useQueries({ queries: options });
  const currentRefused = queries.some(
    (query) =>
      query.error instanceof ApiError &&
      [401, 403].includes(query.error.status),
  );
  const denied = refusal.data.denied || currentRefused;
  useLayoutEffect(() => {
    if (currentRefused && !refusal.data.denied) refuse(client);
  }, [client, currentRefused, refusal.data.denied]);

  const retry = async () => {
    const inputs = currentInputs.current;
    if (!inputs || !queries.length) return;
    const attempt = {};
    recovery.current = attempt;
    const revision = client.getQueryData<Refusal>(refusalKey)?.revision;
    setRecovering(true);
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    try {
      await Promise.all(
        options.map((option) =>
          client.cancelQueries({ queryKey: option.queryKey, exact: true }),
        ),
      );
      if (currentInputs.current !== inputs || recovery.current !== attempt)
        return;
      const results = await Promise.all(
        queries.map((query) => query.refetch()),
      );
      if (
        currentInputs.current === inputs &&
        recovery.current === attempt &&
        results.every((result) => !result.isError)
      ) {
        client.setQueryData<Refusal>(refusalKey, (current) =>
          current && current.revision === revision
            ? { ...current, denied: false }
            : current,
        );
        setExtensions({});
        setPageErrors({});
      }
    } finally {
      if (recovery.current === attempt || recovery.current === null)
        setRecovering(false);
    }
  };

  return new Map(
    ids.map((id, index): [string, PersonMemberships] => {
      const query = queries[index]!;
      const option = options[index]!;
      const extension = extensions[id];
      const more =
        extension && extendsRead(extension.readAt, query) ? extension : null;
      const groups = denied
        ? []
        : [
            ...new Map(
              [...(query.data?.items ?? []), ...(more?.items ?? [])].map(
                (group) => [group.id, group],
              ),
            ).values(),
          ];
      const departments = new Map<string, string>();
      for (const group of groups)
        for (const entry of group.access)
          departments.set(entry.department_id, entry.department_name);
      const total = more?.total ?? query.data?.pagination.total ?? 0;
      const hasMore =
        !denied && (more?.hasMore ?? query.data?.pagination.has_more ?? false);
      const error = denied
        ? "Groups are unavailable. Ask for access, then retry."
        : query.isError
          ? "Groups could not be loaded. Try again."
          : pageErrors[id] || "";
      const loadMore = async () => {
        const stamp = readStamp(query);
        const inputs = currentInputs.current;
        if (
          !hasMore ||
          !stamp ||
          !query.data ||
          !inputs ||
          controllers.current.has(id)
        )
          return;
        const controller = new AbortController();
        controllers.current.set(id, controller);
        setLoadingIds((current) => new Set([...current, id]));
        setPageErrors((current) => ({ ...current, [id]: "" }));
        const offset =
          more?.nextOffset ??
          query.data.pagination.offset + query.data.pagination.count;
        try {
          const page = await membershipRead(client, controller.signal, () =>
            listAccessGroups({
              member_id: id,
              deleted: "exclude",
              limit: 25,
              offset,
              sort_by: "name",
              signal: controller.signal,
            }),
          );
          if (
            controller.signal.aborted ||
            currentInputs.current !== inputs ||
            client.getQueryState(option.queryKey)?.dataUpdatedAt !== stamp
          )
            return;
          setExtensions((current) => ({
            ...current,
            [id]: {
              readAt: stamp,
              items: [...(more?.items ?? []), ...page.items],
              nextOffset: page.pagination.offset + page.pagination.count,
              total: page.pagination.total,
              hasMore: page.pagination.has_more,
            },
          }));
        } catch {
          if (!controller.signal.aborted && currentInputs.current === inputs)
            setPageErrors((current) => ({
              ...current,
              [id]: "More groups could not be loaded. Try again.",
            }));
        } finally {
          if (
            !controllers.current.has(id) ||
            controllers.current.get(id) === controller
          ) {
            controllers.current.delete(id);
            setLoadingIds(
              (current) =>
                new Set([...current].filter((value) => value !== id)),
            );
          }
        }
      };
      return [
        id,
        {
          groups: groups.map((group) => ({ id: group.id, name: group.name })),
          departments: [...departments]
            .map(([id, name]) => ({ id, name }))
            .sort((left, right) =>
              left.name.localeCompare(right.name, undefined, {
                sensitivity: "base",
              }),
            ),
          loaded: groups.length,
          total,
          hasMore,
          loading: query.isPending && !query.isError,
          loadingMore: loadingIds.has(id),
          recovering,
          denied,
          error,
          retryFirstPage: denied || query.isError,
          loadMore,
          retry,
        },
      ];
    }),
  );
}
