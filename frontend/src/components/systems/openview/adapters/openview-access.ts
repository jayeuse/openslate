"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { z } from "zod";
import { ApiError, apiFetch, type ApiRequestInit } from "@/lib/api";

// Every OpenView read (data sources, fields, audience options, saved views,
// records, aggregates, Dashboards, Reports and their history and schedules,
// shared outputs, chart settings) requires records.read. So a refusal
// (401/403) of any one of them is a refusal of all of them: this latch hides
// every OpenView read's data at once, in every section, until a read that
// started after the refusal succeeds.
//
// Reads report here from the adapters (`trackOpenViewRead`), not from the
// screens, so a cached, uncached, or paged read counts the same way and a
// screen cannot forget to. Each read is numbered when it starts: a refusal
// that arrives after a newer read already succeeded is stale and ignored.
// Writes never report: a refused write means records.write is missing.

type Latch = {
  /** Increments when a new account binds; older reads are ignored. */
  epoch: number;
  /** Increments as each read starts. */
  sequence: number;
  /** Start number of the newest read that succeeded. */
  latestSuccess: number;
  /** Start number of the newest refused read; null while not refused. */
  deniedAt: number | null;
  client: QueryClient | null;
  listeners: Set<() => void>;
};

const latch: Latch = {
  epoch: 0,
  sequence: 0,
  latestSuccess: 0,
  deniedAt: null,
  client: null,
  listeners: new Set(),
};

function notify() {
  for (const listener of [...latch.listeners]) listener();
}

function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

/**
 * Starts a fresh latch for the account whose cache this client is. Called
 * once per verified account by the query provider.
 */
export function bindOpenViewAccess(client: QueryClient): void {
  latch.epoch += 1;
  latch.sequence = 0;
  latch.latestSuccess = 0;
  latch.deniedAt = null;
  latch.client = client;
  notify();
}

function refuse(startedAt: number) {
  // A read that started later has already been authorized.
  if (latch.latestSuccess > startedAt) return;
  const wasDenied = latch.deniedAt !== null;
  latch.deniedAt = Math.max(latch.deniedAt ?? 0, startedAt);
  // Cached reads in flight started before this answer arrived; cancel them
  // so none restores data the latch should hide. A reverted cancel keeps the
  // previous state (hidden) and never settles as a success.
  for (const query of latch.client?.getQueryCache().findAll({
    queryKey: ["openview"],
    fetchStatus: "fetching",
  }) ?? [])
    void query.cancel({ revert: true });
  if (!wasDenied) notify();
}

function authorize(startedAt: number) {
  latch.latestSuccess = Math.max(latch.latestSuccess, startedAt);
  if (latch.deniedAt !== null && startedAt > latch.deniedAt) {
    latch.deniedAt = null;
    notify();
  }
}

/** Runs one records.read request and reports its outcome to the latch. */
export async function trackOpenViewRead<T>(read: () => Promise<T>): Promise<T> {
  const epoch = latch.epoch;
  latch.sequence += 1;
  const startedAt = latch.sequence;
  try {
    const value = await read();
    if (epoch === latch.epoch) authorize(startedAt);
    return value;
  } catch (error) {
    if (epoch === latch.epoch && isRefusal(error)) refuse(startedAt);
    throw error;
  }
}

/** Whether OpenView access is refused for the signed-in account. */
export function isOpenViewAccessDenied(): boolean {
  return latch.deniedAt !== null;
}

function subscribe(listener: () => void) {
  latch.listeners.add(listener);
  return () => {
    latch.listeners.delete(listener);
  };
}

/** Whether OpenView access is refused, for rendering. */
export function useOpenViewAccessDenied(): boolean {
  return useSyncExternalStore(subscribe, isOpenViewAccessDenied, () => false);
}

/** `apiFetch` for a records.read request, reported to the latch. */
export function openViewReadFetch<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init?: ApiRequestInit,
): Promise<z.output<Schema>> {
  return trackOpenViewRead(() => apiFetch(path, schema, init));
}

/** Whether a request is a read (GET) rather than a command. */
export function isReadRequest(init?: ApiRequestInit): boolean {
  return (init?.method ?? "GET").toUpperCase() === "GET";
}
