"use client";

import { useEffect } from "react";
import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import {
  dataSourceOptions,
  fieldOptions,
} from "../../openview/adapters/openview-queries";
import { queryOpenViewWindowRecords } from "../../openview/adapters/window-api";
import type { OpenViewQueryFieldReference } from "../../openview/adapters/views-api";
import {
  listBoardCalendarSources,
  type CalendarSource,
} from "../adapters/board-calendar-sources-api";
import {
  listDueBoardCards,
  type DueCard,
} from "../adapters/board-due-cards-api";
import {
  dueCardItems,
  occurrenceItems,
  recordItems,
  type CalendarItem,
  type SourceRecord,
} from "../domain/calendar-items";
import type { DateWindow } from "../domain/calendar-dates";
import { useServerBoardEvents } from "./use-server-board-events";

/**
 * The board calendar's reads for one window (P3a): the board's events, one
 * window read per visible record source, and the board's due cards. The
 * calendar list and views only see `CalendarItem`s, so My calendar (P3b) can
 * feed the same views from other reads.
 */

export const boardCalendarKeys = {
  all: ["boards", "calendar"] as const,
  sources: (boardId: string) =>
    ["boards", "calendar", "sources", boardId] as const,
  sourceRecords: ["boards", "calendar", "source-records"] as const,
  dueCards: (boardId: string, window: DateWindow) =>
    [
      "boards",
      "calendar",
      "due-cards",
      boardId,
      window.start,
      window.end,
    ] as const,
};

export const boardCalendarSourcesOptions = (boardId: string) =>
  queryOptions({
    queryKey: boardCalendarKeys.sources(boardId),
    queryFn: () => listBoardCalendarSources(boardId),
  });

/** A window read's page size, and the most pages one source reads. */
const RECORD_PAGE = 100;
const RECORD_PAGES = 5;

export function boardSourceCalendarId(sourceId: string): string {
  return `source:${sourceId}`;
}
export function boardEventsCalendarId(boardId: string): string {
  return `board:${boardId}`;
}
export function boardDueCalendarId(boardId: string): string {
  return `due:${boardId}`;
}

export const sourceRecordsOptions = (
  source: CalendarSource,
  window: DateWindow,
) =>
  queryOptions({
    queryKey: [
      ...boardCalendarKeys.sourceRecords,
      source.id,
      source.moduleId,
      source.dateFieldId,
      window.start,
      window.end,
    ] as const,
    queryFn: async ({ client }) => {
      const moduleInfo = await client.fetchQuery(
        dataSourceOptions(source.moduleId),
      );
      const titleField =
        moduleInfo.titleFieldId &&
        moduleInfo.titleFieldId !== source.dateFieldId
          ? await client.fetchQuery(
              fieldOptions(source.moduleId, moduleInfo.titleFieldId),
            )
          : null;
      const dateField: OpenViewQueryFieldReference = {
        fieldId: source.dateFieldId,
        expectedType: source.fieldType,
      };
      const columns: OpenViewQueryFieldReference[] = [dateField];
      if (titleField)
        columns.push({ fieldId: titleField.id, expectedType: titleField.type });
      const records: SourceRecord[] = [];
      let timezone: string | null = null;
      for (let page = 0; page < RECORD_PAGES; page += 1) {
        const result = await queryOpenViewWindowRecords({
          moduleId: source.moduleId,
          mode: "calendar",
          scope: "window",
          dateField,
          fromDate: window.start,
          toDate: window.end,
          limit: RECORD_PAGE,
          offset: records.length,
          definition: {
            version: 1,
            logic: "and",
            columns,
            filters: [],
            sort: [],
            deleted: "exclude",
            search: null,
            searchFields: [],
          },
        });
        timezone = result.timezone;
        records.push(...result.items);
        if (!result.pagination.hasMore) break;
      }
      return { records, timezone, titleFieldId: moduleInfo.titleFieldId };
    },
  });

export function useBoardCalendarSources(boardId: string) {
  return useQuery(boardCalendarSourcesOptions(boardId));
}

/** "limited": the server capped the board's events for the window (not a failure). */
export type CalendarReadStatus = "loading" | "ready" | "error" | "limited";

