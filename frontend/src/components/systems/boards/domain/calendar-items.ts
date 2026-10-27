import { Temporal } from "@js-temporal/polyfill";
import type { BoardEventOccurrencePage } from "../adapters/board-events-api";
import type { DueCard } from "../adapters/board-due-cards-api";
import { openViewRecordTitle } from "../../openview/domain/record-display";
import { formatWorkspaceClockTime } from "@/lib/date-time-display";
import type { WorkspaceRegion } from "@/lib/date-time-display";
import { addDays, type CalendarShow } from "./calendar-dates";

/**
 * One thing on a calendar day: an event occurrence, a record from a record
 * source, or a card's due date. Dates are calendar days in the item's own
 * zone (an event's zone, or the zone the record read returns), and minutes
 * count from that day's midnight. `endDate` is the last day the item covers;
 * `endMinute` is exclusive (1440 when it ends at the next midnight).
 */
export type CalendarItem = {
  key: string;
  calendarId: string;
  kind: "event" | "source" | "due";
  title: string;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startMinute: number | null;
  endMinute: number | null;
  location: string;
  repeat: "none" | "daily" | "weekly" | "monthly";
  authorId: string | null;
  target:
    | { kind: "event"; eventId: string; occurrenceDate: string }
    | { kind: "record"; moduleId: string; recordId: string }
    | { kind: "card"; cardId: string };
};

/**
 * A calendar's color: its department mark, or neutral ink for Company and
 * project calendars (BR53). The name always stands beside it elsewhere.
 */
export type CalendarTone =
  { kind: "department"; tone: 1 | 2 | 3 | 4 } | { kind: "neutral" };

export function calendarColor(tone: CalendarTone): string {
  return tone.kind === "department"
    ? `var(--dept-${tone.tone})`
    : "var(--ink-muted)";
}

type Occurrence = BoardEventOccurrencePage["items"][number];

/** A record source point (a datetime) is drawn as a 30-minute block. */
const POINT_MINUTES = 30;

function localParts(
  instant: string,
  timezone: string,
): { date: string; minute: number } {
  const local = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
  return {
    date: local.toPlainDate().toString(),
    minute: local.hour * 60 + local.minute,
  };
}

export function occurrenceItems(
  occurrences: readonly Occurrence[],
  calendarId: string,
): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const occurrence of occurrences) {
    const { event } = occurrence;
    const base = {
      key: occurrence.id,
      calendarId,
      kind: "event" as const,
      title: event.title,
      location: event.location,
      repeat: event.recurrence,
      authorId: event.authorId,
      target: {
        kind: "event" as const,
        eventId: event.id,
        occurrenceDate: occurrence.date,
      },
    };
    if (event.allDay) {
      items.push({
        ...base,
        startDate: occurrence.start,
        endDate: occurrence.end,
        allDay: true,
        startMinute: null,
        endMinute: null,
      });
      continue;
    }
    try {
      const start = localParts(occurrence.start, event.timezoneName);
      const end = localParts(occurrence.end, event.timezoneName);
      // Ending exactly at a midnight keeps the event on the day before.
      const endsAtMidnight = end.minute === 0 && end.date > start.date;
      items.push({
        ...base,
        startDate: start.date,
        endDate: endsAtMidnight ? addDays(end.date, -1) : end.date,
        allDay: false,
        startMinute: start.minute,
        endMinute: endsAtMidnight ? 1440 : end.minute,
      });
    } catch {
      // An occurrence whose zone cannot be read is left out, never misplaced.
    }
  }
  return items;
}

export type RecordSourceSpec = {
  id: string;
  moduleId: string;
  dateFieldId: string;
  fieldType: "date" | "datetime";
  titleFieldId: string | null;
};

export type SourceRecord = {
  id: string;
  data: Record<string, unknown>;
  displayValues: Record<string, string>;
};

export function recordItems(
  records: readonly SourceRecord[],
  source: RecordSourceSpec,
  timezone: string | null,
  calendarId: string,
): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const record of records) {
    const value = record.data[source.dateFieldId];
    if (typeof value !== "string" || !value) continue;
    const base = {
      key: `${calendarId}:${record.id}`,
      calendarId,
      kind: "source" as const,
      title: openViewRecordTitle(record, source.titleFieldId),
      location: "",
      repeat: "none" as const,
      authorId: null,
      target: {
        kind: "record" as const,
        moduleId: source.moduleId,
        recordId: record.id,
      },
    };
    if (source.fieldType === "date" || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      items.push({
        ...base,
        startDate: value.slice(0, 10),
        endDate: value.slice(0, 10),
        allDay: true,
        startMinute: null,
        endMinute: null,
      });
      continue;
    }
    try {
      const start = localParts(value, timezone ?? "UTC");
      items.push({
        ...base,
        startDate: start.date,
        endDate: start.date,
        allDay: false,
        startMinute: start.minute,
        endMinute: Math.min(1440, start.minute + POINT_MINUTES),
      });
    } catch {
      // A value the zone cannot place is left out.
    }
  }
  return items;
}

