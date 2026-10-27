import { expect, test } from "@playwright/test";
import type { BoardEventOccurrencePage } from "../../../src/components/systems/boards/adapters/board-events-api";
import {
  calendarEmptyStatus,
  compactTime,
  dueCardItems,
  filterCalendarItems,
  occurrenceItems,
  recordItems,
  upcomingGroups,
  type CalendarItem,
} from "../../../src/components/systems/boards/domain/calendar-items";
import {
  hiddenCalendarsKey,
  readHiddenCalendars,
  writeHiddenCalendars,
} from "../../../src/components/systems/boards/domain/hidden-calendars";

const boardId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const authorId = "00000000-0000-4000-8000-000000000003";
const otherAuthor = "00000000-0000-4000-8000-000000000004";
const moduleId = "00000000-0000-4000-8000-000000000005";
const dateFieldId = "00000000-0000-4000-8000-000000000006";
const titleFieldId = "00000000-0000-4000-8000-000000000007";

type Occurrence = BoardEventOccurrencePage["items"][number];
const event: Occurrence["event"] = {
  id: eventId,
  boardId,
  authorId,
  title: "Account review",
  details: "",
  location: "Room 2",
  links: [],
  allDay: false,
  startDate: null,
  endDate: null,
  startAt: "2026-11-02T01:00:00Z",
  endAt: "2026-11-02T02:30:00Z",
  timezoneName: "Asia/Manila",
  recurrence: "weekly",
  repeatUntil: "2026-12-28",
  reminders: [],
  archived: false,
  revision: 1,
  boardRevision: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

test("a timed occurrence takes its date and minutes in the event's own zone", () => {
  const [timed] = occurrenceItems(
    [
      {
        id: `${eventId}:2026-11-09`,
        eventId,
        date: "2026-11-09",
        start: "2026-11-09T01:00:00Z",
        end: "2026-11-09T02:30:00Z",
        event,
      },
    ],
    "board:sales",
  );
  expect(timed).toMatchObject({
    key: `${eventId}:2026-11-09`,
    calendarId: "board:sales",
    kind: "event",
    title: "Account review",
    startDate: "2026-11-09",
    endDate: "2026-11-09",
    startMinute: 540,
    endMinute: 630,
    allDay: false,
    location: "Room 2",
    repeat: "weekly",
    authorId,
    target: { kind: "event", eventId, occurrenceDate: "2026-11-09" },
  });
});

test("a timed occurrence ending exactly at midnight stays on its first day", () => {
  const [late] = occurrenceItems(
    [
      {
        id: `${eventId}:2026-11-09`,
        eventId,
        date: "2026-11-09",
        start: "2026-11-09T14:00:00Z",
        end: "2026-11-09T16:00:00Z",
        event: { ...event, recurrence: "none", repeatUntil: null },
      },
    ],
    "board:sales",
  );
  expect([late?.startDate, late?.endDate, late?.endMinute]).toEqual([
    "2026-11-09",
    "2026-11-09",
    1440,
  ]);
});

test("an all-day occurrence keeps its inclusive dates", () => {
  const [allDay] = occurrenceItems(
    [
      {
        id: `${eventId}:2026-11-18`,
        eventId,
        date: "2026-11-18",
        start: "2026-11-18",
        end: "2026-11-20",
        event: {
          ...event,
          allDay: true,
          startDate: "2026-11-18",
          endDate: "2026-11-20",
          startAt: null,
          endAt: null,
          recurrence: "none",
          repeatUntil: null,
        },
      },
    ],
    "board:sales",
  );
  expect(allDay).toMatchObject({
    startDate: "2026-11-18",
    endDate: "2026-11-20",
    allDay: true,
    startMinute: null,
    endMinute: null,
  });
});

test("records place on their date field; a datetime uses the read's zone; undated records are left out", () => {
  const source = {
    id: "quotes",
    moduleId,
    dateFieldId,
    fieldType: "datetime" as const,
    titleFieldId,
  };
  const items = recordItems(
    [
      {
        id: "r1",
        data: { [dateFieldId]: "2026-11-05T02:00:00Z", [titleFieldId]: "Q-1" },
        displayValues: { [titleFieldId]: "Q-24112 Pacific Rim" },
      },
      { id: "r2", data: { [dateFieldId]: null }, displayValues: {} },
    ],
    source,
    "Asia/Manila",
    "source:quotes",
  );
  expect(items).toEqual([
    {
      key: "source:quotes:r1",
      calendarId: "source:quotes",
      kind: "source",
      title: "Q-24112 Pacific Rim",
      startDate: "2026-11-05",
      endDate: "2026-11-05",
      allDay: false,
      startMinute: 600,
      endMinute: 630,
      location: "",
      repeat: "none",
      authorId: null,
      target: { kind: "record", moduleId, recordId: "r1" },
    },
  ]);
  const [dated] = recordItems(
    [{ id: "r3", data: { [dateFieldId]: "2026-11-13" }, displayValues: {} }],
    { ...source, fieldType: "date" },
    null,
    "source:quotes",
  );
  expect(dated).toMatchObject({
    title: "Record r3",
    allDay: true,
    startDate: "2026-11-13",
    startMinute: null,
  });
});

test("a due card shows its title, a locked record card shows no name", () => {
  const items = dueCardItems(
    [
      {
        id: "c1",
        kind: "objective",
        title: "Update the price list",
        dueOn: "2026-11-02",
        stageId: "s1",
        assigneeId: null,
        record: null,
      },
      {
        id: "c2",
        kind: "record",
        title: null,
        dueOn: "2026-11-03",
        stageId: "s1",
        assigneeId: null,
        record: { locked: true },
      },
      {
        id: "c3",
        kind: "record",
        title: null,
        dueOn: "2026-11-04",
        stageId: "s1",
        assigneeId: null,
        record: {
          locked: false,
          recordId: "r",
          moduleId,
          moduleName: "Quotes",
          title: "Q-24118 Cebu",
        },
      },
    ],
    "due:board",
  );
  expect(items.map((card) => [card.title, card.startDate, card.kind])).toEqual([
    ["Update the price list", "2026-11-02", "due"],
    ["No access to this record", "2026-11-03", "due"],
    ["Q-24118 Cebu", "2026-11-04", "due"],
  ]);
});

function plain(key: string, patch: Partial<CalendarItem>): CalendarItem {
  return {
    key,
    calendarId: "board:sales",
    kind: "event",
    title: key,
    startDate: "2026-11-02",
    endDate: "2026-11-02",
    allDay: false,
    startMinute: 540,
    endMinute: 600,
    location: "",
    repeat: "none",
    authorId,
    target: { kind: "event", eventId: key, occurrenceDate: "2026-11-02" },
    ...patch,
  };
}

test("hidden calendars, Created by me, and search filter in the browser", () => {
  const items = [
    plain("Mine", {}),
    plain("Theirs", { authorId: otherAuthor }),
    plain("Quote", { calendarId: "source:q", kind: "source", authorId: null }),
  ];
  const keys = (list: CalendarItem[]) => list.map((entry) => entry.key);
  expect(
    keys(
      filterCalendarItems(items, {
        hidden: new Set(["source:q"]),
        show: "all",
        viewerId: authorId,
        search: "",
      }),
    ),
  ).toEqual(["Mine", "Theirs"]);
  expect(
    keys(
      filterCalendarItems(items, {
        hidden: new Set(),
        show: "mine",
        viewerId: authorId,
        search: "",
      }),
    ),
  ).toEqual(["Mine"]);
  expect(
    keys(
      filterCalendarItems(items, {
        hidden: new Set(),
        show: "all",
        viewerId: authorId,
        search: " quo ",
      }),
    ),
  ).toEqual(["Quote"]);
});

test("Upcoming groups from today by day, all day first, a long event once", () => {
  const groups = upcomingGroups(
    [
      plain("later", { startDate: "2026-11-04", endDate: "2026-11-04" }),
      plain("past", { startDate: "2026-10-30", endDate: "2026-10-30" }),
      plain("expo", {
        allDay: true,
        startDate: "2026-10-31",
        endDate: "2026-11-03",
        startMinute: null,
        endMinute: null,
      }),
      plain("noon", { startMinute: 720 }),
      plain("morning", { startMinute: 480 }),
    ],
    "2026-11-02",
  );
  expect(
    groups.map(({ date, items }) => [date, items.map((entry) => entry.key)]),
  ).toEqual([
    ["2026-11-02", ["expo", "morning", "noon"]],
    ["2026-11-04", ["later"]],
  ]);
});

test("the empty month names the next event, or says there is none", () => {
  expect(calendarEmptyStatus("October", "Mon, Nov 2")).toEqual({
    message: "No events in October",
    next: {
      text: "Next: Mon, Nov 2",
      name: "Go to the next event, Mon, Nov 2",
    },
  });
  expect(calendarEmptyStatus("October", null)).toEqual({
    message: "No upcoming events",
    next: null,
  });
});

test("compact times drop zero minutes in a 12-hour clock and keep a 24-hour clock", () => {
  const twelve = { locale: "en-US", timeFormat: "12h" as const };
  expect(compactTime(540, twelve)).toBe("9am");
  expect(compactTime(630, twelve)).toBe("10:30am");
  expect(compactTime(780, twelve)).toBe("1pm");
  expect(compactTime(780, { locale: "en-US", timeFormat: "24h" })).toBe(
    "13:00",
  );
});

test("hidden calendars persist per viewer and board, and a blocked store hides nothing", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const key = hiddenCalendarsKey(authorId, boardId);
  expect(key).toBe(`openslate.boards.calendar.hidden.${authorId}.${boardId}`);
  writeHiddenCalendars(() => storage, key, ["source:q", "due:board"]);
  expect(readHiddenCalendars(() => storage, key)).toEqual([
    "source:q",
    "due:board",
  ]);
  const blocked = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  expect(readHiddenCalendars(blocked, key)).toEqual([]);
  expect(() => writeHiddenCalendars(blocked, key, ["x"])).not.toThrow();
  values.set(key, "{not json");
  expect(readHiddenCalendars(() => storage, key)).toEqual([]);
  values.set(key, JSON.stringify([1, "ok"]));
  expect(readHiddenCalendars(() => storage, key)).toEqual(["ok"]);
});
