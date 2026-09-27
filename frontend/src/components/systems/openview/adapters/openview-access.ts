"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api";

// Every cached OpenView read (data sources, fields, audience options, saved
// views, Reports, shared outputs, chart settings) requires records.read. So a
// refusal (401/403) of any one of them is a refusal of all of them: this
// latch hides every cached OpenView read at once, in every section, until a
// read that started after the refusal succeeds. Detail reads (a Report you
// cannot open) are not cached and never set it.

type AccessLatch = {
  /** Fetch sequence at the refusal; null while access is not refused. */
  deniedAtSequence: number | null;
  /** Increments as each OpenView read starts a request. */
  sequence: number;
  startedAt: Map<string, number>;
  listeners: Set<() => void>;
};

const latches = new WeakMap<QueryClient, AccessLatch>();

// Only reads under the "openview" prefix need records.read; the signed-in
// identity (openViewKeys.authMe) lives outside it.
function isGatedKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "openview";
}

function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

function notify(latch: AccessLatch) {
  for (const listener of [...latch.listeners]) listener();
}

/** The latch for one account's cache, watching that cache from first use. */
function latchFor(client: QueryClient): AccessLatch {
  const existing = latches.get(client);
  if (existing) return existing;
  const latch: AccessLatch = {
    deniedAtSequence: null,
    sequence: 0,
    startedAt: new Map(),
    listeners: new Set(),
  };
  latches.set(client, latch);
  // The client lives as long as the verified account, so the watch does too.
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || !isGatedKey(event.query.queryKey)) return;
    const { action, query } = event;
    if (action.type === "fetch") {
      latch.sequence += 1;
      latch.startedAt.set(query.queryHash, latch.sequence);
    } else if (action.type === "error" && isRefusal(action.error)) {
      denyOpenViewAccess(client);
    } else if (
      action.type === "success" &&
      // A manual cache write (after a save) is not an authorized read: a
      // person can keep records.write after losing records.read.
      !action.manual &&
      latch.deniedAtSequence !== null &&
      (latch.startedAt.get(query.queryHash) ?? 0) > latch.deniedAtSequence
    ) {
      // A read that started after the refusal was authorized.
      latch.deniedAtSequence = null;
      notify(latch);
    }
  });
  return latch;
}

/** Starts watching an account's cache before any OpenView read runs. */
export function watchOpenViewAccess(client: QueryClient): void {
  latchFor(client);
}

/**
 * Records a refusal. Reads already in flight started before it, so they are
 * cancelled: a reverted cancel restores the read's previous state (which the
 * latch hides) and never settles as a success.
 */
export function denyOpenViewAccess(client: QueryClient): void {
  const latch = latchFor(client);
  latch.deniedAtSequence = latch.sequence;
  for (const query of client.getQueryCache().findAll({
    queryKey: ["openview"],
    fetchStatus: "fetching",
    predicate: (query) => isGatedKey(query.queryKey),
  }))
    void query.cancel({ revert: true });
  notify(latch);
}

/** Whether OpenView access is refused for an account's cache. */
export function isOpenViewAccessDenied(client: QueryClient): boolean {
  return latchFor(client).deniedAtSequence !== null;
}

/** Whether OpenView access is refused for the signed-in account. */
export function useOpenViewAccessDenied(): boolean {
  const client = useQueryClient();
  const latch = latchFor(client);
  const subscribe = useCallback(
    (listener: () => void) => {
      latch.listeners.add(listener);
      return () => {
        latch.listeners.delete(listener);
      };
    },
    [latch],
  );
  return useSyncExternalStore(
    subscribe,
    () => latch.deniedAtSequence !== null,
    () => false,
  );
}
