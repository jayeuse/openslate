import type { CalendarItem } from "./calendar-items";
import { placeInLanes, weekSpans } from "./calendar-month-layout";

/**
 * Week anatomy (BR56): hours 6 AM to 9 PM down the left, opening at 7 AM;
 * an all-day row above; timed blocks sized by duration; overlapping blocks
 * side by side.
 */
export const WEEK_FIRST_HOUR = 6;
export const WEEK_LAST_HOUR = 21;
export const WEEK_OPEN_HOUR = 7;

export type DaySegment = { item: CalendarItem; start: number; end: number };

/** The timed part of each item on one day, cut at the day's edges. */
export function timedSegments(
  items: readonly CalendarItem[],
  date: string,
): DaySegment[] {
  return items
    .filter(
      (item) =>
        !item.allDay &&
        item.startMinute !== null &&
        item.endMinute !== null &&
        item.startDate <= date &&
        date <= item.endDate,
    )
    .map((item) => ({
      item,
      start: item.startDate === date ? (item.startMinute ?? 0) : 0,
      end: item.endDate === date ? (item.endMinute ?? 1440) : 1440,
    }))
    .filter((segment) => segment.end > segment.start)
    .sort(
      (left, right) =>
        left.start - right.start ||
        right.end - left.end ||
        left.item.title.localeCompare(right.item.title),
    );
}

/**
 * Overlapping blocks share their group's width: each block takes the first
 * free column, and every block of a group knows the group's column count.
 */
export function layoutDayColumns<T extends { start: number; end: number }>(
  blocks: readonly T[],
): (Omit<T, "start" | "end"> & { column: number; columns: number })[] {
  const sorted = [...blocks].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const placed: { block: T; column: number; group: number }[] = [];
  const groupColumns: number[] = [];
  let columnEnds: number[] = [];
  let groupEnd = -1;
  let group = -1;
  for (const block of sorted) {
    if (block.start >= groupEnd) {
      group += 1;
      columnEnds = [];
      groupColumns[group] = 0;
    }
    let column = columnEnds.findIndex((end) => end <= block.start);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = block.end;
    groupEnd = Math.max(groupEnd, block.end);
    groupColumns[group] = Math.max(groupColumns[group], column + 1);
    placed.push({ block, column, group });
  }
  return placed.map(({ block, column, group: index }) => {
    const rest: Partial<T> = { ...block };
    delete rest.start;
    delete rest.end;
    return {
      ...(rest as Omit<T, "start" | "end">),
      column,
      columns: groupColumns[index],
    };
  });
}

export type AllDayLane = {
  item: CalendarItem;
  start: number;
  end: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/** The all-day row: all-day events, record dates, and due cards in lanes. */
export function allDayLanes(
  days: readonly string[],
  items: readonly CalendarItem[],
): AllDayLane[] {
  const used: number[] = [];
  return weekSpans(
    days,
    items.filter((item) => item.allDay),
  ).map((span) => ({ ...span, lane: placeInLanes(span, used) }));
}

/**
 * The now label sits on the now line; an hour label within 20 minutes of it
 * (16px at 48px an hour) would be covered, so it hides, as in Outlook.
 */
export function hourLabelHidden(
  hour: number,
  nowMinute: number | null,
): boolean {
  return nowMinute !== null && Math.abs(nowMinute - hour * 60) < 20;
}

/** The shortest a Week block is drawn: 30 minutes, the 22px floor. */
export const WEEK_MIN_BLOCK_MINUTES = 30;

/**
 * One day's timed blocks in Week (BR56), with their columns. Columns are
 * laid out at each block's drawn height, so two short blocks never overlap;
 * `start` and `end` stay the real times for the labels.
 */
export function weekBlocks(
  items: readonly CalendarItem[],
  date: string,
): (DaySegment & { column: number; columns: number })[] {
  const segments = timedSegments(items, date);
  return layoutDayColumns(
    segments.map((segment, index) => ({
      index,
      start: segment.start,
      end: Math.max(segment.end, segment.start + WEEK_MIN_BLOCK_MINUTES),
    })),
  ).map(({ index, column, columns }) => ({
    ...segments[index],
    column,
    columns,
  }));
}