export type CalendarWindowData = {
  items: CalendarItem[];
  /** The first event after the window (BR43), when the events read it. */
  nextOccurrence: { date: string } | null;
  /** True once the board's events for the window are complete. */
  eventsReady: boolean;
  eventsError: string | null;
  statuses: Map<string, CalendarReadStatus>;
  /** The due cards behind the "Cards · Due" items, for their summary. */
  dueCards: readonly DueCard[];
  retry: (calendarId: string) => void;
  /** The events read, for the editor and lifecycle checks. */
  events: ReturnType<typeof useServerBoardEvents>;
};

export function useBoardCalendarWindow({
  boardId,
  window,
  search,
  liveKey,
  sources,
  hidden,
  dueCards,
}: {
  boardId: string;
  window: DateWindow | null;
  search: string;
  liveKey: number;
  sources: readonly CalendarSource[];
  hidden: ReadonlySet<string>;
  /** Whether the board has a "Cards · Due" calendar to read. */
  dueCards: boolean;
}): CalendarWindowData {
  const events = useServerBoardEvents(
    boardId,
    window ? { ...window, label: "" } : null,
    liveKey,
    search,
  );
  const { state, isLoadingMore, loadMoreError, loadMore } = events;
  // A busy window is read page by page to its end, so the grid is complete.
  useEffect(() => {
    if (
      state.status === "ready" &&
      state.data?.pagination.hasMore &&
      !isLoadingMore &&
      !loadMoreError
    )
      void loadMore();
  }, [isLoadingMore, loadMore, loadMoreError, state.data, state.status]);

  const visibleSources = sources.filter(
    (source) => !hidden.has(boardSourceCalendarId(source.id)),
  );
  const sourceReads = useQueries({
    queries: visibleSources.map((source) => ({
      ...sourceRecordsOptions(source, window ?? { start: "", end: "" }),
      enabled: window !== null,
    })),
  });
  const dueCalendar = boardDueCalendarId(boardId);
  const dueRead = useQuery({
    queryKey: boardCalendarKeys.dueCards(
      boardId,
      window ?? { start: "", end: "" },
    ),
    queryFn: () =>
      listDueBoardCards(boardId, {
        from: window?.start ?? "",
        to: window?.end ?? "",
      }),
    enabled: dueCards && window !== null && !hidden.has(dueCalendar),
  });

  const eventCalendar = boardEventsCalendarId(boardId);
  const eventsPage = state.data;
  // Derived on each render: a few hundred items at most per window.
  const items: CalendarItem[] = eventsPage
    ? occurrenceItems(eventsPage.items, eventCalendar)
    : [];
  visibleSources.forEach((source, index) => {
    const data = sourceReads[index]?.data;
    if (!data) return;
    items.push(
      ...recordItems(
        data.records,
        {
          id: source.id,
          moduleId: source.moduleId,
          dateFieldId: source.dateFieldId,
          fieldType: source.fieldType,
          titleFieldId: data.titleFieldId,
        },
        data.timezone,
        boardSourceCalendarId(source.id),
      ),
    );
  });
  if (dueRead.data) items.push(...dueCardItems(dueRead.data, dueCalendar));

  const statuses = new Map<string, CalendarReadStatus>();
  statuses.set(
    eventCalendar,
    state.error || loadMoreError
      ? "error"
      : state.status === "ready" && !state.data?.pagination.hasMore
        ? "ready"
        : "loading",
  );
  visibleSources.forEach((source, index) => {
    const read = sourceReads[index];
    statuses.set(
      boardSourceCalendarId(source.id),
      read.isError ? "error" : read.isSuccess ? "ready" : "loading",
    );
  });
  if (dueCards && !hidden.has(dueCalendar))
    statuses.set(
      dueCalendar,
      dueRead.isError ? "error" : dueRead.isSuccess ? "ready" : "loading",
    );

  return {
    items,
    nextOccurrence: eventsPage?.nextOccurrence ?? null,
    eventsReady: statuses.get(eventCalendar) === "ready",
    eventsError: state.error ?? loadMoreError,
    statuses,
    dueCards: dueRead.data ?? [],
    retry: (calendarId) => {
      if (calendarId === eventCalendar) {
        if (loadMoreError) void loadMore();
        else events.retry();
        return;
      }
      if (calendarId === dueCalendar) {
        void dueRead.refetch();
        return;
      }
      const index = visibleSources.findIndex(
        (source) => boardSourceCalendarId(source.id) === calendarId,
      );
      if (index >= 0) void sourceReads[index]?.refetch();
    },
    events,
  };
}
