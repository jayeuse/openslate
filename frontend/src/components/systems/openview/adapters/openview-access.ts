"use client";

import { useSyncExternalStore } from "react";
import type { z } from "zod";
import { ApiError, apiFetch, type ApiRequestInit } from "@/lib/api";

// Every OpenView read (data sources, fields, saved views,
// records, aggregates, Dashboards, Reports and their history and schedules,
// shared outputs) requires records.read. So a refusal
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
  listeners: Set<() => void>;
};

const latch: Latch = {
  epoch: 0,
  sequence: 0,
  latestSuccess: 0,
  deniedAt: null,
  listeners: new Set(),
};

function notify() {
  for (const listener of [...latch.listeners]) listener();
}

function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status);
}

/**
 * Starts a fresh latch for a newly verified account. Called once per account
 * by the query provider.
 */
export function bindOpenViewAccess(): void {
  latch.epoch += 1;
  latch.sequence = 0;
  latch.latestSuccess = 0;
  latch.deniedAt = null;
  notify();
}

function refuse(startedAt: number) {
  // A read that started later has already been authorized.
  if (latch.latestSuccess > startedAt) return;
  const wasDenied = latch.deniedAt !== null;
  latch.deniedAt = Math.max(latch.deniedAt ?? 0, startedAt);
  // Reads in flight are left to settle. One that started before this refusal
  // cannot clear it (authorize requires a later start), and the refused read
  // must keep its error so its screen holds the denial through its own Retry
  // (use-server-views-resource.ts). Cancelling in-flight queries here also
  // reverted the refused query itself, which is still fetching when its 403
  // arrives, and so dropped the denial.
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
