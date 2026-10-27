"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import { isWeekend } from "../domain/calendar-dates";
import {
  compactTime,
  itemsOnDay,
  type CalendarItem,
} from "../domain/calendar-items";
import {
  WEEK_FIRST_HOUR,
  WEEK_LAST_HOUR,
  WEEK_OPEN_HOUR,
  allDayLanes,
  hourLabelHidden,
  weekBlocks,
} from "../domain/calendar-week-layout";
import {
  CalendarChip,
  chipClass,
  colorStyle,
  dayLabel,
  itemAccessibleName,
  type CalendarInfo,
  type OpenCalendarItem,
} from "./board-calendar-chips";
import { BoardCalendarDayList } from "./board-calendar-month";

/** One hour is 48px tall. */
const HOUR = 48;

type WeekProps = {
  days: string[];
  label: string;
  today: string | null;
  /** The current minute of the day in the display zone, for the now line. */
  nowMinute: number | null;
  items: readonly CalendarItem[];
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: WorkspaceRegion;
  onOpen: OpenCalendarItem;
  /** Why a filtered week is empty, with its one step, over the grid. */
  empty?: ReactNode;
};

function minuteTop(minute: number): number {
  return ((minute - WEEK_FIRST_HOUR * 60) / 60) * HOUR;
}

/**
 * Week like Outlook (BR56): hours down the left from 6 AM to 9 PM, opening
 * at 7 AM; the all-day row above; blocks sized by duration, side by side when
 * they overlap; the current time as an ink line.
 */