export const LOCKED_CARD_TITLE = "No access to this record";

export function dueCardTitle(card: DueCard): string {
  if (card.record?.locked) return LOCKED_CARD_TITLE;
  if (card.record) return card.record.title;
  return card.title ?? "Untitled card";
}

export function dueCardItems(
  cards: readonly DueCard[],
  calendarId: string,
): CalendarItem[] {
  return cards.map((card) => ({
    key: `${calendarId}:${card.id}`,
    calendarId,
    kind: "due",
    title: dueCardTitle(card),
    startDate: card.dueOn,
    endDate: card.dueOn,
    allDay: true,
    startMinute: null,
    endMinute: null,
    location: "",
    repeat: "none",
    authorId: null,
    target: { kind: "card", cardId: card.id },
  }));
}

/** Hidden calendars, Created by me, and the search apply in the browser. */
export function filterCalendarItems(
  items: readonly CalendarItem[],
  options: {
    hidden: ReadonlySet<string>;
    show: CalendarShow;
    viewerId: string | null;
    search: string;
  },
): CalendarItem[] {
  const search = options.search.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      !options.hidden.has(item.calendarId) &&
      (options.show !== "mine" ||
        (item.kind === "event" && item.authorId === options.viewerId)) &&
      (!search || item.title.toLocaleLowerCase().includes(search)),
  );
}

/** All-day items first, then by start time, then by title. */
export function compareCalendarItems(
  left: CalendarItem,
  right: CalendarItem,
): number {
  return (
    Number(!left.allDay) - Number(!right.allDay) ||
    (left.startMinute ?? -1) - (right.startMinute ?? -1) ||
    left.title.localeCompare(right.title)
  );
}

export function touchesDay(item: CalendarItem, date: string): boolean {
  return item.startDate <= date && date <= item.endDate;
}

/** Every item on one day, in reading order. */
export function itemsOnDay(
  items: readonly CalendarItem[],
  date: string,
): CalendarItem[] {
  return items
    .filter((item) => touchesDay(item, date))
    .sort(compareCalendarItems);
}

/**
 * Upcoming (BR19): from today forward, grouped by day. An item that runs
 * over several days shows once, on its first day from today.
 */
export function upcomingGroups(
  items: readonly CalendarItem[],
  from: string,
): { date: string; items: CalendarItem[] }[] {
  const groups = new Map<string, CalendarItem[]>();
  for (const item of items) {
    if (item.endDate < from) continue;
    const date = item.startDate < from ? from : item.startDate;
    groups.set(date, [...(groups.get(date) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, list]) => ({ date, items: list.sort(compareCalendarItems) }));
}

/** The empty month's status (BR43, FN2): the next event, or none. */
export function calendarEmptyStatus(
  month: string,
  next: string | null,
): { message: string; next: { text: string; name: string } | null } {
  if (next === null) return { message: "No upcoming events", next: null };
  return {
    message: `No events in ${month}`,
    next: { text: `Next: ${next}`, name: `Go to the next event, ${next}` },
  };
}

/** "HH:MM" for a minute of the day. */
export function clockText(minute: number): string {
  const bounded = Math.max(0, Math.min(1439, minute));
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

/** A time short enough for a month chip: "9am", "10:30am", or "13:00". */
export function compactTime(
  minute: number,
  region: Pick<WorkspaceRegion, "locale" | "timeFormat">,
): string {
  const full = formatWorkspaceClockTime(clockText(minute), region);
  const twelve = /^(\d{1,2})(?::(\d{2}))?\s?([AaPp])\.?\s?[Mm]\.?$/.exec(
    full.replace(/ | /g, " "),
  );
  if (!twelve) return full;
  const [, hour, minutes, meridiem] = twelve;
  return `${hour}${minutes && minutes !== "00" ? `:${minutes}` : ""}${meridiem.toLowerCase()}m`;
}
