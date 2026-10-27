"use client";

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import { compactTime, type CalendarItem } from "../domain/calendar-items";

/**
 * The calendar's marks (BR53, BR54): a timed event is ink on a 3px rule in
 * its calendar's color; an all-day event is a tinted pill; a record source is
 * outlined; a due card is dashed with "Due" first. Titles stay in ink. The
 * calendar's name is in every item's accessible name and tooltip (the Name
 * Beside Color exception for month cells, DESIGN.md).
 */

export type CalendarInfo = {
  id: string;
  name: string;
  color: string;
};

export type OpenCalendarItem = (
  item: CalendarItem,
  anchor: HTMLElement,
) => void;

export function colorStyle(color: string): CSSProperties {
  return { "--cal": color } as CSSProperties;
}

export function dayLabel(date: string, region: WorkspaceRegion): string {
  return formatWorkspaceDate(date, region, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "9am–10am", "All day", "All day · to Nov 20", or "Due". */
export function itemWhen(
  item: CalendarItem,
  region: WorkspaceRegion,
  date?: string,
): string {
  if (item.kind === "due") return "Due";
  if (item.allDay)
    return item.endDate > item.startDate && item.endDate !== date
      ? `All day · to ${formatWorkspaceDate(item.endDate, region, { month: "short", day: "numeric" })}`
      : "All day";
  const start = compactTime(item.startMinute ?? 0, region);
  if (item.kind === "source") return start;
  return `${start}–${compactTime(item.endMinute ?? 0, region)}`;
}

export function itemAccessibleName(
  item: CalendarItem,
  calendar: CalendarInfo | undefined,
  region: WorkspaceRegion,
): string {
  const when =
    item.kind === "due"
      ? "due"
      : item.allDay
        ? "all day"
        : compactTime(item.startMinute ?? 0, region);
  return [
    item.kind === "due" ? `Due: ${item.title}` : item.title,
    calendar?.name ?? "Calendar",
    dayLabel(item.startDate, region),
    when,
  ].join(", ");
}

const chipBase =
  "relative flex min-w-0 cursor-pointer items-start gap-1.5 overflow-hidden rounded-sm text-left text-xs leading-4 text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]";

/**
 * A mark's look. Hover tints it: `hover:` on the control itself (Week
 * blocks), `group-hover:` on a chip's inner mark. Class names are written
 * out whole, so Tailwind finds them.
 */
const HOVER = {
  bar: {
    self: "hover:bg-[color-mix(in_oklab,var(--cal)_42%,var(--card))]",
    group: "group-hover:bg-[color-mix(in_oklab,var(--cal)_42%,var(--card))]",
  },
  outlined: {
    self: "hover:bg-[color-mix(in_oklab,var(--cal)_10%,var(--card))]",
    group: "group-hover:bg-[color-mix(in_oklab,var(--cal)_10%,var(--card))]",
  },
  ruled: { self: "hover:bg-accent", group: "group-hover:bg-accent" },
} as const;

function markClass(
  item: CalendarItem,
  bar: boolean,
  hover: "self" | "group",
  wraps = false,
): string {
  if (bar)
    return cn(
      "items-center bg-[color-mix(in_oklab,var(--cal)_32%,var(--card))] px-2.5 font-medium",
      // A pill that wraps to two lines keeps a softer corner.
      wraps ? "rounded-lg" : "rounded-full",
      HOVER.bar[hover],
    );
  if (item.kind === "source")
    return cn(
      "rounded-sm px-1.5 py-0.5 ring-1 ring-[var(--cal)] ring-inset",
      HOVER.outlined[hover],
    );
  if (item.kind === "due")
    return cn(
      "rounded-sm border border-dashed border-[var(--cal)] px-1.5 py-px",
      HOVER.outlined[hover],
    );
  return cn(
    "rounded-sm py-0.5 pr-1 pl-2 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[var(--cal)]",
    HOVER.ruled[hover],
  );
}

export function chipClass(item: CalendarItem, bar: boolean): string {
  return cn(chipBase, markClass(item, bar, "self"));
}

/**
 * One item in a month cell, the week's all-day row, or a day popover. The
 * button is the 24px target per line (WCAG 2.5.8); the mark inside it is
 * drawn 2px in from top and bottom, so stacked chips keep a gap.
 */
export function CalendarChip({
  item,
  calendar,
  region,
  bar = false,
  lines = 1,
  showTime = true,
  continuesBefore = false,
  continuesAfter = false,
  className,
  style,
  onOpen,
}: {
  item: CalendarItem;
  calendar: CalendarInfo | undefined;
  region: WorkspaceRegion;
  bar?: boolean;
  lines?: 1 | 2;
  showTime?: boolean;
  /** A bar that runs on from the previous or into the next week. */
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  className?: string;
  style?: CSSProperties;
  onOpen: OpenCalendarItem;
}) {
  const time =
    showTime && !item.allDay && item.startMinute !== null
      ? compactTime(item.startMinute, region)
      : null;
  return (
    <button
      type="button"
      data-calendar-item={item.kind}
      aria-label={itemAccessibleName(item, calendar, region)}
      title={`${item.kind === "due" ? "Due: " : ""}${item.title} · ${calendar?.name ?? ""}`}
      className={cn(
        "group text-foreground relative flex min-h-6 min-w-0 cursor-pointer rounded-sm py-0.5 text-left text-xs leading-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]",
        className,
      )}
      style={{ ...colorStyle(calendar?.color ?? "var(--ink-muted)"), ...style }}
      onClick={(event: MouseEvent<HTMLButtonElement>) =>
        onOpen(item, event.currentTarget)
      }
    >
      <span
        className={cn(
          "relative flex min-w-0 flex-1 items-start gap-1.5 overflow-hidden",
          markClass(item, bar, "group", lines === 2),
          continuesBefore && "rounded-l-none",
          continuesAfter && "rounded-r-none",
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1",
            lines === 2 ? "line-clamp-2 break-words" : "truncate",
          )}
        >
          {item.kind === "due" ? (
            <span className="text-muted-foreground">Due </span>
          ) : null}
          {item.title}
        </span>
        {time ? (
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {time}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** A square swatch in the calendar's color; outlined for record sources. */
export function CalendarSwatch({
  color,
  outlined = false,
  className,
}: {
  color: string;
  outlined?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={colorStyle(color)}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-xs",
        outlined
          ? "ring-[1.5px] ring-[var(--cal)] ring-inset"
          : "bg-[var(--cal)]",
        className,
      )}
    />
  );
}

/**
 * A 40px row (56px on phones) for Upcoming and a day's list: the time, the
 * title beside its calendar's swatch, then the calendar, location and repeat.
 */
export function CalendarRow({
  item,
  calendar,
  region,
  date,
  onOpen,
}: {
  item: CalendarItem;
  calendar: CalendarInfo | undefined;
  region: WorkspaceRegion;
  date: string;
  onOpen: OpenCalendarItem;
}) {
  const facts: ReactNode[] = [calendar?.name ?? "Calendar"];
  if (item.location) facts.push(item.location);
  return (
    <li>
      <button
        type="button"
        aria-label={itemAccessibleName(item, calendar, region)}
        onClick={(event) => onOpen(item, event.currentTarget)}
        className="hover:bg-accent focus-visible:outline-ring grid min-h-14 w-full grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b px-4 py-2 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 md:min-h-10 md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,15rem)] md:py-1.5"
      >
        <span className="text-muted-foreground text-xs tabular-nums">
          {itemWhen(item, region, date)}
        </span>
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <CalendarSwatch
            color={calendar?.color ?? "var(--ink-muted)"}
            outlined={item.kind !== "event"}
          />
          <span className="truncate">{item.title}</span>
        </span>
        <span className="text-muted-foreground col-start-2 flex min-w-0 items-center gap-1.5 text-xs md:col-start-auto">
          {facts.map((fact, index) => (
            <span key={index} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <span className="truncate">{fact}</span>
            </span>
          ))}
          {item.repeat !== "none" ? (
            <span className="flex shrink-0 items-center gap-1">
              <span aria-hidden="true">·</span>
              <Repeat aria-hidden="true" className="size-3.5" />
              {REPEAT_WORDS[item.repeat]}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

export const REPEAT_WORDS = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
} as const;
