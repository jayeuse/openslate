import { expect, test } from "@playwright/test";
import type { CalendarItem } from "../../../src/components/systems/boards/domain/calendar-items";
import { layoutMonthWeek } from "../../../src/components/systems/boards/domain/calendar-month-layout";
import {
  allDayLanes,
  layoutDayColumns,
  timedSegments,
} from "../../../src/components/systems/boards/domain/calendar-week-layout";

const week = [
  "2026-11-16",
  "2026-11-17",
  "2026-11-18",
  "2026-11-19",
  "2026-11-20",
  "2026-11-21",
  "2026-11-22",
];

function item(
  key: string,
  patch: Partial<CalendarItem> & Pick<CalendarItem, "startDate">,
): CalendarItem {
  return {
    key,
    calendarId: "board:sales",
    kind: "event",
    title: key,
    endDate: patch.startDate,
    allDay: false,
    startMinute: 540,
    endMinute: 600,
    location: "",
    repeat: "none",
    authorId: null,
    target: { kind: "event", eventId: key, occurrenceDate: patch.startDate },
    ...patch,
  };
}

test("a multi-day all-day event runs across its days and continues into the next week", () => {
  const expo = item("expo", {
    allDay: true,
    startDate: "2026-11-18",
    endDate: "2026-11-24",
    startMinute: null,
    endMinute: null,
  });
  const earlier = item("earlier", {
    allDay: true,
    startDate: "2026-11-12",
    endDate: "2026-11-17",
    startMinute: null,
    endMinute: null,
  });
  const layout = layoutMonthWeek(week, [expo, earlier], 5);
  expect(
    layout.bars.map(({ item: bar, ...placement }) => ({
      key: bar.key,
      ...placement,
    })),
  ).toEqual([
    {
      key: "earlier",
      start: 0,
      end: 1,
      lane: 0,
      continuesBefore: true,
      continuesAfter: false,
    },
    {
      key: "expo",
      start: 2,
      end: 6,
      lane: 0,
      continuesBefore: false,
      continuesAfter: true,
    },
  ]);
});

test("timed chips sit below the week's bars and take two lines while the day has room", () => {
  const bar = item("workshop", {
    allDay: true,
    startDate: "2026-11-18",
    endDate: "2026-11-19",
    startMinute: null,
    endMinute: null,
  });
  const review = item("review", { startDate: "2026-11-16" });
  const morning = item("morning", {
    startDate: "2026-11-18",
    startMinute: 480,
  });
  const noon = item("noon", { startDate: "2026-11-18", startMinute: 720 });
  const layout = layoutMonthWeek(week, [bar, review, morning, noon], 5);
  const monday = layout.cells.find((cell) => cell.date === "2026-11-16");
  const wednesday = layout.cells.find((cell) => cell.date === "2026-11-18");
  // One bar lane is used in this week, so chips start at lane 1 on every day.
  expect(
    monday?.chips.map(({ item: chip, lane, lines }) => [chip.key, lane, lines]),
  ).toEqual([["review", 1, 2]]);
  // Four lanes remain under the bar: two two-line chips fill them exactly.
  expect(
    wednesday?.chips.map(({ item: chip, lane, lines }) => [
      chip.key,
      lane,
      lines,
    ]),
  ).toEqual([
    ["morning", 1, 2],
    ["noon", 3, 2],
  ]);
  expect(wednesday?.more).toBeNull();
});

test("a crowded day keeps one-line titles, then counts the rest as +n more", () => {
  const items = ["a", "b", "c", "d", "e"].map((key, index) =>
    item(key, { startDate: "2026-11-20", startMinute: 480 + index * 60 }),
  );
  const friday = layoutMonthWeek(week, items, 3).cells.find(
    (cell) => cell.date === "2026-11-20",
  );
  expect(
    friday?.chips.map(({ item: chip, lane, lines }) => [chip.key, lane, lines]),
  ).toEqual([
    ["a", 0, 1],
    ["b", 1, 1],
  ]);
  expect(friday?.more).toEqual({ lane: 2, count: 3 });
});

test("a bar with no lane left is counted in +n more on each day it covers", () => {
  const bars = ["one", "two", "three"].map((key) =>
    item(key, {
      allDay: true,
      startDate: "2026-11-16",
      endDate: "2026-11-17",
      startMinute: null,
      endMinute: null,
    }),
  );
  const layout = layoutMonthWeek(week, bars, 3);
  // Bars of the same span sort by title.
  expect(layout.bars.map((bar) => [bar.item.key, bar.lane])).toEqual([
    ["one", 0],
    ["three", 1],
  ]);
  expect(
    layout.cells
      .filter((cell) => cell.more)
      .map((cell) => [cell.date, cell.more]),
  ).toEqual([
    ["2026-11-16", { lane: 2, count: 1 }],
    ["2026-11-17", { lane: 2, count: 1 }],
  ]);
});

test("record sources and card due dates are chips, never bars", () => {
  const source = item("quote", {
    kind: "source",
    calendarId: "source:quotes",
    allDay: true,
    startDate: "2026-11-19",
    startMinute: null,
    endMinute: null,
    target: { kind: "record", moduleId: "m", recordId: "r" },
  });
  const layout = layoutMonthWeek(week, [source], 4);
  expect(layout.bars).toEqual([]);
  expect(
    layout.cells.find((cell) => cell.date === "2026-11-19")?.chips[0]?.item.key,
  ).toBe("quote");
});

test("overlapping blocks sit side by side; a later block after them takes the full width", () => {
  expect(
    layoutDayColumns([
      { key: "pricing", start: 600, end: 690 },
      { key: "quotes", start: 630, end: 690 },
      { key: "lunch", start: 720, end: 780 },
      { key: "late", start: 660, end: 700 },
    ]),
  ).toEqual([
    { key: "pricing", column: 0, columns: 3 },
    { key: "quotes", column: 1, columns: 3 },
    { key: "late", column: 2, columns: 3 },
    { key: "lunch", column: 0, columns: 1 },
  ]);
});

test("a timed event across midnight is cut at each day's edge", () => {
  const overnight = item("overnight", {
    startDate: "2026-11-17",
    endDate: "2026-11-18",
    startMinute: 1380,
    endMinute: 90,
  });
  expect(
    timedSegments([overnight], "2026-11-17").map(({ start, end }) => [
      start,
      end,
    ]),
  ).toEqual([[1380, 1440]]);
  expect(
    timedSegments([overnight], "2026-11-18").map(({ start, end }) => [
      start,
      end,
    ]),
  ).toEqual([[0, 90]]);
  expect(timedSegments([overnight], "2026-11-19")).toEqual([]);
});

test("the week's all-day row holds all-day events, sources and due cards in lanes", () => {
  const workshop = item("workshop", {
    allDay: true,
    startDate: "2026-11-15",
    endDate: "2026-11-17",
    startMinute: null,
    endMinute: null,
  });
  const due = item("due", {
    kind: "due",
    calendarId: "due:board",
    allDay: true,
    startDate: "2026-11-17",
    startMinute: null,
    endMinute: null,
    target: { kind: "card", cardId: "c" },
  });
  const timed = item("timed", { startDate: "2026-11-17" });
  expect(
    allDayLanes(week, [workshop, due, timed]).map((lane) => [
      lane.item.key,
      lane.start,
      lane.end,
      lane.lane,
      lane.continuesBefore,
    ]),
  ).toEqual([
    ["workshop", 0, 1, 0, true],
    ["due", 1, 1, 1, false],
  ]);
});
