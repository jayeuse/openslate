"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { queryOpenViewWindowRecords } from "../adapters/window-api";
import type {
  OpenViewWindowQueryRequest,
  OpenViewWindowResult,
} from "../adapters/window-api";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
  OpenViewRecord,
} from "../adapters/views-api";
import { openViewRecordFieldValue } from "../domain/record-display";
import type { RecordInspectionPage } from "./live-record-inspector";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  workspaceCalendarQueryOptions,
  type WorkspaceCalendarSettings,
} from "../../manage/adapters/workspace-api";
import { subscribeOpenViewInvalidations } from "../adapters/invalidation-events";

const WINDOW_PAGE_SIZE = 25;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export type CalendarDateField = OpenViewDataSourceField & {
  type: "date" | "datetime";
};

export type CalendarWindowScope = "window" | "undated";

export type LiveWindowBaseProps = {
  moduleId: string;
  definition: OpenViewQueryDefinition;
  dateRange: "week" | "month" | "quarter" | "year";
  refreshKey?: number;
  onOpenRecord: (recordId: string, page: RecordInspectionPage) => void;
};

export function isCalendarDateField(
  field: OpenViewDataSourceField,
): field is CalendarDateField {
  return field.type === "date" || field.type === "datetime";
}

function dateString(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function shiftDate(value: string, offset: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return dateString(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

export function daysInWindow(start: string, end: string): number {
  return (
    (Date.parse(`${end}T00:00:00.000Z`) -
      Date.parse(`${start}T00:00:00.000Z`)) /
      DAY_MILLISECONDS +
    1
  );
}

export function validDateWindow(start: string, end: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return false;
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  return (
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    daysInWindow(start, end) >= 1 &&
    daysInWindow(start, end) <= 366
  );
}

function localToday(): string {
  const today = new Date();
  return dateString(today.getFullYear(), today.getMonth() + 1, today.getDate());
}

export function initialDateWindow(
  range: LiveWindowBaseProps["dateRange"],
  weekStart: WorkspaceCalendarSettings["week_start"] = "monday",
): {
  start: string;
  end: string;
} {
  const today = localToday();
  const date = new Date(`${today}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (range === "week") {
    const weekdayOffset =
      (date.getUTCDay() + (weekStart === "monday" ? 6 : 0)) % 7;
    const start = shiftDate(today, -weekdayOffset);
    return { start, end: shiftDate(start, 6) };
  }
  if (range === "quarter") {
    const quarterStart = Math.floor(month / 3) * 3;
    const start = dateString(year, quarterStart + 1, 1);
    const last = new Date(Date.UTC(year, quarterStart + 3, 0));
    return {
      start,
      end: dateString(
        last.getUTCFullYear(),
        last.getUTCMonth() + 1,
        last.getUTCDate(),
      ),
    };
  }
  if (range === "year") {
    return {
      start: dateString(year, 1, 1),
      end: dateString(year, 12, 31),
    };
  }
  const start = dateString(year, month + 1, 1);
  const last = new Date(Date.UTC(year, month + 1, 0));
  return {
    start,
    end: dateString(
      last.getUTCFullYear(),
      last.getUTCMonth() + 1,
      last.getUTCDate(),
    ),
  };
}

export function dateInTimezone(
  value: unknown,
  expectedType: "date" | "datetime",
  timezone: string | null,
): string | null {
  if (typeof value !== "string") return null;
  if (expectedType === "date")
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  const instant = recordDateTimeInstant(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function formatWindowDate(
  value: unknown,
  expectedType: "date" | "datetime",
  timezone: string | null,
): string {
  if (typeof value !== "string") return "—";
  const day = dateInTimezone(value, expectedType, timezone);
  if (!day) return "Date unavailable";
  const date = new Date(`${day}T00:00:00.000Z`);
  const dayLabel = new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    dateStyle: "medium",
  }).format(date);
  if (expectedType === "date") return dayLabel;
  const instant = recordDateTimeInstant(value);
  if (Number.isNaN(instant.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en", {
    timeZone: timezone ?? "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

function recordDateTimeInstant(value: string): Date {
  const hasOffset = /(?:z|[+-]\d{2}:\d{2})$/i.test(value);
  return new Date(hasOffset ? value : `${value}Z`);
}

function semanticRequestKey(request: OpenViewWindowQueryRequest): string {
  return JSON.stringify({ ...request, offset: undefined });
}

export function windowPageErrorMessage(
  error: string,
  result: OpenViewWindowResult | null,
  requestedOffset: number,
): string {
  if (!result || result.pagination.offset === requestedOffset) return error;
  const { offset, count, limit } = result.pagination;
  const first = offset + 1;
  const last = offset + count;
  const requestedPage = Math.floor(requestedOffset / limit) + 1;
  return `${error} Requested page ${requestedPage}; showing previous page ${first}–${last}.`;
}

export function useWindowPage(
  request: OpenViewWindowQueryRequest | null,
  retry: number,
) {
  const [state, setState] = useState<{
    key: string;
    result: OpenViewWindowResult | null;
    loading: boolean;
    error: string;
  } | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!request) {
      setState(null);
      return;
    }
    const sequence = ++requestSequence.current;
    const key = semanticRequestKey(request);
    setState((previous) => ({
      key,
      result: previous?.key === key ? previous.result : null,
      loading: true,
      error: "",
    }));
    void queryOpenViewWindowRecords(request)
      .then((result) => {
        if (sequence !== requestSequence.current) return;
        setState({
          key,
          result,
          loading: false,
          error: "",
        });
      })
      .catch((caught: unknown) => {
        if (sequence !== requestSequence.current) return;
        const denied =
          caught instanceof ApiError && [401, 403].includes(caught.status);
        setState((previous) => ({
          key,
          result: denied
            ? null
            : previous?.key === key
              ? previous.result
              : null,
          loading: false,
          error: denied
            ? "You no longer have access to these records. Sign in or ask for access, then retry."
            : "Window records could not be loaded.",
        }));
      });
    return () => {
      requestSequence.current += 1;
    };
  }, [request, retry]);

  const current =
    request && state?.key === semanticRequestKey(request) ? state : null;
  return {
    result: current?.result ?? null,
    loading: Boolean(current?.loading),
    error: current?.error ?? "",
  };
}

export function WindowControls({
  startDate,
  endDate,
  scope,
  unscheduledScope,
  windowLabel,
  undatedLabel,
  onStartDateChange,
  onEndDateChange,
  onScopeChange,
  onShiftWindow,
  timezone,
}: {
  startDate: string;
  endDate: string;
  scope: "window" | "undated" | "unscheduled";
  unscheduledScope: "undated" | "unscheduled";
  windowLabel: string;
  undatedLabel: string;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
  onScopeChange: (scope: "window" | "undated" | "unscheduled") => void;
  onShiftWindow: (direction: -1 | 1) => void;
  timezone: string | null;
}) {
  const labels = [
    { value: "window" as const, label: windowLabel },
    {
      value: unscheduledScope,
      label: undatedLabel,
    },
  ];
  const windowValid = validDateWindow(startDate, endDate);
  return (
    <section
      className="flex flex-col gap-3 border-b p-4"
      aria-label="Date window controls"
    >
      <div className="flex flex-wrap gap-2">
        {labels.map(({ value, label }) => (
          <Button
            key={value}
            type="button"
            variant={scope === value ? "default" : "outline"}
            className="min-h-11"
            aria-pressed={scope === value}
            onClick={() => onScopeChange(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {scope === "window" ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span>Window starts</span>
            <Input
              aria-label="Window starts"
              className="min-h-11 w-44"
              type="date"
              value={startDate}
              onChange={(event) => onStartDateChange(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>Window ends</span>
            <Input
              aria-label="Window ends"
              className="min-h-11 w-44"
              type="date"
              value={endDate}
              onChange={(event) => onEndDateChange(event.target.value)}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!windowValid}
            onClick={() => onShiftWindow(-1)}
          >
            Previous window
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!windowValid}
            onClick={() => onShiftWindow(1)}
          >
            Next window
          </Button>
          <p className="text-muted-foreground basis-full text-sm">
            Dates are interpreted in the workspace calendar.
            {timezone ? ` Workspace timezone: ${timezone}` : ""}
          </p>
          {!windowValid ? (
            <p role="alert" className="text-destructive basis-full text-sm">
              Choose an ordered date window containing no more than 366 days.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Records without a scheduled date are queried separately from the
          selected window.
        </p>
      )}
    </section>
  );
}

export function WindowPageNavigation({
  result,
  loading,
  onOffsetChange,
}: {
  result: OpenViewWindowResult;
  loading: boolean;
  onOffsetChange: (offset: number) => void;
}) {
  const { pagination } = result;
  const first = pagination.total === 0 ? 0 : pagination.offset + 1;
  const last = pagination.offset + pagination.count;
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
      <p aria-live="polite" className="text-muted-foreground text-sm">
        Showing {first}–{last} of {pagination.total} matching records
      </p>
      {!loading ? (
        <PaginationControls
          ariaLabel="Date window record pages"
          className="w-auto justify-end"
          pageCount={Math.max(
            1,
            Math.ceil(pagination.total / pagination.limit),
          )}
          pageIndex={Math.floor(pagination.offset / pagination.limit)}
          onPageIndexChange={(nextPage) =>
            onOffsetChange(nextPage * pagination.limit)
          }
        />
      ) : null}
    </footer>
  );
}

function recordText(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "Untitled record";
}

type LiveCalendarProps = LiveWindowBaseProps & {
  scale?: "month" | "list" | null;
  dateField: CalendarDateField;
  titleField: OpenViewDataSourceField | undefined;
  detailFields: readonly OpenViewDataSourceField[];
};

export function LiveCalendar(props: LiveCalendarProps) {
  const workspace = useQuery(workspaceCalendarQueryOptions());
  const client = useQueryClient();
  useEffect(() => {
    const queryKey = workspaceCalendarQueryOptions().queryKey;
    const refreshSettings = () => {
      const cold = client
        .getQueryCache()
        .findAll({ queryKey, fetchStatus: "fetching" })
        .filter((query) => query.state.data === undefined);
      void Promise.all(
        cold.map((query) => query.cancel({ revert: true })),
      ).then(() => client.invalidateQueries({ queryKey }));
    };
    return subscribeOpenViewInvalidations((event) => {
      if (event.type === "resync" || event.entity === "workspace_profiles")
        refreshSettings();
    }, refreshSettings);
  }, [client]);

  const retrySettings = () => {
    void workspace.refetch();
  };
  if (!workspace.data)
    return (
      <Card
        className="min-w-0 self-auto overflow-hidden"
        aria-label={props.scale === "list" ? "Calendar list view" : "Calendar"}
      >
        <header data-slot="card-header" className="border-b px-4 py-3">
          <h2 data-slot="section-title" className="font-medium">
            Calendar · {props.dateField.name}
          </h2>
          <p className="text-muted-foreground text-sm">
            Live records grouped by their selected schedule date.
          </p>
        </header>
        <LoadingRegion
          loading={workspace.isPending}
          label="Loading calendar settings"
          skeleton={
            <div className="space-y-4 p-4">
              <div className="flex flex-wrap gap-3">
                <Skeleton className="h-11 w-44" />
                <Skeleton className="h-11 w-44" />
              </div>
              <Skeleton className="h-72 w-full" />
            </div>
          }
        >
          <Alert
            role="alert"
            variant="warning"
            className="m-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p>Organization calendar settings could not be loaded.</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={retrySettings}
            >
              Retry calendar settings
            </Button>
          </Alert>
        </LoadingRegion>
      </Card>
    );
  return (
    <ResolvedLiveCalendar
      {...props}
      weekStart={workspace.data.week_start}
      settingsError={workspace.isError}
      onRetrySettings={retrySettings}
    />
  );
}

function ResolvedLiveCalendar({
  moduleId,
  definition,
  dateRange,
  refreshKey = 0,
  scale: savedScale,
  dateField,
  titleField,
  detailFields,
  onOpenRecord,
  weekStart,
  settingsError,
  onRetrySettings,
}: LiveCalendarProps & {
  weekStart: WorkspaceCalendarSettings["week_start"];
  settingsError: boolean;
  onRetrySettings: () => void;
}) {
  const scale = savedScale ?? "month";
  const [windowDates, setWindowDates] = useState(() =>
    initialDateWindow(dateRange, weekStart),
  );
  const manualWindow = useRef(false);
  const previousRange = useRef(dateRange);
  const [scope, setScope] = useState<CalendarWindowScope>("window");
  const [retry, setRetry] = useState(0);
  const [pagePosition, setPagePosition] = useState({ key: "", offset: 0 });
  const baseKey = JSON.stringify([
    moduleId,
    definition,
    dateField.id,
    dateField.type,
    scope,
    ...(scope === "window" ? [windowDates.start, windowDates.end] : []),
  ]);
  const offset = pagePosition.key === baseKey ? pagePosition.offset : 0;
  const request = useMemo<OpenViewWindowQueryRequest | null>(() => {
    if (
      !moduleId ||
      (scope === "window" &&
        !validDateWindow(windowDates.start, windowDates.end))
    )
      return null;
    const dateFieldReference = {
      fieldId: dateField.id,
      expectedType: dateField.type,
    };
    if (scope === "window")
      return {
        moduleId,
        definition,
        mode: "calendar",
        scope: "window",
        dateField: dateFieldReference,
        fromDate: windowDates.start,
        toDate: windowDates.end,
        limit: WINDOW_PAGE_SIZE,
        offset,
      };
    return {
      moduleId,
      definition,
      mode: "calendar",
      scope: "undated",
      dateField: dateFieldReference,
      limit: WINDOW_PAGE_SIZE,
      offset,
    };
  }, [
    dateField,
    definition,
    moduleId,
    offset,
    scope,
    windowDates.end,
    windowDates.start,
  ]);
  const { result, loading, error } = useWindowPage(request, retry + refreshKey);
  useEffect(() => {
    if (previousRange.current !== dateRange) manualWindow.current = false;
    previousRange.current = dateRange;
    if (!manualWindow.current) {
      setWindowDates(initialDateWindow(dateRange, weekStart));
      setPagePosition({ key: "", offset: 0 });
    }
  }, [dateRange, weekStart]);
  const timezone = result?.timezone ?? null;
  const dateFieldTitle = dateField.name;
  const shownRows = result?.items ?? [];
  const groupByDay = new Map<string, OpenViewRecord[]>();
  shownRows.forEach((row) => {
    const day =
      scope === "window"
        ? (dateInTimezone(row.data[dateField.id], dateField.type, timezone) ??
          "Date unavailable")
        : "Undated";
    groupByDay.set(day, [...(groupByDay.get(day) ?? []), row]);
  });
  const groups = [...groupByDay.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const monthKeys: string[] = [];
  if (
    scope === "window" &&
    validDateWindow(windowDates.start, windowDates.end)
  ) {
    const monthStart = new Date(
      `${windowDates.start.slice(0, 7)}-01T00:00:00.000Z`,
    );
    const monthEnd = new Date(
      `${windowDates.end.slice(0, 7)}-01T00:00:00.000Z`,
    );
    for (
      const cursor = new Date(monthStart);
      cursor <= monthEnd;
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    ) {
      monthKeys.push(
        `${cursor.getUTCFullYear().toString().padStart(4, "0")}-${(cursor.getUTCMonth() + 1).toString().padStart(2, "0")}`,
      );
    }
  }
  const scopeChange = (nextScope: CalendarWindowScope) => {
    setScope(nextScope);
    setPagePosition({ key: "", offset: 0 });
  };
  const shiftWindow = (direction: -1 | 1) => {
    manualWindow.current = true;
    const span = daysInWindow(windowDates.start, windowDates.end);
    setWindowDates((current) => ({
      start: shiftDate(current.start, direction * span),
      end: shiftDate(current.end, direction * span),
    }));
    setPagePosition({ key: "", offset: 0 });
  };
  const monthLayout = scope === "window" && scale === "month";

  return (
    <Card
      className="min-w-0 self-auto overflow-hidden"
      aria-label={scale === "list" ? "Calendar list view" : "Calendar"}
    >
      <header data-slot="card-header" className="border-b px-4 py-3">
        <h2 data-slot="section-title" className="font-medium">
          Calendar · {dateFieldTitle}
        </h2>
        <p className="text-muted-foreground text-sm">
          Live records grouped by their selected schedule date.
        </p>
      </header>
      {settingsError ? (
        <Alert
          role="alert"
          variant="warning"
          className="m-4 flex flex-wrap items-center justify-between gap-3"
        >
          <p>
            Organization calendar settings could not be refreshed. The last
            loaded settings are still in use.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onRetrySettings}
          >
            Retry calendar settings
          </Button>
        </Alert>
      ) : null}
      <WindowControls
        startDate={windowDates.start}
        endDate={windowDates.end}
        scope={scope}
        unscheduledScope="undated"
        windowLabel="Scheduled window"
        undatedLabel="Undated records"
        onStartDateChange={(start) => {
          manualWindow.current = true;
          setWindowDates((current) => ({ ...current, start }));
          setPagePosition({ key: "", offset: 0 });
        }}
        onEndDateChange={(end) => {
          manualWindow.current = true;
          setWindowDates((current) => ({ ...current, end }));
          setPagePosition({ key: "", offset: 0 });
        }}
        onScopeChange={(nextScope) => {
          if (nextScope === "window" || nextScope === "undated")
            scopeChange(nextScope);
        }}
        onShiftWindow={shiftWindow}
        timezone={timezone}
      />
      {monthLayout ? (
        <div className="hidden min-w-0 flex-col gap-4 p-4 lg:flex">
          {result && shownRows.length === 0 ? (
            <p role="status" className="text-muted-foreground text-sm">
              No scheduled records in this date window.
            </p>
          ) : null}
          {monthKeys.map((monthKey) => {
            const [yearValue, monthValue] = monthKey.split("-").map(Number);
            const firstDay = new Date(Date.UTC(yearValue, monthValue - 1, 1));
            const dayCount = new Date(
              Date.UTC(yearValue, monthValue, 0),
            ).getUTCDate();
            const leadingDays =
              (firstDay.getUTCDay() + (weekStart === "monday" ? 6 : 0)) % 7;
            const weekdays =
              weekStart === "monday"
                ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            const monthLabel = new Intl.DateTimeFormat("en", {
              timeZone: "UTC",
              month: "long",
              year: "numeric",
            }).format(firstDay);
            const cells: (number | null)[] = [
              ...Array.from({ length: leadingDays }, () => null),
              ...Array.from({ length: dayCount }, (_, index) => index + 1),
            ];
            return (
              <section
                key={monthKey}
                className="overflow-hidden rounded-md border"
              >
                <h3 className="bg-muted/40 px-3 py-2 font-medium">
                  {monthLabel}
                </h3>
                <div
                  className="overflow-x-auto"
                  role="region"
                  aria-label={`${monthLabel} calendar`}
                  tabIndex={0}
                >
                  <div className="min-w-[46rem]">
                    <div className="bg-muted/25 grid grid-cols-7 border-b">
                      {weekdays.map((day) => (
                        <div
                          key={day}
                          className="text-muted-foreground px-2 py-2 text-center text-xs font-medium"
                        >
                          {day}
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7">
                      {cells.map((day, index) => {
                        if (day === null) {
                          return (
                            <div
                              key={`blank-${index}`}
                              className="bg-muted/10 min-h-24 border-r border-b"
                              aria-hidden="true"
                            />
                          );
                        }
                        const date = `${monthKey}-${String(day).padStart(2, "0")}`;
                        const inWindow =
                          date >= windowDates.start && date <= windowDates.end;
                        const rows = groupByDay.get(date) ?? [];
                        return (
                          <div
                            key={date}
                            aria-disabled={!inWindow}
                            className={`min-h-24 border-r border-b p-1.5 ${inWindow ? "" : "bg-muted/10 text-muted-foreground/60"}`}
                            title={
                              inWindow
                                ? undefined
                                : "Outside the selected date range"
                            }
                          >
                            <p className="text-muted-foreground mb-1 px-1 text-xs tabular-nums">
                              {day}
                            </p>
                            {rows[0] ? (
                              <h4 className="text-muted-foreground mb-1 px-1 text-xs font-medium">
                                {formatWindowDate(
                                  rows[0].data[dateField.id],
                                  dateField.type,
                                  timezone,
                                )}
                              </h4>
                            ) : null}
                            <ul className="flex max-h-44 min-w-0 flex-col gap-1 overflow-y-auto">
                              {rows.map((row) => {
                                const title = titleField
                                  ? recordText(
                                      openViewRecordFieldValue(row, titleField),
                                    )
                                  : `Record ${row.id.slice(0, 8)}`;
                                return (
                                  <li key={row.id}>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="h-auto min-h-11 w-full flex-col items-start justify-start gap-0 border px-2 py-1.5 text-left text-xs whitespace-normal"
                                      aria-label={`Open record: ${title}`}
                                      onClick={() => {
                                        if (!request || !result) return;
                                        onOpenRecord(row.id, {
                                          rows: result.items,
                                          offset: result.pagination.offset,
                                          total: result.pagination.total,
                                          source: {
                                            kind: "window",
                                            request,
                                            returnToPage: (nextOffset) =>
                                              setPagePosition({
                                                key: baseKey,
                                                offset: nextOffset,
                                              }),
                                          },
                                        });
                                      }}
                                    >
                                      <span className="line-clamp-2 break-words">
                                        {title}
                                      </span>
                                      {detailFields.length ? (
                                        <span className="text-muted-foreground mt-1 block text-left text-xs">
                                          {detailFields
                                            .slice(0, 2)
                                            .map((field) =>
                                              recordText(
                                                openViewRecordFieldValue(
                                                  row,
                                                  field,
                                                ),
                                              ),
                                            )
                                            .join(" · ")}
                                        </span>
                                      ) : null}
                                      <span className="text-muted-foreground mt-1 block text-left text-xs">
                                        {formatWindowDate(
                                          row.data[dateField.id],
                                          dateField.type,
                                          timezone,
                                        )}
                                      </span>
                                    </Button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
      {loading && result ? (
        <p
          role="status"
          className="text-muted-foreground border-b px-4 py-2 text-sm"
        >
          Updating calendar records.{" "}
          {result.pagination.offset === offset
            ? "The last loaded page remains visible."
            : `Showing previous page ${result.pagination.offset + 1}–${result.pagination.offset + result.pagination.count}.`}
        </p>
      ) : null}
      {error ? (
        <Alert
          role="alert"
          variant="warning"
          className="m-4 flex flex-wrap items-center justify-between gap-3"
        >
          <p>{windowPageErrorMessage(error, result, offset)}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry window records
          </Button>
        </Alert>
      ) : null}
      {request && loading && !result ? (
        <p
          role="status"
          className="text-muted-foreground px-4 py-12 text-center"
        >
          Loading calendar records…
        </p>
      ) : null}
      {request && error && !result ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Calendar records could not be loaded</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!request ? (
        <p role="note" className="text-muted-foreground px-4 py-8 text-sm">
          Select a valid window of up to 366 days to load Calendar records.
        </p>
      ) : null}
      {result && shownRows.length === 0 ? (
        <Empty className={monthLayout ? "lg:hidden" : undefined}>
          <EmptyHeader>
            <EmptyTitle>
              {scope === "window"
                ? "No scheduled records in this window"
                : "No undated records"}
            </EmptyTitle>
            <EmptyDescription>
              {scope === "window"
                ? "Try another date window or check the separate undated records."
                : "Records without a schedule date appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {result && shownRows.length > 0 ? (
        <div className={monthLayout ? "divide-y lg:hidden" : "divide-y"}>
          {groups.map(([day, rows]) => (
            <section
              key={day}
              className="min-w-0"
              aria-label={`${day} records`}
            >
              <h3 className="bg-muted/50 px-4 py-2 font-medium">
                {day === "Undated"
                  ? day
                  : day === "Date unavailable"
                    ? day
                    : new Intl.DateTimeFormat("en", {
                        timeZone: "UTC",
                        dateStyle: "medium",
                      }).format(new Date(`${day}T00:00:00.000Z`))}
              </h3>
              <ul className="divide-y">
                {rows.map((row) => {
                  const title = titleField
                    ? recordText(openViewRecordFieldValue(row, titleField))
                    : `Record ${row.id.slice(0, 8)}`;
                  return (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="text-primary focus-visible:ring-ring min-h-11 min-w-11 text-left font-medium underline-offset-4 hover:underline focus-visible:ring-2"
                          aria-label={`Open record: ${title}`}
                          onClick={() => {
                            if (!request || !result) return;
                            onOpenRecord(row.id, {
                              rows: result.items,
                              offset: result.pagination.offset,
                              total: result.pagination.total,
                              source: {
                                kind: "window",
                                request,
                                returnToPage: (nextOffset) =>
                                  setPagePosition({
                                    key: baseKey,
                                    offset: nextOffset,
                                  }),
                              },
                            });
                          }}
                        >
                          {title}
                        </button>
                        {detailFields.map((field) => (
                          <p
                            key={field.id}
                            className="text-muted-foreground text-sm"
                          >
                            {field.name}:{" "}
                            {recordText(openViewRecordFieldValue(row, field))}
                          </p>
                        ))}
                      </div>
                      {scope === "window" ? (
                        <time
                          className="text-muted-foreground text-sm"
                          dateTime={String(row.data[dateField.id] ?? "")}
                        >
                          {formatWindowDate(
                            row.data[dateField.id],
                            dateField.type,
                            timezone,
                          )}
                        </time>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
      {result ? (
        <WindowPageNavigation
          result={result}
          loading={loading}
          onOffsetChange={(nextOffset) =>
            setPagePosition({ key: baseKey, offset: nextOffset })
          }
        />
      ) : null}
    </Card>
  );
}
