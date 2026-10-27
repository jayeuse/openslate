import {
  compareCalendarItems,
  touchesDay,
  type CalendarItem,
} from "./calendar-items";

/**
 * Month anatomy (BR54, BR55), one week row at a time. A row has `lanes`
 * slots of one line each under the day numbers; the component measures them.
 *
 * - An all-day event is a bar across its days. Bars take the top lanes of the
 *   week, and never the last lane, which stays free for "+n more".
 * - Every other item (a timed event, a record, a due card) is a chip on each
 *   day it touches, below the week's bars.
 * - A chip takes two lines while the rest of its day still fits below it.
 * - What does not fit is counted in "+n more", hidden bars included.
 */

export type MonthBar = {
  item: CalendarItem;
  /** First and last column (0–6) inside this week. */
  start: number;
  end: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

export type MonthChip = { item: CalendarItem; lane: number; lines: 1 | 2 };

export type MonthCell = {
  date: string;
  column: number;
  chips: MonthChip[];
  more: { lane: number; count: number } | null;
};

export type MonthWeekLayout = { bars: MonthBar[]; cells: MonthCell[] };

export function isBarItem(item: CalendarItem): boolean {
  return item.kind === "event" && item.allDay;
}

type Span = {
  item: CalendarItem;
  start: number;
  end: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/** Spans of the items inside a 7-day row, longest first on a shared start. */
export function weekSpans(
  days: readonly string[],
  items: readonly CalendarItem[],
): Span[] {
  const first = days[0];
  const last = days[days.length - 1];
  return items
    .filter((item) => item.startDate <= last && item.endDate >= first)
    .map((item) => ({
      item,
      start: Math.max(0, days.indexOf(item.startDate)),
      end: item.endDate > last ? days.length - 1 : days.indexOf(item.endDate),
      continuesBefore: item.startDate < first,
      continuesAfter: item.endDate > last,
    }))
    .sort(
      (left, right) =>
        left.start - right.start ||
        right.end - left.end ||
        compareCalendarItems(left.item, right.item),
    );
}

/** The first lane where the span fits; lanes record their last used column. */
export function placeInLanes(
  span: Pick<Span, "start" | "end">,
  lanes: number[],
) {
  let lane = 0;
  while (lanes[lane] !== undefined && lanes[lane] >= span.start) lane += 1;
  lanes[lane] = span.end;
  return lane;
}

export function layoutMonthWeek(
  days: readonly string[],
  items: readonly CalendarItem[],
  lanes: number,
): MonthWeekLayout {
  const barLimit = Math.max(0, lanes - 1);
  const used: number[] = [];
  const bars: MonthBar[] = [];
  const hiddenBars: Span[] = [];
  for (const span of weekSpans(days, items.filter(isBarItem))) {
    const lane = placeInLanes(span, used);
    if (lane < barLimit) bars.push({ ...span, lane });
    else hiddenBars.push(span);
  }
  const barLanes = Math.min(barLimit, used.length);
  const cells = days.map((date, column): MonthCell => {
    const dayItems = items
      .filter((item) => !isBarItem(item) && touchesDay(item, date))
      .sort(compareCalendarItems);
    const hidden = hiddenBars.filter(
      (span) => span.start <= column && column <= span.end,
    ).length;
    const slots = lanes - barLanes;
    const fits = hidden === 0 && dayItems.length <= slots;
    const shown = fits ? dayItems.length : Math.max(0, slots - 1);
    const capacity = fits ? lanes : lanes - 1;
    const chips: MonthChip[] = [];
    let lane = barLanes;
    for (let index = 0; index < shown; index += 1) {
      const after = shown - index - 1;
      const lines = capacity - lane - 2 >= after ? 2 : 1;
      chips.push({ item: dayItems[index], lane, lines });
      lane += lines;
    }
    const count = dayItems.length - shown + hidden;
    return {
      date,
      column,
      chips,
      more: count > 0 && slots > 0 ? { lane: lanes - 1, count } : null,
    };
  });
  return { bars, cells };
}
