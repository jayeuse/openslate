"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";

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
  onOpenRecord: (recordId: string) => void;
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

export function initialDateWindow(range: LiveWindowBaseProps["dateRange"]): {
  start: string;
  end: string;
} {
  const today = localToday();
  const date = new Date(`${today}T00:00:00.000Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (range === "week") {
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    const start = shiftDate(today, -mondayOffset);
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
      .catch(() => {
        if (sequence !== requestSequence.current) return;
        setState((previous) => ({
          key,
          result: previous?.key === key ? previous.result : null,
          loading: false,
          error: "Window records could not be loaded.",
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
  nextLabel = "Next window page",
}: {
  result: OpenViewWindowResult;
  loading: boolean;
  onOffsetChange: (offset: number) => void;
  nextLabel?: string;
}) {
  const { pagination } = result;
  const first = pagination.total === 0 ? 0 : pagination.offset + 1;
  const last = pagination.offset + pagination.count;
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
      <p aria-live="polite" className="text-muted-foreground text-sm">
        Showing {first}–{last} of {pagination.total} matching records
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={pagination.offset === 0 || loading}
          onClick={() =>
            onOffsetChange(Math.max(0, pagination.offset - pagination.limit))
          }
        >
          Previous window page
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!pagination.hasMore || loading}
          onClick={() => onOffsetChange(pagination.offset + pagination.limit)}
        >
          {nextLabel}
        </Button>
      </div>
    </footer>
  );
}

function recordText(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "Untitled record";
}

export function LiveCalendar({
  moduleId,
  definition,
  dateRange,
  dateField,
  titleField,
  detailFields,
  onOpenRecord,
}: LiveWindowBaseProps & {
  dateField: CalendarDateField;
  titleField: OpenViewDataSourceField | undefined;
  detailFields: readonly OpenViewDataSourceField[];
}) {
  const [windowDates, setWindowDates] = useState(() =>
    initialDateWindow(dateRange),
  );
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
  const { result, loading, error } = useWindowPage(request, retry);
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
  const scopeChange = (nextScope: CalendarWindowScope) => {
    setScope(nextScope);
    setPagePosition({ key: "", offset: 0 });
  };
  const shiftWindow = (direction: -1 | 1) => {
    const span = daysInWindow(windowDates.start, windowDates.end);
    setWindowDates((current) => ({
      start: shiftDate(current.start, direction * span),
      end: shiftDate(current.end, direction * span),
    }));
    setPagePosition({ key: "", offset: 0 });
  };

  return (
    <section
      className="bg-card min-w-0 overflow-hidden rounded-[var(--radius)] border"
      aria-label="Calendar records"
    >
      <header className="border-b px-4 py-3">
        <h2 className="font-medium">Calendar · {dateFieldTitle}</h2>
        <p className="text-muted-foreground text-sm">
          Live records grouped by their selected schedule date.
        </p>
      </header>
      <WindowControls
        startDate={windowDates.start}
        endDate={windowDates.end}
        scope={scope}
        unscheduledScope="undated"
        windowLabel="Scheduled window"
        undatedLabel="Undated records"
        onStartDateChange={(start) => {
          setWindowDates((current) => ({ ...current, start }));
          setPagePosition({ key: "", offset: 0 });
        }}
        onEndDateChange={(end) => {
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
        <Empty>
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
        <div className="divide-y">
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
                    ? recordText(row.data[titleField.id])
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
                          onClick={() => onOpenRecord(row.id)}
                        >
                          {title}
                        </button>
                        {detailFields.map((field) => (
                          <p
                            key={field.id}
                            className="text-muted-foreground text-sm"
                          >
                            {field.name}: {recordText(row.data[field.id])}
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
    </section>
  );
}
