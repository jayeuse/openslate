"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { formatWorkspaceDate, type WorkspaceRegion } from "@/lib/date-time";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import {
  isoWeek,
  isWeekend,
  monthOf,
  moveDayFocus,
  type WeekStart,
} from "../domain/calendar-dates";
import { itemsOnDay, type CalendarItem } from "../domain/calendar-items";
import { layoutMonthWeek } from "../domain/calendar-month-layout";
import {
  CalendarChip,
  CalendarRow,
  colorStyle,
  dayLabel,
  type CalendarInfo,
  type OpenCalendarItem,
} from "./board-calendar-chips";

/**
 * One lane is a 24px target (WCAG 2.5.8); the day number takes the first.
 * Chips draw their mark 2px in, so lanes need no gap.
 */
const LANE = 24;
const FALLBACK_LANES = 4;

function weekdayNames(days: readonly string[], region: WorkspaceRegion) {
  return days.map((date) => ({
    date,
    name: formatWorkspaceDate(date, region, { weekday: "short" }),
  }));
}

type MonthProps = {
  grid: string[][];
  anchor: string;
  today: string | null;
  weekStart: WeekStart;
  label: string;
  items: readonly CalendarItem[];
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: WorkspaceRegion;
  onOpen: OpenCalendarItem;
  onShowDay: (date: string) => void;
  /** Why the month is empty, with its one step, centered on the grid. */
  empty?: ReactNode;
};

/**
 * Month like Fantastical (BR54, BR55): six week rows share the panel's
 * height from 1280px; lanes are measured, so titles take two lines while a
 * day has room, and the rest go to "+n more".
 */
