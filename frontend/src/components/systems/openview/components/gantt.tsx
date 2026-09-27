"use client";

import { CalendarClock, GanttChart, TriangleAlert } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { OpenViewModule, OpenViewRow, ViewLayout } from "../domain/model";
import {
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  OPENVIEW_SAMPLE_TIMEZONE,
  normalizeOpenViewScheduleItems,
  type OpenViewScheduleItem,
} from "../helpers/operations";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

type ScheduleWindow = {
  start: Date;
  end: Date;
};

type ScheduleTone = {
  surface: string;
  border: string;
  solid: string;
};

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

function scheduleWindow(range: ViewLayout["dateRange"]): ScheduleWindow {
  const anchor = parseIsoDate(OPENVIEW_SAMPLE_SNAPSHOT_DATE) ?? new Date();
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  if (range === "week") {
    return {
      start: new Date(anchor.getTime() - 6 * DAY_IN_MS),
      end: anchor,
    };
  }
  if (range === "quarter") {
    const quarterStart = Math.floor(month / 3) * 3;
    return {
      start: new Date(Date.UTC(year, quarterStart, 1)),
      end: new Date(Date.UTC(year, quarterStart + 3, 0)),
    };
  }
  if (range === "year") {
    return {
      start: new Date(Date.UTC(year, 0, 1)),
      end: new Date(Date.UTC(year, 12, 0)),
    };
  }
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 0)),
  };
}

function axisTicks(window: ScheduleWindow, range: ViewLayout["dateRange"]) {
  const tickCount = range === "week" ? 7 : range === "year" ? 6 : 5;
  const span = window.end.getTime() - window.start.getTime();
  return Array.from({ length: tickCount }, (_, index) => {
    const position = index / (tickCount - 1);
    return {
      date: new Date(window.start.getTime() + span * position),
      position: position * 100,
    };
  });
}

function positionInWindow(date: Date, window: ScheduleWindow): number {
  const span = window.end.getTime() - window.start.getTime();
  if (span <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, ((date.getTime() - window.start.getTime()) / span) * 100),
  );
}

function formatAxisDate(date: Date, range: ViewLayout["dateRange"]): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    month: range === "week" ? undefined : "short",
    day: range === "year" ? undefined : "numeric",
    weekday: range === "week" ? "short" : undefined,
  }).format(date);
}

