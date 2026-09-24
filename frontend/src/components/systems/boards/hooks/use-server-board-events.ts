"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
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

export function calendarWindowForMonth(month: string): CalendarWindow {
  const first = monthDate(month);
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12),
  );
  return {
    start: dateKey(first),
    end: dateKey(last),
    label: new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(first),
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
  window: CalendarWindow,
  refreshKey: number,
) {
  const [state, setState] = useState<CalendarState>(initialState);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const key = `${boardId}:${window.start}:${window.end}`;

  useEffect(() => {
    const request = ++sequence.current;
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
  }, [boardId, key, refreshKey, retry, window.end, window.start]);

  return {
    state:
      state.key === key
        ? state
        : { ...initialState, key, status: "loading" as const },
    retry: () => setRetry((value) => value + 1),
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
