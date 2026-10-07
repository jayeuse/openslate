"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import { listBoardEventOccurrences } from "../adapters/board-events-api";
import type { BoardEventOccurrencePage } from "../adapters/board-events-api";

export type CalendarWindow = { start: string; end: string; label: string };
export type CalendarState = {
  key: string | null;
  sequence: number;
  data: BoardEventOccurrencePage | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
};
export type CalendarEvent =
  | { type: "begin"; key: string; sequence: number }
  | { type: "invalidate"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      data: BoardEventOccurrencePage;
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
    };

function monthDate(month: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Invalid calendar month");
  const [year, part] = month.split("-").map(Number);
  return new Date(Date.UTC(year, part - 1, 1, 12));
}

function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** The label uses the workspace format; without a region it is the plain month. */
export function calendarWindowForMonth(
  month: string,
  region?: WorkspaceRegion,
): CalendarWindow {
  const first = monthDate(month);
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12),
  );
  return {
    start: dateKey(first),
    end: dateKey(last),
    label: region
      ? formatWorkspaceDate(dateKey(first), region, {
          month: "long",
          year: "numeric",
        })
      : month,
  };
}

export function shiftCalendarMonth(month: string, amount: number): string {
  const date = monthDate(month);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return dateKey(date).slice(0, 7);
}

export function transitionCalendarState(
  state: CalendarState,
  event: CalendarEvent,
): CalendarState {
  if (event.type === "invalidate")
    return {
      key: event.key,
      sequence: event.sequence,
      data: null,
      status: "loading",
      error: null,
    };
  if (event.type === "begin")
    return {
      key: event.key,
      sequence: event.sequence,
      data: state.key === event.key ? state.data : null,
      status: "loading",
      error: null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return { ...state, data: event.data, status: "ready", error: null };
  const data = event.retain ? state.data : null;
  return {
    ...state,
    data,
    status: data ? "ready" : "error",
    error: event.error,
  };
}

export function mergeCalendarOccurrencePages(
  current: BoardEventOccurrencePage,
  next: BoardEventOccurrencePage,
): BoardEventOccurrencePage | null {
  if (
    current.pagination.offset !== 0 ||
    current.pagination.count !== current.items.length ||
    next.pagination.offset !== current.items.length ||
    next.pagination.count !== next.items.length ||
    current.boardRevision !== next.boardRevision ||
    current.pagination.total !== next.pagination.total
  )
    return null;
  const items = [...current.items, ...next.items];
  if (items.length > next.pagination.total) return null;
  return {
    ...current,
    items,
    pagination: {
      ...current.pagination,
      count: items.length,
      total: next.pagination.total,
      hasMore: next.pagination.hasMore,
    },
  };
}

function retainOnFailure(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500;
  return error instanceof TypeError;
}

const initialState: CalendarState = {
  key: null,
  sequence: 0,
  data: null,
  status: "idle",
  error: null,
};

export function useServerBoardEvents(
  boardId: string,
  window: CalendarWindow | null,
  refreshKey: number,
  search = "",
) {
  const [state, setState] = useState<CalendarState>(initialState);
  const [retry, setRetry] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const sequence = useRef(0);
  const loadingMore = useRef(false);
  const normalizedSearch = search.trim();
  const key = `${boardId}:${window?.start ?? "workspace-date-pending"}:${window?.end ?? ""}:${normalizedSearch}`;

  useEffect(() => {
    const request = ++sequence.current;
    setLoadMoreError(null);
    setIsLoadingMore(false);
    loadingMore.current = false;
    if (!window) {
      setState({ ...initialState, key, sequence: request, status: "loading" });
      return () => {
        sequence.current += 1;
      };
    }
    setState((current) =>
      transitionCalendarState(current, {
        type: "begin",
        key,
        sequence: request,
      }),
    );
    void listBoardEventOccurrences(boardId, {
      windowStart: window.start,
      windowEnd: window.end,
      limit: 100,
      offset: 0,
      ...(normalizedSearch ? { search: normalizedSearch } : {}),
    })
      .then((data) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionCalendarState(current, {
            type: "resolve",
            key,
            sequence: request,
            data,
          }),
        );
      })
      .catch((error: unknown) => {
        if (request !== sequence.current) return;
        setState((current) =>
          transitionCalendarState(current, {
            type: "reject",
            key,
            sequence: request,
            error:
              error instanceof ApiError && error.status < 500
                ? "Calendar unavailable. Ask a Board manager to check your access, or retry."
                : "Could not refresh this calendar. Try again.",
            retain: retainOnFailure(error),
          }),
        );
      });
    return () => {
      sequence.current += 1;
    };
  }, [
    boardId,
    key,
    normalizedSearch,
    refreshKey,
    retry,
    window?.end,
    window?.start,
  ]);

  async function loadNextPage() {
    const current = state.key === key ? state.data : null;
    if (!window || !current?.pagination.hasMore || loadingMore.current) return;
    loadingMore.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    const request = sequence.current;
    try {
      const next = await listBoardEventOccurrences(boardId, {
        windowStart: window.start,
        windowEnd: window.end,
        limit: 100,
        offset: current.items.length,
        ...(normalizedSearch ? { search: normalizedSearch } : {}),
      });
      if (request !== sequence.current) return;
      if (!mergeCalendarOccurrencePages(current, next)) {
        const invalidation = ++sequence.current;
        setState((latest) =>
          transitionCalendarState(latest, {
            type: "invalidate",
            key,
            sequence: invalidation,
          }),
        );
        setRetry((value) => value + 1);
        return;
      }
      setState((latest) => {
        if (
          latest.key !== key ||
          latest.sequence !== request ||
          latest.data === null
        )
          return latest;
        const merged = mergeCalendarOccurrencePages(latest.data, next);
        return merged
          ? { ...latest, data: merged, status: "ready", error: null }
          : latest;
      });
    } catch (error) {
      if (request !== sequence.current) return;
      const retain = retainOnFailure(error);
      if (!retain)
        setState((latest) =>
          latest.key === key && latest.sequence === request
            ? { ...latest, data: null, status: "error" }
            : latest,
        );
      setLoadMoreError(
        error instanceof ApiError && error.status < 500
          ? "Calendar access changed or the results are unavailable. Refresh and retry."
          : "Could not load more events. Your current calendar is still available; try again.",
      );
    } finally {
      loadingMore.current = false;
      setIsLoadingMore(false);
    }
  }

  return {
    state:
      state.key === key
        ? state
        : { ...initialState, key, status: "loading" as const },
    retry: () => setRetry((value) => value + 1),
    loadMore: loadNextPage,
    isLoadingMore,
    loadMoreError,
    invalidate: () => {
      const request = ++sequence.current;
      setState((current) =>
        transitionCalendarState(current, {
          type: "invalidate",
          key,
          sequence: request,
        }),
      );
      setRetry((value) => value + 1);
    },
  };
}