export function BoardCalendarMonth(props: MonthProps) {
  const { grid, label, region } = props;
  const weeksRef = useRef<HTMLDivElement>(null);
  // Focus returns to the "+n more" that opened the day.
  const moreRef = useRef<HTMLElement | null>(null);
  const [lanes, setLanes] = useState(FALLBACK_LANES);
  // The day numbers are one Tab stop; arrow keys move between them.
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const days = grid.flat();
  const tabDay =
    focusDay && days.includes(focusDay)
      ? focusDay
      : props.today && days.includes(props.today)
        ? props.today
        : `${monthOf(props.anchor)}-01`;
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const next = moveDayFocus(date, event.key, props.weekStart);
    if (!next || !days.includes(next)) return;
    event.preventDefault();
    setFocusDay(next);
    weeksRef.current
      ?.querySelector<HTMLButtonElement>(`[data-month-day="${next}"]`)
      ?.focus();
  }
  const [moreDay, setMoreDay] = useState<{
    date: string;
    anchor: HTMLElement;
  } | null>(null);

  useLayoutEffect(() => {
    const element = weeksRef.current;
    if (!element) return;
    const measure = () => {
      // The row's inner height, without its rule; lanes that would be cut
      // go to "+n more" instead.
      const row = element.firstElementChild?.clientHeight;
      if (!row) return;
      setLanes(Math.max(1, Math.floor((row - LANE) / LANE)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const moreItems = moreDay ? itemsOnDay(props.items, moreDay.date) : [];
  return (
    // A week row never drops below a day number and two 24px lanes (73px
    // with its rule): when an alert above shortens the page, the panel
    // scrolls instead of hiding every bar behind "+n more".
    <section
      aria-label={`${label} calendar`}
      className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border xl:flex-1"
    >
      <div className="text-muted-foreground grid h-6 shrink-0 grid-cols-7 items-center border-b text-xs font-medium">
        {weekdayNames(grid[0], region).map(({ date, name }) => (
          <span key={date} className="px-2">
            {name}
          </span>
        ))}
      </div>
      <div
        ref={weeksRef}
        className="relative grid grid-rows-[repeat(6,7rem)] xl:flex-1 xl:grid-rows-[repeat(6,minmax(73px,1fr))]"
      >
        {grid.map((week) => (
          <MonthWeekRow
            key={week[0]}
            {...props}
            days={week}
            lanes={lanes}
            tabDay={tabDay}
            onDayKey={moveFocus}
            onDayFocus={setFocusDay}
            onMore={(date, anchor) => {
              moreRef.current = anchor;
              setMoreDay({ date, anchor });
            }}
          />
        ))}
        {props.empty ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
            <div className="bg-card pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-lg border px-4 py-2 text-sm shadow-xs">
              {props.empty}
            </div>
          </div>
        ) : null}
      </div>
      <Popover
        open={moreDay !== null}
        onOpenChange={(open) => {
          if (!open) setMoreDay(null);
        }}
      >
        <PopoverContent
          anchor={moreDay?.anchor}
          finalFocus={moreRef}
          align="start"
          className="slim-ui w-64 gap-1.5"
        >
          <PopoverTitle className="text-sm">
            {moreDay ? dayLabel(moreDay.date, region) : ""}
          </PopoverTitle>
          <div className="flex flex-col gap-0.5">
            {moreItems.map((item) => (
              <CalendarChip
                key={item.key}
                item={item}
                calendar={props.calendars.get(item.calendarId)}
                region={region}
                bar={item.kind === "event" && item.allDay}
                onOpen={(entry, anchor) => {
                  setMoreDay(null);
                  props.onOpen(entry, anchor);
                }}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </section>
  );
}

function MonthWeekRow({
  days,
  lanes,
  anchor,
  today,
  items,
  calendars,
  region,
  onOpen,
  onShowDay,
  onMore,
  tabDay,
  onDayKey,
  onDayFocus,
}: MonthProps & {
  days: string[];
  lanes: number;
  onMore: (date: string, anchor: HTMLElement) => void;
  tabDay: string;
  onDayKey: (event: KeyboardEvent<HTMLButtonElement>, date: string) => void;
  onDayFocus: (date: string) => void;
}) {
  const month = monthOf(anchor);
  const layout = layoutMonthWeek(days, items, lanes);
  const monday = days.findIndex(
    (date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 1,
  );
  return (
    <div className="relative min-h-0 overflow-hidden border-b last:border-b-0">
      <div aria-hidden="true" className="absolute inset-0 grid grid-cols-7">
        {days.map((date) => (
          <span
            key={date}
            className={cn(
              "border-l first:border-l-0",
              (monthOf(date) !== month || isWeekend(date)) &&
                "bg-[color-mix(in_oklab,var(--surface-sunken)_45%,transparent)]",
            )}
          />
        ))}
      </div>
      <div className="relative grid auto-rows-[24px] grid-cols-7 content-start">
        {days.map((date, column) => (
          <button
            key={date}
            type="button"
            data-month-day={date}
            tabIndex={date === tabDay ? 0 : -1}
            aria-label={`${dayLabel(date, region)}, show week`}
            aria-current={date === today ? "date" : undefined}
            onClick={() => onShowDay(date)}
            onKeyDown={(event) => onDayKey(event, date)}
            onFocus={() => onDayFocus(date)}
            style={{ gridColumn: column + 1, gridRow: 1 }}
            className={cn(
              "hover:bg-accent focus-visible:outline-ring ml-1 grid h-6 min-w-6 place-items-center justify-self-start rounded-full px-1.5 text-xs font-medium tabular-nums outline-none focus-visible:outline-2 focus-visible:-outline-offset-2",
              monthOf(date) !== month && "text-muted-foreground",
              date === today &&
                "bg-foreground text-background hover:bg-foreground font-semibold",
            )}
          >
            {Number(date.slice(8))}
          </button>
        ))}
        {monday >= 0 ? (
          <span
            style={{ gridColumn: monday + 1, gridRow: 1 }}
            className="text-muted-foreground mr-2 self-center justify-self-end text-xs tabular-nums"
          >
            <span aria-hidden="true">W{isoWeek(days[monday])}</span>
            <span className="sr-only">Week {isoWeek(days[monday])}</span>
          </span>
        ) : null}
        {layout.bars.map((bar) => (
          <CalendarChip
            key={`${bar.item.key}:bar`}
            item={bar.item}
            calendar={calendars.get(bar.item.calendarId)}
            region={region}
            bar
            continuesBefore={bar.continuesBefore}
            continuesAfter={bar.continuesAfter}
            onOpen={onOpen}
            className={cn(
              "mx-[3px]",
              bar.continuesBefore && "ml-0",
              bar.continuesAfter && "mr-0",
            )}
            style={{
              gridColumn: `${bar.start + 1} / ${bar.end + 2}`,
              gridRow: bar.lane + 2,
            }}
          />
        ))}
        {layout.cells.flatMap((cell) => [
          ...cell.chips.map((chip) => (
            <CalendarChip
              key={`${cell.date}:${chip.item.key}`}
              item={chip.item}
              calendar={calendars.get(chip.item.calendarId)}
              region={region}
              lines={chip.lines}
              // A one-day all-day event keeps its pill (BR54).
              bar={chip.item.kind === "event" && chip.item.allDay}
              onOpen={onOpen}
              className="mx-[3px]"
              style={{
                gridColumn: cell.column + 1,
                gridRow: `${chip.lane + 2} / span ${chip.lines}`,
              }}
            />
          )),
          cell.more ? (
            <button
              key={`${cell.date}:more`}
              type="button"
              aria-label={`${cell.more.count} more on ${dayLabel(cell.date, region)}`}
              aria-haspopup="dialog"
              onClick={(event) => onMore(cell.date, event.currentTarget)}
              style={{
                gridColumn: cell.column + 1,
                gridRow: cell.more.lane + 2,
              }}
              className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring mx-[3px] h-6 justify-self-start rounded-sm px-1.5 text-xs leading-6 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              +{cell.more.count} more
            </button>
          ) : null,
        ])}
      </div>
    </div>
  );
}

/**
 * Phones (BR59): a compact grid with up to three dots per day in its
 * calendars' colors, then the selected day's rows, which name the calendars.
 */
export function BoardCalendarPhoneMonth({
  grid,
  anchor,
  today,
  label,
  items,
  calendars,
  region,
  selected,
  onSelect,
  onOpen,
}: Omit<MonthProps, "onShowDay" | "weekStart"> & {
  selected: string;
  onSelect: (date: string) => void;
}) {
  const month = monthOf(anchor);
  const dayItems = itemsOnDay(items, selected);
  return (
    <>
      <section
        aria-label={`${label} calendar`}
        className="bg-card overflow-hidden rounded-lg border"
      >
        <div className="text-muted-foreground grid h-8 grid-cols-7 items-center border-b text-center text-xs font-medium">
          {weekdayNames(grid[0], region).map(({ date, name }) => (
            <span key={date}>{name}</span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.flat().map((date) => {
            const onDay = itemsOnDay(items, date);
            return (
              <button
                key={date}
                type="button"
                aria-label={`${dayLabel(date, region)}, ${onDay.length} ${onDay.length === 1 ? "item" : "items"}`}
                aria-pressed={date === selected}
                aria-current={date === today ? "date" : undefined}
                onClick={() => onSelect(date)}
                className={cn(
                  "focus-visible:outline-ring flex min-h-12 flex-col items-center gap-1 border-t pt-1.5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2",
                  date === selected && "bg-accent",
                )}
              >
                <span
                  className={cn(
                    "grid h-6 min-w-7 place-items-center rounded-full text-sm font-medium tabular-nums",
                    monthOf(date) !== month && "text-muted-foreground",
                    date === today && "bg-foreground text-background",
                  )}
                >
                  {Number(date.slice(8))}
                </span>
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
      </section>
      <BoardCalendarDayList
        date={selected}
        today={today}
        items={dayItems}
        calendars={calendars}
        region={region}
        onOpen={onOpen}
      />
    </>
  );
}

/** One day's items in time order, with the calendars named (phones). */
export function BoardCalendarDayList({
  date,
  today,
  items,
  calendars,
  region,
  onOpen,
}: {
  date: string;
  today: string | null;
  items: readonly CalendarItem[];
  calendars: ReadonlyMap<string, CalendarInfo>;
  region: WorkspaceRegion;
  onOpen: OpenCalendarItem;
}) {
  return (
    <section
      aria-label="Selected day"
      className="bg-card overflow-hidden rounded-lg border"
    >
      <h3 className="text-muted-foreground bg-muted/40 border-b px-4 py-2 text-xs font-medium">
        {/* An empty day says so once, in the list below. */}
        {[
          dayLabel(date, region),
          ...(date === today ? ["Today"] : []),
          ...(items.length
            ? [`${items.length} ${items.length === 1 ? "item" : "items"}`]
            : []),
        ].join(" · ")}
      </h3>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <CalendarRow
              key={item.key}
              item={item}
              calendar={calendars.get(item.calendarId)}
              region={region}
              date={date}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground px-4 py-4 text-sm">
          Nothing on this day.
        </p>
      )}
    </section>
  );
}
