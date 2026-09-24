"use client";

import { useMemo, useState } from "react";
import {
  daysInWindow,
  dateInTimezone,
  formatWindowDate,
  initialDateWindow,
  shiftDate,
  useWindowPage,
  validDateWindow,
  windowPageErrorMessage,
  WindowControls,
  WindowPageNavigation,
  type CalendarDateField,
  type LiveWindowBaseProps,
} from "./live-calendar";
import type { OpenViewWindowQueryRequest } from "../adapters/window-api";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

const PAGE_SIZE = 25;

type TimelineScope = "window" | "unscheduled";

function recordTitle(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return fallback;
}

function progressValue(
  value: unknown,
): { label: string; number: number } | null {
  if (typeof value === "number" && Number.isFinite(value))
    return { label: String(value), number: value };
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(value)
  )
    return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? { label: value, number: numeric } : null;
}

function intervalPosition(
  startValue: unknown,
  startField: CalendarDateField,
  endValue: unknown,
  endField: CalendarDateField,
  fromDate: string,
  toDate: string,
  timezone: string | null,
) {
  const startDay = dateInTimezone(startValue, startField.type, timezone);
  const endDay = dateInTimezone(endValue, endField.type, timezone);
  if (!startDay || !endDay || endDay < startDay) return null;

  const start = Date.parse(`${fromDate}T00:00:00.000Z`);
  const end = Date.parse(`${toDate}T00:00:00.000Z`);
  const taskStart = Date.parse(`${startDay}T00:00:00.000Z`);
  const taskEnd = Date.parse(`${endDay}T00:00:00.000Z`);
  const clippedStart = Math.max(start, taskStart);
  const clippedEnd = Math.min(end, taskEnd);
  if (clippedStart > clippedEnd) return null;
  const days = daysInWindow(fromDate, toDate);
  const left = (clippedStart - start) / 86_400_000;
  const width = (clippedEnd - clippedStart) / 86_400_000 + 1;
  return {
    left: (left / days) * 100,
    width: (width / days) * 100,
    startDay,
    endDay,
  };
}