export function BoardCalendarWeek({
  days,
  label,
  today,
  nowMinute,
  items,
  calendars,
  region,
  onOpen,
  empty,
}: WeekProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (bodyRef.current)
      // A little above 7 AM, so its hour label shows whole.
      bodyRef.current.scrollTop =
        (WEEK_OPEN_HOUR - WEEK_FIRST_HOUR) * HOUR - 10;
  }, []);
  const lanes = allDayLanes(days, items);
  const laneCount = Math.max(1, ...lanes.map((lane) => lane.lane + 1));
  const hours = Array.from(
    { length: WEEK_LAST_HOUR - WEEK_FIRST_HOUR },
    (_, index) => WEEK_FIRST_HOUR + index,
  );
  const height = (WEEK_LAST_HOUR - WEEK_FIRST_HOUR) * HOUR;
  return (
    <section
      aria-label={`${label} calendar`}
      className="bg-card relative flex min-w-0 flex-col overflow-hidden rounded-lg border xl:min-h-0 xl:flex-1"
    >
      {empty ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center p-4">
          <div className="bg-card pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-lg border px-4 py-2 text-sm shadow-xs">
            {empty}
          </div>
        </div>
      ) : null}
      <div className="grid h-11 shrink-0 grid-cols-[64px_repeat(7,minmax(0,1fr))] items-center border-b">
        <span />
        {days.map((date) => (
          <span
            key={date}
            className="text-muted-foreground flex items-baseline gap-1.5 px-2 text-xs font-medium"
          >
            {formatWorkspaceDate(date, region, { weekday: "short" })}
            <b
              aria-current={date === today ? "date" : undefined}
              className={cn(
                "text-foreground text-base leading-none font-semibold tabular-nums",
                date === today &&
                  "bg-foreground text-background rounded-full px-1.5 py-0.5",
              )}
            >
              {Number(date.slice(8))}
            </b>
          </span>
        ))}
      </div>
      <div
        className="grid shrink-0 grid-cols-[64px_repeat(7,minmax(0,1fr))] border-b py-1"
        style={{ gridTemplateRows: `repeat(${laneCount}, 24px)` }}
      >
        <span
          className="text-muted-foreground self-center pl-2 text-xs"
          style={{ gridColumn: 1, gridRow: 1 }}
        >
          All day
        </span>
        {lanes.map((lane) => (
          <CalendarChip
            key={lane.item.key}
            item={lane.item}
            calendar={calendars.get(lane.item.calendarId)}
            region={region}
            bar={lane.item.kind === "event"}
            continuesBefore={lane.continuesBefore}
            continuesAfter={lane.continuesAfter}
            onOpen={onOpen}
            className={cn(
              "mx-[3px]",
              lane.continuesBefore && "ml-0",
              lane.continuesAfter && "mr-0",
            )}
            style={{
              gridColumn: `${lane.start + 2} / ${lane.end + 3}`,
              gridRow: lane.lane + 1,
            }}
          />
        ))}
      </div>
      <div
        ref={bodyRef}
        className="max-h-[36rem] min-h-0 overflow-y-auto overscroll-contain xl:max-h-none xl:flex-1"
      >
        <div
          className="relative grid grid-cols-[64px_repeat(7,minmax(0,1fr))]"
          style={{ height }}
        >
          <div className="relative">
            {hours.map((hour) =>
              hour === WEEK_FIRST_HOUR ||
              // The now label covers an hour label next to it (Outlook).
              (days.includes(today ?? "") &&
                hourLabelHidden(hour, nowMinute)) ? null : (
                <span
                  key={hour}
                  className="text-muted-foreground absolute right-2 -translate-y-1/2 text-xs whitespace-nowrap tabular-nums"
                  style={{ top: minuteTop(hour * 60) }}
                >
                  {compactTime(hour * 60, region)}
                </span>
              ),
            )}
            {nowMinute !== null && days.includes(today ?? "") ? (
              <span
                className="bg-foreground text-background absolute right-1 z-10 -translate-y-1/2 rounded-[3px] px-1 text-xs font-semibold whitespace-nowrap tabular-nums"
                style={{ top: minuteTop(nowMinute) }}
              >
                {compactTime(nowMinute, region)}
              </span>
            ) : null}
          </div>
          {days.map((date) => (
            <DayColumn
              key={date}
              date={date}
              today={today}
              nowMinute={nowMinute}
              items={items}
              calendars={calendars}
              region={region}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function DayColumn({
  date,
  today,
  nowMinute,
  items,
  calendars,
  region,
  onOpen,
}: {
  date: string;
  today: string | null;
  nowMinute: number | null;
  items: readonly CalendarItem[];
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: WorkspaceRegion;
  onOpen: OpenCalendarItem;
}) {
  const placed = weekBlocks(items, date);
  const first = WEEK_FIRST_HOUR * 60;
  const last = WEEK_LAST_HOUR * 60;
  return (
    <div
      aria-label={dayLabel(date, region)}
      role="group"
      className={cn(
        "relative border-l bg-[linear-gradient(var(--rule)_1px,transparent_1px)] bg-[length:100%_48px]",
        isWeekend(date) &&
          "bg-[color-mix(in_oklab,var(--surface-sunken)_45%,transparent)]",
      )}
    >
      {placed.map((segment) => {
        const { item, column, columns } = segment;
        const start = Math.max(first, Math.min(last - 15, segment.start));
        const end = Math.min(last, Math.max(start + 15, segment.end));
        const calendar = calendars.get(item.calendarId);
        return (
          <button
            key={item.key}
            type="button"
            aria-label={itemAccessibleName(item, calendar, region)}
            title={`${item.title} · ${calendar?.name ?? ""}`}
            onClick={(event) => onOpen(item, event.currentTarget)}
            style={{
              ...colorStyle(calendar?.color ?? "var(--ink-muted)"),
              top: minuteTop(start),
              height: Math.max(22, ((end - start) / 60) * HOUR - 2),
              left: `calc(${(column / columns) * 100}% + 3px)`,
              width: `calc(${100 / columns}% - 6px)`,
            }}
            className={cn(
              chipClass(item, false),
              "absolute flex-col gap-0 px-1.5 py-1 pl-2.5",
              // Hover rings the block: a darker fill would drop the muted
              // time below AA.
              item.kind === "event" &&
                "bg-[color-mix(in_oklab,var(--cal)_22%,var(--card))] hover:bg-[color-mix(in_oklab,var(--cal)_22%,var(--card))] hover:ring-1 hover:ring-[var(--cal)] hover:ring-inset",
            )}
          >
            <b className="w-full truncate font-semibold">{item.title}</b>
            <span className="text-muted-foreground w-full truncate tabular-nums">
              {compactTime(segment.start, region)}
              {item.kind === "event"
                ? `–${compactTime(segment.end === 1440 ? 1439 : segment.end, region)}`
                : ""}
              {item.location ? ` · ${item.location}` : ""}
            </span>
          </button>
        );
      })}
      {date === today && nowMinute !== null ? (
        <span
          aria-hidden="true"
          className="border-foreground pointer-events-none absolute inset-x-0 z-10 border-t-2 before:absolute before:-top-[6px] before:-left-[5px] before:size-2.5 before:rounded-full before:bg-[var(--ink)]"
          style={{ top: minuteTop(nowMinute) }}
        />
      ) : null}
    </div>
  );
}

/**
 * Phones (BR59): Week becomes a day list, a 7-day strip with dots, then the
 * selected day's items in time order.
 */
export function BoardCalendarPhoneWeek({
  days,
  today,
  items,
  calendars,
  region,
  selected,
  onSelect,
  onOpen,
}: Omit<WeekProps, "label" | "nowMinute"> & {
  selected: string;
  onSelect: (date: string) => void;
}) {
  return (
    <>
      <div
        role="group"
        aria-label="Days of this week"
        className="grid grid-cols-7 gap-0.5"
      >
        {days.map((date) => {
          const onDay = itemsOnDay(items, date);
          return (
            <button
              key={date}
              type="button"
              aria-pressed={date === selected}
              aria-label={`${dayLabel(date, region)}, ${onDay.length} ${onDay.length === 1 ? "item" : "items"}`}
              aria-current={date === today ? "date" : undefined}
              onClick={() => onSelect(date)}
              className={cn(
                "focus-visible:outline-ring grid min-h-15 justify-items-center gap-0.5 rounded-md py-1.5 outline-none focus-visible:outline-2",
                date === selected && "bg-accent",
              )}
            >
              <span className="text-muted-foreground text-xs">
                {formatWorkspaceDate(date, region, { weekday: "short" })}
              </span>
              <b
                className={cn(
                  "min-w-7 rounded-full text-center text-base leading-6 font-semibold tabular-nums",
                  date === today && "bg-foreground text-background",
                )}
              >
                {Number(date.slice(8))}
              </b>
              <span aria-hidden="true" className="flex h-1.5 gap-[3px]">
                {onDay.slice(0, 3).map((item) => (
                  <i
                    key={item.key}
                    style={colorStyle(
                      calendars.get(item.calendarId)?.color ??
                        "var(--ink-muted)",
                    )}
                    className={cn(
                      "block size-1.5 rounded-full",
                      item.kind === "event"
                        ? "bg-[var(--cal)]"
                        : "ring-[1.5px] ring-[var(--cal)] ring-inset",
                    )}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <BoardCalendarDayList
        date={selected}
        today={today}
        items={itemsOnDay(items, selected)}
        calendars={calendars}
        region={region}
        onOpen={onOpen}
      />
    </>
  );
}
