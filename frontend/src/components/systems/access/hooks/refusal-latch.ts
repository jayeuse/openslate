"use client";

import { useLayoutEffect } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api";

/** One read-refusal latch, kept in the account's QueryClient. Each refusal
 * bumps `revision`, so a Retry that started before it cannot clear it. */
type Refusal = { denied: boolean; revision: number };

const isRefusalError = (error: unknown) =>
  error instanceof ApiError && [401, 403].includes(error.status);

export const refusalOptions = (key: QueryKey) =>
  queryOptions({
    queryKey: key,
    queryFn: async (): Promise<Refusal> => ({ denied: false, revision: 0 }),
    initialData: { denied: false, revision: 0 },
    enabled: false,
    // A remount must retain refusal until fresh Retry; account replacement
    // discards the owning QueryClient and every latch with it.
    gcTime: Infinity,
  });

function refuse(client: QueryClient, key: QueryKey) {
  client.setQueryData<Refusal>(key, (current) => ({
    denied: true,
    revision: (current?.revision ?? 0) + 1,
  }));
}

/** Latch a 401/403 from `read`, unless its request was aborted. */
export async function trackRefusal<Value>(
  client: QueryClient,
  key: QueryKey,
  read: () => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (!signal?.aborted && isRefusalError(error)) refuse(client, key);
    throw error;
  }
}

/** Snapshot before a Retry cancels and refetches its reads. */
export const refusalRevision = (client: QueryClient, key: QueryKey) =>
  client.getQueryData<Refusal>(key)?.revision;

/** After a Retry whose reads all succeeded: clear the latch only when no
 * refusal arrived after `revision` was read. */
export function clearRefusal(
  client: QueryClient,
  key: QueryKey,
  revision: number | undefined,
) {
  client.setQueryData<Refusal>(key, (current) =>
    current && current.revision === revision
      ? { ...current, denied: false }
      : current,
  );
}

/** `key` must keep its identity across renders: it is an effect dependency. */
export function useRefusalLatch(key: QueryKey, errors: readonly unknown[]) {
  const client = useQueryClient();
  const latched = useQuery(refusalOptions(key)).data.denied;
  const currentRefused = errors.some(isRefusalError);
  // Also admit refusals already cached before this observer mounted.
  useLayoutEffect(() => {
    if (currentRefused && !latched) refuse(client, key);
  }, [client, key, currentRefused, latched]);
  return latched || currentRefused;
}