function formatScheduleDate(value: string | null): string {
  if (!value) return "Unscheduled";
  const date = parseIsoDate(value);
  if (!date) return "Invalid date";
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatShortDate(value: string | null): string {
  if (!value) return "—";
  const date = parseIsoDate(value);
  if (!date) return "Invalid";
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
}

function scheduleTone(status: string): ScheduleTone {
  const normalized = status.toLocaleLowerCase();
  if (normalized.includes("hold") || normalized.includes("repair"))
    return {
      surface: "bg-chart-5/12",
      border: "border-chart-5/45",
      solid: "bg-chart-5",
    };
  if (normalized.includes("active") || normalized.includes("in service"))
    return {
      surface: "bg-chart-3/12",
      border: "border-chart-3/45",
      solid: "bg-chart-3",
    };
  if (normalized.includes("progress"))
    return {
      surface: "bg-chart-4/12",
      border: "border-chart-4/45",
      solid: "bg-chart-4",
    };
  if (
    normalized.includes("scheduled") ||
    normalized.includes("due") ||
    normalized.includes("review")
  )
    return {
      surface: "bg-chart-2/12",
      border: "border-chart-2/45",
      solid: "bg-chart-2",
    };
  return {
    surface: "bg-chart-1/12",
    border: "border-chart-1/45",
    solid: "bg-chart-1",
  };
}

function timingLabel(value: OpenViewScheduleItem["timingState"]): string {
  if (value === "due-soon") return "Due soon";
  if (value === "late-plan") return "Late plan";
  if (value === "on-track") return "On track";
  if (value === "unscheduled") return "Needs scheduling";
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function scheduleItemLabel(item: OpenViewScheduleItem): string {
  const dates =
    item.type === "milestone"
      ? `milestone ${formatScheduleDate(item.start)}`
      : item.type === "task"
        ? `from ${formatScheduleDate(item.start)} to ${formatScheduleDate(item.end)}`
        : "without a valid schedule";
  return `${item.label}, ${dates}, status ${item.status || "unspecified"}, owner ${item.owner || "unassigned"}, progress ${item.progress === null ? "unspecified" : `${item.progress}%`}`;
}

function dateRangeLabel(range: ViewLayout["dateRange"]): string {
  if (range === "week") return "Week range";
  if (range === "quarter") return "Quarter range";
  if (range === "year") return "Year range";
  return "Month range";
}

export function GanttView({
  module,
  rows,
  layout,
  dateField,
  onInspect,
}: {
  module: OpenViewModule;
  rows: OpenViewRow[];
  anchorRows: OpenViewRow[];
  layout: ViewLayout;
  dateField: string;
  onInspect: (id: string) => void;
}) {
  const secondary =
    layout.secondaryField ?? module.fields[1]?.id ?? module.primaryField;
  const configuredDateLabel =
    module.fields.find((field) => field.id === dateField)?.label ?? "Date";
  const scheduleItems = normalizeOpenViewScheduleItems(rows, module.id).sort(
    (left, right) =>
      (left.start ?? "9999-12-31").localeCompare(right.start ?? "9999-12-31") ||
      left.label.localeCompare(right.label),
  );
  const window = scheduleWindow(layout.dateRange);
  const ticks = axisTicks(window, layout.dateRange);
  const sampleDate = parseIsoDate(OPENVIEW_SAMPLE_SNAPSHOT_DATE);
  const samplePosition = sampleDate
    ? positionInWindow(sampleDate, window)
    : undefined;
  const scheduledCount = scheduleItems.filter(
    (item) => item.type !== "unscheduled",
  ).length;
  const unscheduledItems = scheduleItems.filter(
    (item) => item.type === "unscheduled",
  );
  const scheduleMeaning =
    scheduleItems.find((item) => item.dateMeaning)?.dateMeaning ??
    "Planned work window and deadline";
  const compact = layout.scale === "list";
  const densityLabel = compact ? "Compact rows" : "Detailed rows";

  return (
    <Card className="w-full overflow-hidden">
      <CardHeader className="gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)]">
            <GanttChart aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <CardTitle>Planned schedule</CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              Read-only schedule bars show planned start and end dates. The fill
              shows source progress, and diamonds mark deadlines. The configured{" "}
              {configuredDateLabel.toLocaleLowerCase()} remains available as a
              date filter; {scheduleMeaning.toLocaleLowerCase()} drives this
              schedule.
            </CardDescription>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Badge variant="outline">{dateRangeLabel(layout.dateRange)}</Badge>
          <Badge variant="outline">{densityLabel}</Badge>
          <Badge variant="secondary">
            {scheduledCount} scheduled · {unscheduledItems.length} unscheduled
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {unscheduledItems.length ? (
          <Alert role="note" variant="warning" className="m-4 flex gap-2">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
            <span>
              {unscheduledItems.length} record
              {unscheduledItems.length === 1 ? " is" : "s are"} excluded from
              bars because start and end dates are missing or invalid. The row
              diagnostics below explain what needs attention.
            </span>
          </Alert>
        ) : null}
        <div
          className="overflow-x-auto overscroll-x-contain"
          role="region"
          aria-label={`${module.name} planned schedule Gantt chart`}
          tabIndex={0}
        >
          <div className="min-w-[68rem]">
            <div className="border-border grid grid-cols-[minmax(20rem,24rem)_minmax(44rem,1fr)] border-b">
              <div
                className={cn(
                  "bg-card border-border sticky left-0 z-20 flex items-end border-r px-4",
                  compact ? "min-h-14 py-2" : "min-h-20 py-3",
                )}
              >
                <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {compact ? "Record / schedule" : "Record and operating facts"}
                </span>
              </div>
              <div
                className={cn("relative", compact ? "min-h-14" : "min-h-20")}
                aria-hidden="true"
              >
                {ticks.map((tick) => (
                  <div
                    key={tick.date.toISOString()}
                    className="border-border absolute inset-y-0 border-l"
                    style={{ left: `${tick.position}%` }}
                  >
                    <span
                      className={cn(
                        "text-muted-foreground absolute text-xs whitespace-nowrap tabular-nums",
                        compact ? "bottom-2" : "bottom-3",
                        tick.position === 0
                          ? "left-2"
                          : tick.position === 100
                            ? "right-2"
                            : "-translate-x-1/2",
                      )}
                    >
                      {formatAxisDate(tick.date, layout.dateRange)}
                    </span>
                  </div>
                ))}
                {samplePosition !== undefined ? (
                  <div
                    className="border-primary/75 absolute inset-y-0 z-10 border-l border-dashed"
                    style={{ left: `${samplePosition}%` }}
                  >
                    <span
                      className={cn(
                        "text-foreground absolute text-xs font-medium whitespace-nowrap",
                        compact ? "top-1" : "top-2",
                        samplePosition > 70 ? "right-2" : "left-2",
                      )}
                    >
                      Snapshot date
                    </span>
                  </div>
                ) : null}
              </div>
            </div>

            <div>
              {scheduleItems.map((item) => {
                const tone = scheduleTone(item.status);
                const start = item.start ? parseIsoDate(item.start) : null;
                const end = item.end ? parseIsoDate(item.end) : null;
                const startPosition = start
                  ? positionInWindow(start, window)
                  : undefined;
                const endPosition = end
                  ? positionInWindow(end, window)
                  : undefined;
                const deadline = item.deadline
                  ? parseIsoDate(item.deadline)
                  : null;
                const deadlinePosition = deadline
                  ? positionInWindow(deadline, window)
                  : undefined;
                const barWidth =
                  startPosition !== undefined && endPosition !== undefined
                    ? Math.max(1.5, endPosition - startPosition)
                    : undefined;
                const title = String(
                  item.label || item.rowId || "Untitled record",
                );
                const sourceRow = rows.find((row) => row.id === item.rowId);
                return (
                  <div
                    key={item.id}
                    className="border-border grid grid-cols-[minmax(20rem,24rem)_minmax(44rem,1fr)] border-b last:border-b-0"
                  >
                    <div
                      className={cn(
                        "bg-card border-border sticky left-0 z-20 flex min-w-0 items-center border-r",
                        compact ? "px-1" : "px-2",
                      )}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        className={cn(
                          "h-auto w-full min-w-0 justify-start px-2 text-left whitespace-normal",
                          compact ? "gap-1 py-2" : "gap-1.5 py-3",
                        )}
                        aria-label={`Inspect ${scheduleItemLabel(item)}`}
                        onClick={() => onInspect(item.rowId)}
                      >
                        <span
                          className={cn(
                            "flex w-full min-w-0 flex-col items-start",
                            compact ? "gap-1" : "gap-1.5",
                          )}
                        >
                          <span className="flex w-full items-start justify-between gap-2">
                            <span
                              className={cn(
                                "min-w-0 font-medium",
                                layout.wrap ? "break-words" : "truncate",
                              )}
                            >
                              {title}
                            </span>
                            <Badge
                              variant={
                                item.attentionReason ? "warning" : "outline"
                              }
                              className="shrink-0 text-xs"
                            >
                              {timingLabel(item.timingState)}
                            </Badge>
                          </span>
                          {compact ? (
                            <>
                              <span className="text-muted-foreground flex w-full flex-wrap items-center gap-x-2 text-xs">
                                <span>{item.status || "Unspecified"}</span>
                                <span aria-hidden="true">·</span>
                                <span>{item.owner || "Unassigned"}</span>
                                <span aria-hidden="true">·</span>
                                <span>
                                  {item.progress === null
                                    ? "Progress —"
                                    : `Progress ${item.progress}%`}
                                </span>
                              </span>
                              <span className="text-muted-foreground text-xs tabular-nums">
                                {item.type === "task"
                                  ? `Planned ${formatShortDate(item.start)} – ${formatShortDate(item.end)}`
                                  : item.type === "milestone"
                                    ? `Milestone ${formatShortDate(item.start)}`
                                    : "No valid schedule"}
                                {item.deadline
                                  ? ` · Due ${formatShortDate(item.deadline)}`
                                  : ""}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-muted-foreground w-full truncate text-xs">
                                {String(sourceRow?.values[secondary] ?? "—")}
                              </span>
                              <span className="grid w-full grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                <span>
                                  <span className="text-muted-foreground block">
                                    Status
                                  </span>
                                  {item.status || "Unspecified"}
                                </span>
                                <span>
                                  <span className="text-muted-foreground block">
                                    Owner
                                  </span>
                                  {item.owner || "Unassigned"}
                                </span>
                                <span>
                                  <span className="text-muted-foreground block">
                                    Progress
                                  </span>
                                  {item.progress === null
                                    ? "Unspecified"
                                    : `${item.progress}%`}
                                </span>
                                <span>
                                  <span className="text-muted-foreground block">
                                    Deadline
                                  </span>
                                  {formatShortDate(item.deadline)}
                                </span>
                              </span>
                            </>
                          )}
                          {!compact && item.type === "task" ? (
                            <span className="text-muted-foreground text-xs tabular-nums">
                              Start {formatShortDate(item.start)} · End{" "}
                              {formatShortDate(item.end)}
                            </span>
                          ) : !compact && item.type === "milestone" ? (
                            <span className="text-muted-foreground text-xs tabular-nums">
                              Milestone {formatShortDate(item.start)}
                            </span>
                          ) : null}
                          {item.diagnostics.length ? (
                            <span className="text-chart-5 text-xs font-medium">
                              {compact
                                ? `${item.diagnostics[0]}${item.diagnostics.length > 1 ? ` +${item.diagnostics.length - 1} more` : ""}`
                                : item.diagnostics.join(" ")}
                            </span>
                          ) : item.attentionReason ? (
                            <span className="text-chart-5 text-xs font-medium">
                              {item.attentionReason}
                            </span>
                          ) : null}
                        </span>
                      </Button>
                    </div>
                    <div
                      className={cn(
                        "relative",
                        compact ? "min-h-20" : "min-h-28",
                      )}
                    >
                      {samplePosition !== undefined ? (
                        <span
                          className="border-primary/75 pointer-events-none absolute inset-y-0 z-10 border-l border-dashed"
                          style={{ left: `${samplePosition}%` }}
                          aria-hidden="true"
                        />
                      ) : null}
                      {ticks.map((tick) => (
                        <span
                          key={tick.date.toISOString()}
                          className="border-border/70 pointer-events-none absolute inset-y-0 border-l"
                          style={{ left: `${tick.position}%` }}
                          aria-hidden="true"
                        />
                      ))}
                      {item.type === "unscheduled" ||
                      startPosition === undefined ||
                      endPosition === undefined ||
                      barWidth === undefined ? (
                        <span className="text-muted-foreground absolute inset-y-0 left-4 flex items-center gap-2 text-xs">
                          <CalendarClock
                            aria-hidden="true"
                            className="size-4"
                          />
                          No valid schedule bar
                        </span>
                      ) : item.type === "milestone" ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="hover:bg-accent absolute top-1/2 z-20 size-11 -translate-x-1/2 -translate-y-1/2 rounded-full"
                            style={{ left: `${startPosition}%` }}
                            aria-label={`Inspect ${scheduleItemLabel(item)}`}
                            onClick={() => onInspect(item.rowId)}
                          >
                            <span
                              className={cn(
                                "block size-4 rotate-45 border-2",
                                tone.solid,
                              )}
                              aria-hidden="true"
                            />
                          </Button>
                          <span
                            className={cn(
                              "text-foreground pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 text-xs font-medium whitespace-nowrap tabular-nums",
                              startPosition > 72
                                ? "-translate-x-full pr-7"
                                : "pl-7",
                            )}
                            style={{ left: `${startPosition}%` }}
                            aria-hidden="true"
                          >
                            {formatShortDate(item.start)}
                          </span>
                        </>
                      ) : (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            className={cn(
                              "absolute top-1/2 z-20 h-11 -translate-y-1/2 overflow-hidden rounded-[var(--radius)] border p-0 text-left",
                              tone.surface,
                              tone.border,
                            )}
                            style={{
                              left: `${startPosition}%`,
                              width: `${barWidth}%`,
                            }}
                            aria-label={`Inspect ${scheduleItemLabel(item)}`}
                            onClick={() => onInspect(item.rowId)}
                          >
                            <span
                              className={cn(
                                "absolute inset-y-0 left-0 opacity-80",
                                tone.solid,
                              )}
                              style={{ width: `${item.progress ?? 0}%` }}
                              aria-hidden="true"
                            />
                            <span className="relative flex h-full min-w-0 items-center justify-between gap-2 px-2 text-xs font-medium">
                              <span className="truncate">{title}</span>
                              <span className="shrink-0 tabular-nums">
                                {item.progress === null
                                  ? "—"
                                  : `${item.progress}%`}
                              </span>
                            </span>
                          </Button>
                          <span
                            className="text-muted-foreground pointer-events-none absolute top-2 text-xs font-medium whitespace-nowrap tabular-nums"
                            style={{ left: `${startPosition}%` }}
                            aria-hidden="true"
                          >
                            {formatShortDate(item.start)}
                          </span>
                          <span
                            className="text-muted-foreground pointer-events-none absolute right-0 bottom-2 text-xs font-medium whitespace-nowrap tabular-nums"
                            style={{ left: `${endPosition}%` }}
                            aria-hidden="true"
                          >
                            {formatShortDate(item.end)}
                          </span>
                        </>
                      )}
                      {deadlinePosition !== undefined ? (
                        <span
                          className="pointer-events-none absolute top-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1"
                          style={{ left: `${deadlinePosition}%` }}
                          aria-hidden="true"
                        >
                          <span className="bg-foreground border-background block size-3 rotate-45 border-2" />
                          <span
                            className={cn(
                              "text-foreground text-xs font-semibold whitespace-nowrap tabular-nums",
                              deadlinePosition > 76
                                ? "-translate-x-full pr-4"
                                : "pl-2",
                            )}
                          >
                            Due {formatShortDate(item.deadline)}
                          </span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-4 py-3 text-xs">
          <span className="flex items-center gap-2">
            <span
              className="bg-primary block size-2.5 rounded-sm"
              aria-hidden="true"
            />
            Snapshot date · {OPENVIEW_SAMPLE_SNAPSHOT_DATE} (
            {OPENVIEW_SAMPLE_TIMEZONE})
          </span>
          <span className="flex items-center gap-2">
            <span
              className="bg-foreground block size-2.5 rotate-45"
              aria-hidden="true"
            />
            Deadline
          </span>
          <span>
            Fill = source progress · Scroll horizontally to inspect the full
            schedule.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
