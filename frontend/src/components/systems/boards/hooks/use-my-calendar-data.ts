"use client";

import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import { listMyCalendarSources } from "../adapters/board-calendar-sources-api";
import type { CalendarSource } from "../adapters/board-calendar-sources-api";
import {
  listMyDueCards,
  type MyDueCard,
} from "../adapters/board-due-cards-api";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import {
  listCrossBoardOccurrences,
  type CrossBoardOccurrence,
} from "../adapters/board-my-calendar-api";
import type { DateWindow } from "../domain/calendar-dates";
import {
  dueCardItems,
  occurrenceItems,
  recordItems,
  type CalendarItem,
} from "../domain/calendar-items";
import { myCalendarBoards, type MyCalendarBoard } from "../domain/my-calendar";
import {
  boardSourceCalendarId,
  sourceRecordsOptions,
  type CalendarReadStatus,
} from "./use-board-calendar-data";

/**
 * My calendar's reads for one window (P3b): every board's events in one
 * paged read, one window read per visible personal source, and the person's
 * due cards in one paged read. Hidden calendars apply in the browser; a
 * hidden source or "My cards · Due" is not read.
 */

export const myCalendarKeys = {
  occurrences: ["boards", "calendar", "my-occurrences"] as const,
  occurrenceWindow: (window: DateWindow, search: string) =>
    [
      "boards",
      "calendar",
      "my-occurrences",
      window.start,
      window.end,
      search,
    ] as const,
  sources: ["boards", "calendar", "my-sources"] as const,
  due: ["boards", "calendar", "my-due"] as const,
  dueWindow: (window: DateWindow) =>
    ["boards", "calendar", "my-due", window.start, window.end] as const,
};

/** The list row of "My cards · Due"; each card's chip takes its board's color. */
export const MY_DUE_CALENDAR = "my-due";
export function myDueCalendarId(boardId: string): string {
  return `my-due:${boardId}`;
}

export const myCalendarSourcesOptions = () =>
  queryOptions({
    queryKey: myCalendarKeys.sources,
    queryFn: () => listMyCalendarSources(),
  });

export const myOccurrencesOptions = (window: DateWindow, search: string) =>
  queryOptions({
    queryKey: myCalendarKeys.occurrenceWindow(window, search.trim()),
    queryFn: () =>
      listCrossBoardOccurrences({
        windowStart: window.start,
        windowEnd: window.end,
        search: search.trim() || undefined,
      }),
  });

export type MyCalendarWindowData = {
  /** One calendar per board the read covered, in list order. */
  boards: MyCalendarBoard[];
  occurrences: readonly CrossBoardOccurrence[];
  items: CalendarItem[];
  /** The first event after the window on any shown board (BR43). */
  nextOccurrence: { date: string } | null;
  eventsReady: boolean;
  eventsError: string | null;
  statuses: Map<string, CalendarReadStatus>;
  dueCards: readonly MyDueCard[];
  retry: (calendarId: string) => void;
};

export function useMyCalendarWindow({
  window,
  search,
  sources,
  hidden,
  listed,
  departmentOrder,
}: {
  window: DateWindow | null;
  search: string;
  sources: readonly CalendarSource[];
  hidden: ReadonlySet<string>;
  listed: readonly BoardManagementBoard[];
  departmentOrder: (departmentId: string) => number | null;
}): MyCalendarWindowData {
  const empty = { start: "", end: "" };
  const occurrences = useQuery({
    ...myOccurrencesOptions(window ?? empty, search),
    enabled: window !== null,
  });
  const visibleSources = sources.filter(
    (source) => !hidden.has(boardSourceCalendarId(source.id)),
  );
  const sourceReads = useQueries({
    queries: visibleSources.map((source) => ({
      ...sourceRecordsOptions(source, window ?? empty),
      enabled: window !== null,
    })),
  });
  const dueShown = !hidden.has(MY_DUE_CALENDAR);
  const dueRead = useQuery({
    queryKey: myCalendarKeys.dueWindow(window ?? empty),
    queryFn: () =>
      listMyDueCards({ from: window?.start ?? "", to: window?.end ?? "" }),
    enabled: window !== null && dueShown,
  });

  const data = occurrences.data;
  const boards = data
    ? myCalendarBoards(
        data.boards,
        listed,
        data.items.map((item) => item.board),
        departmentOrder,
      )
    : [];
  // Derived on each render: a few hundred items at most per window.
  const items: CalendarItem[] = [];
  for (const board of boards)
    items.push(
      ...occurrenceItems(
        (data?.items ?? []).filter((item) => item.board.id === board.id),
        board.calendarId,
      ),
    );
  visibleSources.forEach((source, index) => {
    const read = sourceReads[index]?.data;
    if (!read) return;
    items.push(
      ...recordItems(
        read.records,
        {
          id: source.id,
          moduleId: source.moduleId,
          dateFieldId: source.dateFieldId,
          fieldType: source.fieldType,
          titleFieldId: read.titleFieldId,
        },
        read.timezone,
        boardSourceCalendarId(source.id),
      ),
    );
  });
  const dueCards = dueShown ? (dueRead.data ?? []) : [];
  for (const card of dueCards)
    items.push(...dueCardItems([card], myDueCalendarId(card.board.id)));

  const statuses = new Map<string, CalendarReadStatus>();
  for (const board of boards)
    statuses.set(
      board.calendarId,
      occurrences.isFetching && board.status === "error"
        ? "loading"
        : board.status,
    );
  visibleSources.forEach((source, index) => {
    const read = sourceReads[index];
    statuses.set(
      boardSourceCalendarId(source.id),
      read.isError ? "error" : read.isSuccess ? "ready" : "loading",
    );
  });
  if (dueShown)
    statuses.set(
      MY_DUE_CALENDAR,
      dueRead.isError ? "error" : dueRead.isSuccess ? "ready" : "loading",
    );

  const shownBoards = new Set(
    boards
      .filter((board) => !hidden.has(board.calendarId))
      .map((board) => board.id),
  );
  const nextDates = (data?.boards ?? [])
    .filter((state) => shownBoards.has(state.boardId) && state.nextOccurrence)
    .map((state) => state.nextOccurrence?.date ?? "")
    .sort();

  return {
    boards,
    occurrences: data?.items ?? [],
    items,
    nextOccurrence: nextDates.length ? { date: nextDates[0] } : null,
    // A background refresh keeps the last window on screen.
    eventsReady: occurrences.isSuccess,
    eventsError: occurrences.isError
      ? "Events could not be loaded. Try again."
      : null,
    statuses,
    dueCards,
    retry: (calendarId) => {
      if (calendarId === MY_DUE_CALENDAR) {
        void dueRead.refetch();
        return;
      }
      const index = visibleSources.findIndex(
        (source) => boardSourceCalendarId(source.id) === calendarId,
      );
      if (index >= 0) {
        void sourceReads[index]?.refetch();
        return;
      }
      // A board's events come from the one window read.
      void occurrences.refetch();
    },
  };
}