export function LiveTimeline({
  moduleId,
  definition,
  dateRange,
  startField,
  endField,
  deadlineField,
  progressField,
  titleField,
  detailFields,
  onOpenRecord,
}: LiveWindowBaseProps & {
  startField: CalendarDateField;
  endField: CalendarDateField;
  deadlineField: CalendarDateField | undefined;
  progressField: OpenViewDataSourceField | undefined;
  titleField: OpenViewDataSourceField | undefined;
  detailFields: readonly OpenViewDataSourceField[];
}) {
  const [windowDates, setWindowDates] = useState(() =>
    initialDateWindow(dateRange),
  );
  const [scope, setScope] = useState<TimelineScope>("window");
  const [retry, setRetry] = useState(0);
  const [pagePosition, setPagePosition] = useState({ key: "", offset: 0 });
  const baseKey = JSON.stringify([
    moduleId,
    definition,
    startField.id,
    endField.id,
    deadlineField?.id,
    progressField?.id,
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
    const startFieldReference = {
      fieldId: startField.id,
      expectedType: startField.type,
    };
    const endFieldReference = {
      fieldId: endField.id,
      expectedType: endField.type,
    };
    if (scope === "window")
      return {
        moduleId,
        definition,
        mode: "timeline",
        scope: "window",
        startField: startFieldReference,
        endField: endFieldReference,
        fromDate: windowDates.start,
        toDate: windowDates.end,
        limit: PAGE_SIZE,
        offset,
      };
    return {
      moduleId,
      definition,
      mode: "timeline",
      scope: "unscheduled",
      startField: startFieldReference,
      endField: endFieldReference,
      limit: PAGE_SIZE,
      offset,
    };
  }, [
    definition,
    endField.id,
    endField.type,
    moduleId,
    offset,
    scope,
    startField.id,
    startField.type,
    windowDates.end,
    windowDates.start,
  ]);
  const { result, loading, error } = useWindowPage(request, retry);
  const timezone = result?.timezone ?? null;
  const changeScope = (next: TimelineScope) => {
    setScope(next);
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
      aria-label="Timeline records"
    >
      <header className="border-b px-4 py-3">
        <h2 className="font-medium">
          Timeline · {startField.name} through {endField.name}
        </h2>
        <p className="text-muted-foreground text-sm">
          Complete selected intervals are clipped to the visible window. Dates
          follow the workspace calendar.
          {timezone ? ` Workspace timezone: ${timezone}` : ""}
        </p>
      </header>
      <WindowControls
        startDate={windowDates.start}
        endDate={windowDates.end}
        scope={scope}
        unscheduledScope="unscheduled"
        windowLabel="Scheduled intervals"
        undatedLabel="Unscheduled records"
        onStartDateChange={(start) => {
          setWindowDates((current) => ({ ...current, start }));
          setPagePosition({ key: "", offset: 0 });
        }}
        onEndDateChange={(end) => {
          setWindowDates((current) => ({ ...current, end }));
          setPagePosition({ key: "", offset: 0 });
        }}
        onScopeChange={(next) => {
          if (next === "window" || next === "unscheduled") changeScope(next);
        }}
        onShiftWindow={shiftWindow}
        timezone={timezone}
      />
      {loading && result ? (
        <p
          role="status"
          className="text-muted-foreground border-b px-4 py-2 text-sm"
        >
          Updating timeline records.{" "}
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
            Retry timeline records
          </Button>
        </Alert>
      ) : null}
      {request && loading && !result ? (
        <p
          role="status"
          className="text-muted-foreground px-4 py-12 text-center"
        >
          Loading timeline records…
        </p>
      ) : null}
      {request && error && !result ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Timeline records could not be loaded</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!request ? (
        <p role="note" className="text-muted-foreground px-4 py-8 text-sm">
          Select a valid window of up to 366 days to load Timeline records.
        </p>
      ) : null}
      {result && result.items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {scope === "window"
                ? "No scheduled intervals in this window"
                : "No unscheduled records"}
            </EmptyTitle>
            <EmptyDescription>
              {scope === "window"
                ? "Try another date window or check the separate unscheduled records."
                : "Records without a complete interval appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {result && result.items.length > 0 ? (
        <ul aria-label="Timeline intervals" className="divide-y">
          {result.items.map((row) => {
            const title = titleField
              ? recordTitle(
                  row.data[titleField.id],
                  `Record ${row.id.slice(0, 8)}`,
                )
              : `Record ${row.id.slice(0, 8)}`;
            const startValue = row.data[startField.id];
            const endValue = row.data[endField.id];
            const position =
              scope === "window"
                ? intervalPosition(
                    startValue,
                    startField,
                    endValue,
                    endField,
                    windowDates.start,
                    windowDates.end,
                    timezone,
                  )
                : null;
            const progress = progressField
              ? progressValue(row.data[progressField.id])
              : null;
            const numericProgress = progress?.number ?? null;
            return (
              <li key={row.id} className="min-w-0 p-4">
                <article className="grid min-w-0 gap-3 md:grid-cols-[minmax(12rem,1fr)_minmax(16rem,2fr)]">
                  <div className="min-w-0">
                    <h3 className="font-medium">
                      <button
                        type="button"
                        className="text-primary focus-visible:ring-ring min-h-11 min-w-11 text-left underline-offset-4 hover:underline focus-visible:ring-2"
                        aria-label={`Open record: ${title}`}
                        onClick={() => onOpenRecord(row.id)}
                      >
                        {title}
                      </button>
                    </h3>
                    {scope === "window" ? (
                      <p className="text-muted-foreground text-sm">
                        {formatWindowDate(
                          startValue,
                          startField.type,
                          timezone,
                        )}
                        {" – "}
                        {formatWindowDate(endValue, endField.type, timezone)}
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        This record has no complete start/end interval.
                      </p>
                    )}
                    {deadlineField && row.data[deadlineField.id] != null ? (
                      <p className="text-muted-foreground text-sm">
                        Deadline:{" "}
                        {formatWindowDate(
                          row.data[deadlineField.id],
                          deadlineField.type,
                          timezone,
                        )}
                      </p>
                    ) : null}
                    {progressField && numericProgress !== null ? (
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-muted-foreground text-sm">
                          Progress: {progress?.label}%
                        </span>
                        <div
                          role="progressbar"
                          aria-label={`${title} progress`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.max(
                            0,
                            Math.min(100, numericProgress),
                          )}
                          className="bg-muted h-2 w-24 overflow-hidden rounded-full"
                        >
                          <div
                            className="bg-primary h-full rounded-full"
                            style={{
                              width: `${Math.max(0, Math.min(100, numericProgress))}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                    {detailFields.map((field) => (
                      <p
                        key={field.id}
                        className="text-muted-foreground text-sm"
                      >
                        {field.name}: {recordTitle(row.data[field.id], "—")}
                      </p>
                    ))}
                  </div>
                  {scope === "window" ? (
                    <div className="flex min-w-0 flex-col justify-center gap-2">
                      <div className="text-muted-foreground flex justify-between text-xs">
                        <span>{windowDates.start}</span>
                        <span>{windowDates.end}</span>
                      </div>
                      <div
                        role="img"
                        aria-label={
                          position
                            ? `${title} interval, ${formatWindowDate(startValue, startField.type, timezone)} to ${formatWindowDate(endValue, endField.type, timezone)}`
                            : `${title} interval dates unavailable`
                        }
                        className="bg-muted relative h-3 overflow-hidden rounded-full"
                      >
                        {position ? (
                          <span
                            aria-hidden="true"
                            className="bg-primary absolute inset-y-0 rounded-full"
                            style={{
                              left: `${position.left}%`,
                              width: `${position.width}%`,
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}
      {result ? (
        <WindowPageNavigation
          result={result}
          loading={loading}
          nextLabel="Next timeline page"
          onOffsetChange={(nextOffset) =>
            setPagePosition({ key: baseKey, offset: nextOffset })
          }
        />
      ) : null}
    </section>
  );
}
