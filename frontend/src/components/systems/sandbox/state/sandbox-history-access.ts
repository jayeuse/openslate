"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api";
import type { SandboxVersionDetail, SandboxVersionPage } from "./api";

type HistoryAccess = {
  denied: boolean;
  missingVersionIds: ReadonlySet<string>;
};

let epoch = 0;
let sequence = 0;
let deniedAt: number | null = null;
let client: QueryClient | null = null;
const missing = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: HistoryAccess = { denied: false, missingVersionIds: new Set() };

function notify() {
  snapshot = {
    denied: deniedAt !== null,
    missingVersionIds: new Set(missing.keys()),
  };
  for (const listener of [...listeners]) listener();
}

/** Bind the existing per-account cache; earlier-account reads cannot affect it. */
export function bindSandboxHistoryAccess(nextClient: QueryClient): void {
  epoch += 1;
  sequence = 0;
  deniedAt = null;
  client = nextClient;
  missing.clear();
  notify();
}

function refuse() {
  const alreadyDenied = deniedAt !== null;
  // Fence every read already started when the refusal ARRIVES. Imperative
  // comparison reads are not QueryClient-cancellable and may complete later.
  deniedAt = sequence;
  // Reverted old reads remain hidden; a cached success is not reauthorization.
  for (const prefix of [
    ["sandbox", "versions"],
    ["sandbox", "version"],
  ])
    for (const query of client?.getQueryCache().findAll({
      queryKey: prefix,
      fetchStatus: "fetching",
    }) ?? [])
      void query.cancel({ revert: true });
  if (!alreadyDenied) notify();
}

function unavailable(id: string) {
  const before = missing.get(id);
  missing.set(id, sequence);
  if (before === undefined) notify();
}

function authorize(startedAt: number, availableIds: readonly string[]) {
  let changed = false;
  if (deniedAt !== null && startedAt > deniedAt) {
    deniedAt = null;
    changed = true;
  }
  for (const id of availableIds) {
    const refusedAt = missing.get(id);
    if (refusedAt !== undefined && startedAt > refusedAt) {
      missing.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}

async function trackHistoryRead<T>(
  id: string | null,
  read: () => Promise<T>,
  availableIds: (value: T, startedAt: number) => readonly string[],
): Promise<T> {
  const readEpoch = epoch;
  const startedAt = ++sequence;
  try {
    const value = await read();
    if (readEpoch === epoch)
      authorize(startedAt, availableIds(value, startedAt));
    return value;
  } catch (error) {
    if (readEpoch === epoch && error instanceof ApiError) {
      if (
        [401, 403].includes(error.status) ||
        (id === null && error.status === 404)
      )
        refuse();
      else if (id !== null && error.status === 404) unavailable(id);
    }
    throw error;
  }
}

export function trackSandboxHistoryList(
  read: () => Promise<SandboxVersionPage>,
): Promise<SandboxVersionPage> {
  return trackHistoryRead(null, read, (page) =>
    page.items
      .filter((version) => !version.isDeleted)
      .map((version) => version.id),
  );
}

export function trackSandboxHistoryVersion(
  id: string,
  read: () => Promise<SandboxVersionDetail>,
): Promise<SandboxVersionDetail> {
  return trackHistoryRead(id, read, (version) => {
    if (version.isDeleted) {
      unavailable(id);
      return [];
    }
    return [version.id];
  });
}

/** A confirmed deletion invalidates its old metadata, including cached pages. */
export function invalidateSandboxHistoryVersion(id: string): void {
  sequence += 1;
  unavailable(id);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSandboxHistoryAccess(): HistoryAccess {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
