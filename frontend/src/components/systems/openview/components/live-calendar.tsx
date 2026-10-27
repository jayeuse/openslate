"use client";
import { RecordPersonCard } from "./live-record-cards";
import {
  useDisplayRegion,
  useDisplayWeekStart,
} from "@/components/use-display-region";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import {
  formatWorkspaceDate,
  formatWorkspaceDateTime,
  datetimeOffsets,
  type WorkspaceRegion,
} from "@/lib/date-time";
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
import { formatOpenViewFieldValue } from "./live-record-cards";
import type { RecordInspectionPage } from "@/components/systems/shared/components/record-sheet";
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
import type { WorkspaceCalendarSettings } from "../../manage/adapters/workspace-api";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Select } from "@/components/ui/select";
import {
  effectiveMoveRecord,
  moveDateValue,
  moveDayDifference,
  recordMoveDay,
  recordMoveLocal,
  shiftMoveDay,
  validMoveInterval,
  type DateMoveProps,
  type PendingRecordMove,
} from "../domain/record-moves";

const WINDOW_PAGE_SIZE = 25;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export type CalendarDateField = OpenViewDataSourceField & {
  type: "date" | "datetime";
};

export type CalendarWindowScope = "window" | "undated";

export type LiveWindowBaseProps = {
  region: WorkspaceRegion | undefined;
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
  locale: string | undefined,
  displayRegion?: WorkspaceRegion,
): string {
  if (typeof value !== "string") return "—";
  if (!locale) return "Date unavailable";
  const day = dateInTimezone(value, expectedType, timezone);
  if (!day) return "Date unavailable";
  const region = displayRegion ?? { locale, timezone: timezone ?? "UTC" };
  const dayLabel = formatWorkspaceDate(day, region);
  if (expectedType === "date") return dayLabel;
  const instant = recordDateTimeInstant(value);
  if (Number.isNaN(instant.getTime())) return "Date unavailable";
  return formatWorkspaceDateTime(instant.toISOString(), region, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
  locale,
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
  /** Workspace locale; the chosen dates are repeated in its format. */
  locale: string | undefined;
}) {
  const startHintId = useId();
  const endHintId = useId();
  const chosenDate = (value: string) =>
    locale && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? formatWorkspaceDate(value, {
          locale,
          timezone: timezone ?? "UTC",
        })
      : "";
  const startLabel = chosenDate(startDate);
  const endLabel = chosenDate(endDate);
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
              aria-describedby={startLabel ? startHintId : undefined}
              className="min-h-11 w-44"
              type="date"
              value={startDate}
              onChange={(event) => onStartDateChange(event.target.value)}
            />
            {startLabel ? (
              <span id={startHintId} className="text-muted-foreground text-xs">
                {startLabel}
              </span>
            ) : null}
          </label>
          <label className="grid gap-1 text-sm">
            <span>Window ends</span>
            <Input
              aria-label="Window ends"
              aria-describedby={endLabel ? endHintId : undefined}
              className="min-h-11 w-44"
              type="date"
              value={endDate}
              onChange={(event) => onEndDateChange(event.target.value)}
            />
            {endLabel ? (
              <span id={endHintId} className="text-muted-foreground text-xs">
                {endLabel}
              </span>
            ) : null}
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

function recordText(
  row: OpenViewRecord,
  field: OpenViewDataSourceField,
  region: WorkspaceRegion,
  fallback = "—",
): string {
  return formatOpenViewFieldValue(
    openViewRecordFieldValue(row, field),
    field.type,
    region,
    fallback,
  );
}

type LiveCalendarProps = LiveWindowBaseProps &
  DateMoveProps & {
    workspaceCalendar: WorkspaceCalendarSettings | undefined;
    settingsPending: boolean;
    settingsError: boolean;
    onRetrySettings: () => void;
    scale?: "month" | "list" | null;
    dateField: CalendarDateField;
    titleField: OpenViewDataSourceField | undefined;
    detailFields: readonly OpenViewDataSourceField[];
  };

export function PendingDateMove({
  pending,
  onReview,
}: {
  pending: PendingRecordMove | undefined;
  onReview: () => void;
}) {
  if (!pending) return null;
  return (
    <div
      className={cn(
        "mt-2 border-t pt-2 text-sm break-words",
        pending.error && "text-destructive",
      )}
    >
      <p>Unsaved · {pending.targetLabel}</p>
      {pending.error ? (
        <>
          <p>{pending.error}</p>
          <Button
            type="button"
            variant="outline"
            className="mt-2 min-h-11"
            onClick={onReview}
          >
            Review latest
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** The same narrow, non-drag action remains reachable on phones and keyboards. */
export function DateMoveActions({
  row,
  title,
  startField,
  endField,
  timezone,
  pending,
  disabled,
  onMoveDates,
}: {
  row: OpenViewRecord;
  title: string;
  startField: CalendarDateField;
  endField?: CalendarDateField;
  timezone: string | null;
  pending: PendingRecordMove | undefined;
  disabled: boolean;
  onMoveDates: DateMoveProps["onMoveDates"];
}) {
  const [mode, setMode] = useState<"start" | "end" | null>(null);
  const [date, setDate] = useState("");
  const [startOffset, setStartOffset] = useState("");
  const [endOffset, setEndOffset] = useState("");
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const errorId = useId();
  const effective = effectiveMoveRecord(row, pending);
  const startDay = recordMoveDay(
    effective.data[startField.id],
    startField.type,
    timezone,
  );
  const endDay = endField
    ? recordMoveDay(effective.data[endField.id], endField.type, timezone)
    : null;
  const complete =
    !endField ||
    validMoveInterval(
      effective.data[startField.id],
      startField.type,
      effective.data[endField.id],
      endField.type,
      timezone,
    );
  if (!complete || row.isDeleted) return null;
  let targetEnd = date;
  if (endField && mode === "start" && startDay && endDay && date) {
    try {
      targetEnd = shiftMoveDay(endDay, moveDayDifference(startDay, date));
    } catch {
      targetEnd = "";
    }
  }
  const offsets = (field: CalendarDateField, target: string) => {
    try {
      return field.type === "datetime" && timezone && target
        ? datetimeOffsets(
            recordMoveLocal(effective.data[field.id], target, timezone),
            timezone,
          )
        : [];
    } catch {
      return [];
    }
  };
  const firstOffsets = mode !== "end" ? offsets(startField, date) : [];
  const lastOffsets = endField ? offsets(endField, targetEnd) : [];
  const open = (next: "start" | "end") => {
    setDate((next === "end" ? endDay : startDay) ?? "");
    setStartOffset("");
    setEndOffset("");
    setError("");
    setMode(next);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={disabled}
            >
              Move to…
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="min-h-11" onClick={() => open("start")}>
            {endField ? "Move start date…" : "Move date…"}
          </DropdownMenuItem>
          {endField ? (
            <DropdownMenuItem className="min-h-11" onClick={() => open("end")}>
              Resize end date…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={mode !== null && !disabled}
        onOpenChange={(isOpen) => {
          if (!isOpen) setMode(null);
        }}
      >
        <DialogContent finalFocus={trigger}>
          <DialogHeader>
            <DialogTitle>Move {title}</DialogTitle>
            <DialogDescription>
              {endField
                ? mode === "end"
                  ? "Resize only the end date. The start stays unchanged."
                  : "Shift both dates by the same workspace calendar days."
                : "Move this record to a workspace calendar day."}{" "}
              This is unsaved until Save changes.
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !mode) return;
              try {
                if (mode === "end" && endField) {
                  const value = moveDateValue(
                    effective.data[endField.id],
                    endField.type,
                    date,
                    timezone,
                    endOffset || undefined,
                  );
                  if (
                    !validMoveInterval(
                      effective.data[startField.id],
                      startField.type,
                      value,
                      endField.type,
                      timezone,
                    )
                  )
                    throw new Error(
                      "End date must be on or after the start date.",
                    );
                  onMoveDates(
                    row,
                    { kind: "single", fieldId: endField.id, value },
                    `${startDay} – ${date}`,
                    [startField.id, endField.id],
                  );
                } else {
                  const value = moveDateValue(
                    effective.data[startField.id],
                    startField.type,
                    date,
                    timezone,
                    startOffset || undefined,
                  );
                  if (endField) {
                    const end = moveDateValue(
                      effective.data[endField.id],
                      endField.type,
                      targetEnd,
                      timezone,
                      endOffset || undefined,
                    );
                    if (
                      !validMoveInterval(
                        value,
                        startField.type,
                        end,
                        endField.type,
                        timezone,
                      )
                    )
                      throw new Error(
                        "End date must be on or after the start date.",
                      );
                    onMoveDates(
                      row,
                      {
                        kind: "compound",
                        changes: [
                          { fieldId: startField.id, value },
                          { fieldId: endField.id, value: end },
                        ],
                      },
                      `${date} – ${targetEnd}`,
                      [startField.id, endField.id],
                    );
                  } else
                    onMoveDates(
                      row,
                      { kind: "single", fieldId: startField.id, value },
                      date,
                      [startField.id],
                    );
                }
                setMode(null);
              } catch (caught) {
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Choose a valid schedule date.",
                );
              }
            }}
          >
            <label className="grid gap-1 text-sm">
              <span>
                {mode === "end"
                  ? "End date"
                  : endField
                    ? "Start date"
                    : "Move date"}
              </span>
              <Input
                type="date"
                required
                className="min-h-11"
                value={date}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => {
                  setDate(event.target.value);
                  setStartOffset("");
                  setEndOffset("");
                  setError("");
                }}
              />
            </label>
            {endField && mode === "start" ? (
              <label className="grid gap-1 text-sm">
                <span>End date</span>
                <Input
                  type="date"
                  className="min-h-11"
                  value={targetEnd}
                  readOnly
                />
              </label>
            ) : null}
            {effective.data[startField.id] == null &&
            startField.type === "datetime" ? (
              <p className="text-muted-foreground text-sm">
                Undated time defaults to workspace-local 00:00.
              </p>
            ) : null}
            {timezone ? (
              <p className="text-muted-foreground text-sm">
                Workspace timezone: {timezone}. Existing wall time, seconds and
                fractions are preserved.
              </p>
            ) : null}
            {firstOffsets.length > 1 ? (
              <label className="grid gap-1 text-sm">
                <span>Start UTC offset</span>
                <Select
                  className="min-h-11"
                  value={startOffset}
                  onValueChange={(value) => setStartOffset(value)}
                >
                  <option value="">Choose UTC offset</option>
                  {firstOffsets.map((offset) => (
                    <option key={offset} value={offset}>
                      {offset}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {lastOffsets.length > 1 ? (
              <label className="grid gap-1 text-sm">
                <span>End UTC offset</span>
                <Select
                  className="min-h-11"
                  value={endOffset}
                  onValueChange={(value) => setEndOffset(value)}
                >
                  <option value="">Choose UTC offset</option>
                  {lastOffsets.map((offset) => (
                    <option key={offset} value={offset}>
                      {offset}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {error ? (
              <Alert id={errorId} role="alert" variant="destructive">
                {error}
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setMode(null)}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-11">
                Stage move
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CalendarDayTarget({
  date,
  disabled,
  children,
}: {
  date: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `calendar-day:${date}`,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`Move to ${date}`}
      aria-disabled={disabled}
      className={cn(
        "min-h-24 border-r border-b p-1.5",
        disabled && "bg-muted/10 text-muted-foreground/60",
        isOver && "bg-primary/10 ring-primary ring-2",
      )}
    >
      {children}
    </div>
  );
}

function CalendarMoveCard({
  row,
  title,
  instance,
  canMove,
  movesPending,
  pending,
  dateField,
  timezone,
  onMoveDates,
  onReview,
  children,
}: {
  row: OpenViewRecord;
  title: string;
  instance: string;
  canMove: boolean;
  movesPending: boolean;
  pending: PendingRecordMove | undefined;
  dateField: CalendarDateField;
  timezone: string | null;
  onMoveDates: DateMoveProps["onMoveDates"];
  onReview: () => void;
  children: React.ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    isDragging,
  } = useDraggable({
    id: `calendar:${instance}:${row.id}`,
    data: { recordId: row.id },
    disabled: !canMove || movesPending || row.isDeleted,
  });
  return (
    <article
      ref={setNodeRef}
      className={cn(
        "relative min-w-0 rounded-[var(--radius)] border p-2",
        pending && "bg-muted/50 border-dashed",
        pending?.error && "border-destructive",
        isDragging && "z-50 shadow-lg",
      )}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
    >
      {children}
      {canMove && !row.isDeleted ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            type="button"
            variant="ghost"
            className="min-h-11 min-w-11 cursor-grab"
            aria-label={`Drag date: ${title}`}
            disabled={movesPending}
          >
            <GripVertical aria-hidden="true" />
          </Button>
          <DateMoveActions
            row={row}
            title={title}
            startField={dateField}
            timezone={timezone}
            pending={pending}
            disabled={movesPending}
            onMoveDates={onMoveDates}
          />
        </div>
      ) : null}
      <PendingDateMove pending={pending} onReview={onReview} />
    </article>
  );
}

export function LiveCalendar(props: LiveCalendarProps) {
  if (!props.workspaceCalendar)
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
            Records grouped by their date.
          </p>
        </header>
        <LoadingRegion
          loading={props.settingsPending}
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
            variant="destructive"
            className="m-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p>Organization calendar settings could not be loaded.</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={props.onRetrySettings}
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
      region={props.workspaceCalendar}
      weekStart={props.workspaceCalendar.week_start}
    />
  );
}

function ResolvedLiveCalendar({
  region: workspaceRegion,
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
  canWrite,
  movesPending,
  pendingMoves,
  onMoveDates,
}: LiveCalendarProps & {
  region: WorkspaceRegion;
  weekStart: WorkspaceCalendarSettings["week_start"];
  settingsError: boolean;
  onRetrySettings: () => void;
}) {
  const region = useDisplayRegion(workspaceRegion) ?? workspaceRegion;
  const displayWeekStart = useDisplayWeekStart(weekStart);
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
  const [undatedOpen, setUndatedOpen] = useState(false);
  const [undatedPosition, setUndatedPosition] = useState({
    key: "",
    offset: 0,
  });
  const undatedKey = JSON.stringify([
    moduleId,
    definition,
    dateField.id,
    dateField.type,
  ]);
  const undatedOffset =
    undatedPosition.key === undatedKey ? undatedPosition.offset : 0;
  const undatedRequest = useMemo<OpenViewWindowQueryRequest | null>(
    () =>
      undatedOpen && scope === "window" && canWrite
        ? {
            moduleId,
            definition,
            mode: "calendar",
            scope: "undated",
            dateField: { fieldId: dateField.id, expectedType: dateField.type },
            limit: WINDOW_PAGE_SIZE,
            offset: undatedOffset,
          }
        : null,
    [
      undatedOpen,
      scope,
      canWrite,
      moduleId,
      definition,
      dateField.id,
      dateField.type,
      undatedOffset,
    ],
  );
  const undated = useWindowPage(undatedRequest, retry + refreshKey);
  useEffect(() => {
    if (previousRange.current !== dateRange) manualWindow.current = false;
    previousRange.current = dateRange;
    if (!manualWindow.current) {
      setWindowDates(initialDateWindow(dateRange, weekStart));
      setPagePosition({ key: "", offset: 0 });
    }
  }, [dateRange, weekStart]);
  const timezone = result?.timezone ?? null;
  // The server response owns this window's operating zone. Personal display
  // may override it, but inherited timestamps keep the response-zone fallback.
  const windowRegion = useDisplayRegion({
    ...workspaceRegion,
    timezone: timezone ?? workspaceRegion.timezone,
  });
  const moveTimezone =
    timezone ?? (dateField.type === "date" ? workspaceRegion.timezone : null);
  const canMove =
    canWrite && !loading && !error && Boolean(result) && !settingsError;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );
  const dragStamp = JSON.stringify([
    baseKey,
    refreshKey,
    timezone,
    workspaceRegion.timezone,
    canMove,
    movesPending,
    undatedKey,
    undatedOffset,
  ]);
  const startedDrag = useRef<string | null>(null);
  const [moveError, setMoveError] = useState("");
  const openRow = (rowId: string, side = false) => {
    const selectedRequest = side ? undatedRequest : request;
    const selectedResult = side ? undated.result : result;
    if (!selectedRequest || !selectedResult) return;
    onOpenRecord(rowId, {
      rows: selectedResult.items,
      offset: selectedResult.pagination.offset,
      total: selectedResult.pagination.total,
      source: {
        kind: "window",
        request: selectedRequest,
        returnToPage: (nextOffset) =>
          side
            ? setUndatedPosition({ key: undatedKey, offset: nextOffset })
            : setPagePosition({ key: baseKey, offset: nextOffset }),
      },
    });
  };
  const moveCard = (
    row: OpenViewRecord,
    instance: string,
    children: React.ReactNode,
    side = false,
  ) => {
    const title = titleField
      ? recordText(row, titleField, region, "Untitled record")
      : `Record ${row.id.slice(0, 8)}`;
    return (
      <CalendarMoveCard
        row={row}
        title={title}
        instance={instance}
        canMove={canMove && (!side || (!undated.loading && !undated.error))}
        movesPending={movesPending}
        pending={pendingMoves.get(row.id)}
        dateField={dateField}
        timezone={
          side ? (undated.result?.timezone ?? moveTimezone) : moveTimezone
        }
        onMoveDates={onMoveDates}
        onReview={() => openRow(row.id, side)}
      >
        {children}
      </CalendarMoveCard>
    );
  };
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
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={() => {
        startedDrag.current = dragStamp;
        setMoveError("");
      }}
      onDragCancel={() => {
        startedDrag.current = null;
      }}
      onDragEnd={({ active, over }) => {
        const valid = startedDrag.current === dragStamp;
        startedDrag.current = null;
        if (
          !valid ||
          !canMove ||
          movesPending ||
          !over ||
          !String(over.id).startsWith("calendar-day:")
        )
          return;
        const date = String(over.id).slice("calendar-day:".length);
        if (date < windowDates.start || date > windowDates.end) return;
        const row = [
          ...(result?.items ?? []),
          ...(undated.result?.items ?? []),
        ].find((item) => item.id === active.data.current?.recordId);
        if (!row || row.isDeleted) return;
        try {
          const effective = effectiveMoveRecord(row, pendingMoves.get(row.id));
          const value = moveDateValue(
            effective.data[dateField.id],
            dateField.type,
            date,
            moveTimezone,
          );
          onMoveDates(
            row,
            { kind: "single", fieldId: dateField.id, value },
            date,
            [dateField.id],
          );
        } catch (caught) {
          setMoveError(
            `${caught instanceof Error ? caught.message : "This date move cannot be staged."} Use Move to… to choose the date and UTC offset.`,
          );
        }
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Drag to a visible calendar day, or use the Move to menu with a keyboard. Save changes applies the unsaved moves.",
        },
      }}
    >
      <Card
        className="min-w-0 self-auto overflow-hidden"
        aria-label={scale === "list" ? "Calendar list view" : "Calendar"}
      >
        <header data-slot="card-header" className="border-b px-4 py-3">
          <h2 data-slot="section-title" className="font-medium">
            Calendar · {dateFieldTitle}
          </h2>
          <p className="text-muted-foreground text-sm">
            Records grouped by their date.
          </p>
        </header>
        {moveError ? (
          <Alert role="alert" variant="destructive" className="m-4">
            {moveError}
          </Alert>
        ) : null}
        {canWrite && scope === "window" ? (
          <section aria-label="Undated move list" className="border-b p-4">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              aria-expanded={undatedOpen}
              onClick={() => setUndatedOpen((open) => !open)}
            >
              {undatedOpen
                ? "Hide undated move list"
                : "Show undated move list"}
            </Button>
            {undatedOpen ? (
              <>
                {undated.loading ? (
                  <p role="status" className="mt-3 text-sm">
                    Loading undated records…
                  </p>
                ) : null}
                {undated.error ? (
                  <Alert role="alert" variant="destructive" className="mt-3">
                    {undated.error}
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      Retry undated records
                    </Button>
                  </Alert>
                ) : null}
                {undated.result ? (
                  <>
                    <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {undated.result.items.map((row) => (
                        <li key={row.id}>
                          {moveCard(
                            row,
                            "side",
                            <Button
                              type="button"
                              variant="ghost"
                              className="min-h-11 max-w-full whitespace-normal"
                              aria-label={`Open record: ${titleField ? recordText(row, titleField, region, "Untitled record") : `Record ${row.id.slice(0, 8)}`}`}
                              onClick={() => openRow(row.id, true)}
                            >
                              {titleField
                                ? titleField.type === "user"
                                  ? "Open record"
                                  : recordText(
                                      row,
                                      titleField,
                                      region,
                                      "Untitled record",
                                    )
                                : `Record ${row.id.slice(0, 8)}`}
                            </Button>,
                            true,
                          )}
                          {titleField?.type === "user" ? (
                            <RecordPersonCard row={row} field={titleField}>
                              {recordText(row, titleField, region)}
                            </RecordPersonCard>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <WindowPageNavigation
                      result={undated.result}
                      loading={undated.loading}
                      onOffsetChange={(nextOffset) =>
                        setUndatedPosition({
                          key: undatedKey,
                          offset: nextOffset,
                        })
                      }
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
        {settingsError ? (
          <Alert
            role="alert"
            variant="destructive"
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
          locale={region.locale}
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
                (firstDay.getUTCDay() +
                  (displayWeekStart === "monday" ? 6 : 0)) %
                7;
              const firstWeekday = displayWeekStart === "monday" ? 5 : 4;
              const weekdays = Array.from({ length: 7 }, (_, index) =>
                formatWorkspaceDate(
                  `2026-01-${String(firstWeekday + index).padStart(2, "0")}`,
                  region,
                  { weekday: "short" },
                ),
              );
              const monthLabel = formatWorkspaceDate(`${monthKey}-01`, region, {
                month: "long",
                year: "numeric",
              });
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
                            date >= windowDates.start &&
                            date <= windowDates.end;
                          const rows = groupByDay.get(date) ?? [];
                          return (
                            <CalendarDayTarget
                              key={date}
                              date={date}
                              disabled={!inWindow || !canMove || movesPending}
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
                                    region.locale,
                                    windowRegion,
                                  )}
                                </h4>
                              ) : null}
                              <ul className="flex max-h-44 min-w-0 flex-col gap-1 overflow-y-auto">
                                {rows.map((row) => {
                                  const title = titleField
                                    ? recordText(
                                        row,
                                        titleField,
                                        region,
                                        "Untitled record",
                                      )
                                    : `Record ${row.id.slice(0, 8)}`;
                                  return (
                                    <li key={row.id}>
                                      {moveCard(
                                        row,
                                        "month",
                                        <>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            className="h-auto min-h-11 w-full flex-col items-start justify-start gap-0 border px-2 py-1.5 text-left text-xs whitespace-normal"
                                            aria-label={`Open record: ${title}`}
                                            onClick={() => {
                                              if (!request || !result) return;
                                              onOpenRecord(row.id, {
                                                rows: result.items,
                                                offset:
                                                  result.pagination.offset,
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
                                              {titleField?.type === "user"
                                                ? "Open record"
                                                : title}
                                            </span>
                                            {detailFields.filter(
                                              (field) => field.type !== "user",
                                            ).length ? (
                                              <span className="text-muted-foreground mt-1 block text-left text-xs">
                                                {detailFields
                                                  .filter(
                                                    (field) =>
                                                      field.type !== "user",
                                                  )
                                                  .slice(0, 2)
                                                  .map((field) =>
                                                    recordText(
                                                      row,
                                                      field,
                                                      region,
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
                                                region.locale,
                                                windowRegion,
                                              )}
                                            </span>
                                          </Button>
                                          {titleField?.type === "user" ? (
                                            <RecordPersonCard
                                              row={row}
                                              field={titleField}
                                            >
                                              {title}
                                            </RecordPersonCard>
                                          ) : null}
                                          {detailFields
                                            .slice(0, 2)
                                            .filter(
                                              (field) => field.type === "user",
                                            )
                                            .map((field) => (
                                              <div
                                                key={field.id}
                                                className="text-muted-foreground text-xs"
                                              >
                                                <RecordPersonCard
                                                  row={row}
                                                  field={field}
                                                >
                                                  {recordText(
                                                    row,
                                                    field,
                                                    region,
                                                  )}
                                                </RecordPersonCard>
                                              </div>
                                            ))}
                                        </>,
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </CalendarDayTarget>
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
            variant="destructive"
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
                      : formatWorkspaceDate(day, region)}
                </h3>
                <ul className="divide-y">
                  {rows.map((row) => {
                    const title = titleField
                      ? recordText(row, titleField, region, "Untitled record")
                      : `Record ${row.id.slice(0, 8)}`;
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      >
                        {moveCard(
                          row,
                          "list",
                          <>
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
                                {titleField?.type === "user"
                                  ? "Open record"
                                  : title}
                              </button>
                              {titleField?.type === "user" ? (
                                <RecordPersonCard row={row} field={titleField}>
                                  {title}
                                </RecordPersonCard>
                              ) : null}
                              {detailFields.map((field) => (
                                <p
                                  key={field.id}
                                  className="text-muted-foreground text-sm"
                                >
                                  {field.name}:{" "}
                                  <RecordPersonCard row={row} field={field}>
                                    {recordText(row, field, region)}
                                  </RecordPersonCard>
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
                                  region.locale,
                                  windowRegion,
                                )}
                              </time>
                            ) : null}
                          </>,
                        )}
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
    </DndContext>
  );
}
