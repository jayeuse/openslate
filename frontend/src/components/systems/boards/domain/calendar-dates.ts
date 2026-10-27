/**
 * Plain calendar dates ("YYYY-MM-DD") for the board calendar: grids, weeks,
 * windows, and the `view` and `show` address values (BR51, BR16, BR44).
 * Dates are calendar days, never instants, so they are computed at UTC noon.
 */

export type CalendarView = "month" | "week" | "upcoming";
export type CalendarShow = "all" | "mine" | "archived";
export type WeekStart = "monday" | "sunday";
export type DateWindow = { start: string; end: string };

/** The occurrence read accepts at most 42 days; Upcoming reads this many. */
export const UPCOMING_WINDOW_DAYS = 42;

function toDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function toKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(value: string, amount: number): string {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toKey(date);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((toDate(end).getTime() - toDate(start).getTime()) / 864e5);
}

/** 0 for Sunday through 6 for Saturday. */
export function weekday(value: string): number {
  return toDate(value).getUTCDay();
}

export function isWeekend(value: string): boolean {
  const day = weekday(value);
  return day === 0 || day === 6;
}

export function startOfWeek(value: string, weekStart: WeekStart): string {
  const offset =
    weekStart === "monday" ? (weekday(value) + 6) % 7 : weekday(value);
  return addDays(value, -offset);
}

export function weekDays(value: string, weekStart: WeekStart): string[] {
  const first = startOfWeek(value, weekStart);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

export function monthOf(value: string): string {
  return value.slice(0, 7);
}

export function monthStart(value: string): string {
  return `${monthOf(value)}-01`;
}

export function monthEnd(value: string): string {
  const date = toDate(monthStart(value));
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return toKey(date);
}

/** Six weeks that hold the month, starting on the week start. */
export function monthGrid(value: string, weekStart: WeekStart): string[][] {
  const first = startOfWeek(monthStart(value), weekStart);
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(first, week * 7 + day)),
  );
}

/** The ISO week number, shown inside Monday's cell ("W45"). */
export function isoWeek(value: string): number {
  const date = toDate(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1, 12);
  return Math.floor((date.getTime() - yearStart) / 864e5 / 7) + 1;
}

/** The days a view reads: the month, the week, or Upcoming's first window. */
export function viewWindow(
  view: CalendarView,
  anchor: string,
  weekStart: WeekStart,
  today: string,
): DateWindow {
  if (view === "month")
    return { start: monthStart(anchor), end: monthEnd(anchor) };
  if (view === "week") {
    const days = weekDays(anchor, weekStart);
    return { start: days[0], end: days[6] };
  }
  return upcomingWindow(today, 0);
}

/** Upcoming reads 42 days at a time from today; Show later adds the next. */
export function upcomingWindow(today: string, index: number): DateWindow {
  const start = addDays(today, index * UPCOMING_WINDOW_DAYS);
  return { start, end: addDays(start, UPCOMING_WINDOW_DAYS - 1) };
}

/** Previous and next move a month or a week; Month keeps the first day. */
export function shiftAnchor(
  view: CalendarView,
  anchor: string,
  amount: number,
): string {
  if (view === "week") return addDays(anchor, amount * 7);
  const date = toDate(monthStart(anchor));
  date.setUTCMonth(date.getUTCMonth() + amount);
  return toKey(date);
}

/** An unknown or missing view opens Month, or the day list on a phone (BR59). */
export function parseCalendarView(
  value: string | null,
  phone: boolean,
): CalendarView {
  if (value === "month" || value === "week" || value === "upcoming")
    return value;
  return phone ? "week" : "month";
}

/** Show falls back to All when the person may not use the filter. */
export function parseCalendarShow(
  value: string | null,
  allowed: { mine: boolean; archived: boolean },
): CalendarShow {
  if (value === "mine" && allowed.mine) return "mine";
  if (value === "archived" && allowed.archived) return "archived";
  return "all";
}

/**
 * The day a grid key moves focus to (one Tab stop per grid): a day left or
 * right, a week up or down, and Home and End to the ends of the week. Null
 * for any other key.
 */
export function moveDayFocus(
  date: string,
  key: string,
  weekStart: WeekStart,
): string | null {
  if (key === "ArrowRight") return addDays(date, 1);
  if (key === "ArrowLeft") return addDays(date, -1);
  if (key === "ArrowDown") return addDays(date, 7);
  if (key === "ArrowUp") return addDays(date, -7);
  if (key === "Home") return startOfWeek(date, weekStart);
  if (key === "End") return addDays(startOfWeek(date, weekStart), 6);
  return null;
}
