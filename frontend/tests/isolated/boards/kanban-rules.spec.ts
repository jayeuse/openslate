import { expect, test } from "@playwright/test";
import type {
  KanbanCard,
  KanbanLabel,
} from "../../../src/components/systems/boards/adapters/board-kanban-schemas";
import {
  applyMove,
  cardLabel,
  cardName,
  dropPosition,
  filterCards,
  defaultCardDates,
  kanbanFilterParams,
  parseKanbanFilters,
  recordDateChoices,
  recordFieldTexts,
  sortStageCards,
  stageCount,
  stagePage,
  swimlanes,
} from "../../../src/components/systems/boards/domain/kanban";

const boardId = "00000000-0000-4000-8000-000000000001";
const todo = "00000000-0000-4000-8000-0000000000a1";
const doing = "00000000-0000-4000-8000-0000000000a2";
const ana = "00000000-0000-4000-8000-0000000000b1";
const ben = "00000000-0000-4000-8000-0000000000b2";
const expo = "00000000-0000-4000-8000-0000000000c1";
const pricing = "00000000-0000-4000-8000-0000000000c2";

function card(
  id: string,
  shape: Partial<KanbanCard> & { title?: string | null } = {},
): KanbanCard {
  return {
    id,
    boardId,
    stageId: todo,
    kind: "objective",
    title: id,
    rank: 1024,
    assigneeId: null,
    startOn: null,
    dueOn: null,
    labelIds: [],
    checklist: { done: 0, total: 0 },
    archivedAt: null,
    revision: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    record: null,
    ...shape,
  };
}

const labels: KanbanLabel[] = [
  {
    id: expo,
    boardId,
    name: "Expo",
    color: "chart-4",
    position: 0,
    revision: 1,
  },
  {
    id: pricing,
    boardId,
    name: "Pricing",
    color: "chart-2",
    position: 1,
    revision: 1,
  },
];

const locked = card("locked", {
  kind: "record",
  title: null,
  record: { locked: true },
});
const quote = card("quote", {
  kind: "record",
  title: null,
  record: {
    locked: false,
    recordId: "00000000-0000-4000-8000-0000000000d1",
    moduleId: "00000000-0000-4000-8000-0000000000d2",
    moduleName: "Quotes",
    title: "Q-24112",
    fields: [],
    status: null,
  },
});

test("a card's name is its title, its record's name, or the locked words", () => {
  expect(cardName(card("x", { title: "Book the expo booth crew" }))).toBe(
    "Book the expo booth crew",
  );
  expect(cardName(quote)).toBe("Q-24112");
  expect(cardName(locked)).toBe("No access to this record");
});

test("a card's accessible name says what its face shows", () => {
  const face = {
    region: { timezone: "UTC", locale: "en-US" },
    today: "2026-10-27",
    labelNames: ["Expo", "Pricing"],
    assignee: "Ana Santos",
  };
  expect(
    cardLabel(
      card("crew", {
        title: "Book the expo booth crew",
        dueOn: "2026-10-30",
        checklist: { done: 0, total: 3 },
        labelIds: [expo, pricing],
      }),
      face,
    ),
  ).toBe(
    "Book the expo booth crew, objective, labels Expo, Pricing, due oct 30, 0 of 3 done, assigned to Ana Santos",
  );
  const sent = card("sent", {
    kind: "record",
    title: null,
    record: {
      locked: false,
      recordId: "00000000-0000-4000-8000-0000000000d1",
      moduleId: "00000000-0000-4000-8000-0000000000d2",
      moduleName: "Quotes",
      title: "Q-24112",
      fields: [
        { fieldId: "f1", name: "Customer", value: "Pacific Rim Foods" },
        { fieldId: "f2", name: "Total", value: "22,750" },
      ],
      status: { fieldId: "f3", name: "Status", value: "Sent" },
    },
  });
  // A bare card says only its name and kind.
  expect(cardLabel(sent, { ...face, labelNames: [], assignee: null })).toBe(
    "Q-24112, Quotes record, Status Sent, Pacific Rim Foods, 22,750",
  );
});

test("a record card's date fields read in the workspace's words, and a due date is not said twice", () => {
  const region = { timezone: "Asia/Manila", locale: "en-US" };
  const withFields = (values: string[], dueOn: string | null = null) =>
    card("dated", {
      kind: "record",
      title: null,
      dueOn,
      record: {
        locked: false,
        recordId: "00000000-0000-4000-8000-0000000000d1",
        moduleId: "00000000-0000-4000-8000-0000000000d2",
        moduleName: "Quotes",
        title: "Q-24112",
        fields: values.map((value, index) => ({
          fieldId: `f${index}`,
          name: `Field ${index}`,
          value,
        })),
        status: null,
      },
    });
  // A date, a datetime in the workspace zone, and plain text.
  expect(
    recordFieldTexts(
      withFields(["2026-11-05", "2026-11-05T17:30:00Z"]),
      region,
    ),
  ).toEqual(["Nov 5", "Nov 6, 1:30 AM"]);
  expect(
    recordFieldTexts(withFields(["Pacific Rim Foods", "22,750"]), region),
  ).toEqual(["Pacific Rim Foods", "22,750"]);
  // The due date is on the fact line already.
  expect(
    recordFieldTexts(
      withFields(["2026-11-05", "Pacific Rim Foods"], "2026-11-05"),
      region,
    ),
  ).toEqual(["Pacific Rim Foods"]);
  expect(recordFieldTexts(locked, region)).toEqual([]);
});

test("a stage's sort orders its cards; manual keeps rank and locked cards keep their place", () => {
  const cards = [
    card("b", {
      title: "Beta",
      rank: 1024,
      dueOn: "2026-11-02",
      createdAt: "2026-10-02T00:00:00Z",
    }),
    { ...locked, rank: 2048, createdAt: "2026-10-03T00:00:00Z" },
    card("a", {
      title: "alpha",
      rank: 3072,
      dueOn: "2026-10-30",
      createdAt: "2026-10-01T00:00:00Z",
    }),
    card("c", {
      title: "Gamma",
      rank: 4096,
      createdAt: "2026-10-04T00:00:00Z",
    }),
  ];
  const ids = (sort: Parameters<typeof sortStageCards>[1]) =>
    sortStageCards(cards, sort).map((item) => item.id);
  expect(ids("manual")).toEqual(["b", "locked", "a", "c"]);
  // Due: soonest first, undated last in rank order.
  expect(ids("due")).toEqual(["a", "b", "locked", "c"]);
  expect(ids("newest")).toEqual(["c", "locked", "b", "a"]);
  // Title: by name, a locked card (no name) last.
  expect(ids("title")).toEqual(["a", "b", "c", "locked"]);
});

test("the stage count shows the WIP limit and warns only over it", () => {
  expect(stageCount(9, 8)).toEqual({
    text: "9 / 8",
    over: true,
    label: "9 cards, over its limit of 8",
  });
  expect(stageCount(5, 5)).toEqual({
    text: "5 / 5",
    over: false,
    label: "5 cards, limit 5",
  });
  expect(stageCount(1, null)).toEqual({
    text: "1",
    over: false,
    label: "1 card",
  });
});

test("a long stage shows 25 cards, then pages of 25", () => {
  expect(stagePage(41, 25)).toEqual({
    shown: 25,
    line: "25 of 41",
    more: "Show 16 more",
    next: 41,
  });
  expect(stagePage(80, 25)).toEqual({
    shown: 25,
    line: "25 of 80",
    more: "Show 25 more",
    next: 50,
  });
  expect(stagePage(80, 75)).toEqual({
    shown: 75,
    line: "75 of 80",
    more: "Show 5 more",
    next: 80,
  });
  expect(stagePage(25, 25)).toEqual({
    shown: 25,
    line: null,
    more: null,
    next: 25,
  });
  expect(stagePage(3, 25)).toEqual({
    shown: 3,
    line: null,
    more: null,
    next: 3,
  });
});

test("a drop's position is the unfiltered index of the visible card below the slot", () => {
  // Unfiltered stage, cross-stage drop between the 1st and 2nd card.
  expect(
    dropPosition({
      full: ["a", "b", "c"],
      visible: ["a", "b", "c"],
      movingId: "x",
      slot: 1,
      manual: true,
    }),
  ).toBe(1);
  // Same stage, moving b down past c: slots count without b, so d is below.
  expect(
    dropPosition({
      full: ["a", "b", "c", "d"],
      visible: ["a", "b", "c", "d"],
      movingId: "b",
      slot: 2,
      manual: true,
    }),
  ).toBe(2);
  // Same stage, moving c up to the top.
  expect(
    dropPosition({
      full: ["a", "b", "c"],
      visible: ["a", "b", "c"],
      movingId: "c",
      slot: 0,
      manual: true,
    }),
  ).toBe(0);
  // Append: no visible card below the slot.
  expect(
    dropPosition({
      full: ["a", "b"],
      visible: ["a", "b"],
      movingId: "x",
      slot: 2,
      manual: true,
    }),
  ).toBeNull();
  // Filtered: only a and d show; a slot above d lands before d's real place.
  expect(
    dropPosition({
      full: ["a", "b", "c", "d"],
      visible: ["a", "d"],
      movingId: "x",
      slot: 1,
      manual: true,
    }),
  ).toBe(3);
  // Filtered same-stage move down: b (hidden c between) goes above e.
  expect(
    dropPosition({
      full: ["a", "b", "c", "d", "e"],
      visible: ["b", "d", "e"],
      movingId: "b",
      slot: 1,
      manual: true,
    }),
  ).toBe(3);
  // A sorted stage has no manual places: the card is appended.
  expect(
    dropPosition({
      full: ["a", "b"],
      visible: ["b", "a"],
      movingId: "x",
      slot: 0,
      manual: false,
    }),
  ).toBeNull();
});

test("a local move places the card between its new neighbours at once", () => {
  const cards = [
    card("a", { rank: 1024 }),
    card("b", { rank: 2048 }),
    card("x", { stageId: doing, rank: 1024 }),
  ];
  const moved = applyMove(cards, "x", todo, 1);
  const inTodo = moved
    .filter((item) => item.stageId === todo)
    .sort((left, right) => left.rank - right.rank)
    .map((item) => item.id);
  expect(inTodo).toEqual(["a", "x", "b"]);
  const appended = applyMove(cards, "a", doing, null)
    .filter((item) => item.stageId === doing)
    .sort((left, right) => left.rank - right.rank)
    .map((item) => item.id);
  expect(appended).toEqual(["x", "a"]);
});

test("filters keep the URL words and narrow cards by text, person, label and due", () => {
  const filters = parseKanbanFilters(
    `search=expo&assignee=${ana}&label=${expo}&label=${pricing}&due=overdue&group=label`,
  );
  expect(filters).toEqual({
    search: "expo",
    assignee: ana,
    labels: [expo, pricing],
    due: "overdue",
    group: "label",
  });
  expect(kanbanFilterParams(filters)).toEqual({
    search: "expo",
    assignee: ana,
    label: [expo, pricing],
    due: "overdue",
    group: "label",
  });
  expect(parseKanbanFilters("assignee=nobody&due=later&group=stage")).toEqual({
    search: "",
    assignee: null,
    labels: [],
    due: null,
    group: null,
  });

  const cards = [
    card("expo-crew", {
      title: "Book the Expo crew",
      assigneeId: ana,
      labelIds: [expo],
      dueOn: "2026-10-26",
    }),
    card("price-list", {
      title: "Update the price list",
      assigneeId: ben,
      labelIds: [pricing],
      dueOn: "2026-10-29",
    }),
    card("next-week", { title: "Plan reviews", dueOn: "2026-11-03" }),
    locked,
    quote,
  ];
  const calendar = { today: "2026-10-27", weekStart: "monday" as const };
  const ids = (search: string) =>
    filterCards(cards, parseKanbanFilters(search), calendar).map(
      (item) => item.id,
    );
  expect(ids("search=EXPO")).toEqual(["expo-crew"]);
  expect(ids("search=q-241")).toEqual(["quote"]);
  expect(ids(`assignee=${ben}`)).toEqual(["price-list"]);
  expect(ids(`label=${expo}&label=${pricing}`)).toEqual([
    "expo-crew",
    "price-list",
  ]);
  expect(ids("due=overdue")).toEqual(["expo-crew"]);
  // This week (Monday Oct 26 to Sunday Nov 1).
  expect(ids("due=week")).toEqual(["expo-crew", "price-list"]);
  expect(ids("")).toHaveLength(5);
  // Before the workspace's day is read, a due filter keeps every card.
  expect(
    filterCards(cards, parseKanbanFilters("due=week"), {
      today: "",
      weekStart: "monday",
    }),
  ).toHaveLength(5);
});

test("swimlanes group by assignee or first label, with the empty lane last", () => {
  const cards = [
    card("1", { assigneeId: ben, labelIds: [pricing, expo] }),
    card("2", { assigneeId: null }),
    card("3", { assigneeId: ana, labelIds: [expo] }),
  ];
  const names = new Map([
    [ana, "Ana Cruz"],
    [ben, "Ben Reyes"],
  ]);
  const people = (id: string) => names.get(id) ?? null;
  expect(
    swimlanes(cards, "assignee", labels, people).map((lane) => [
      lane.name,
      lane.cards.map((item) => item.id),
    ]),
  ).toEqual([
    ["Ana Cruz", ["3"]],
    ["Ben Reyes", ["1"]],
    ["No assignee", ["2"]],
  ]);
  expect(
    swimlanes(cards, "label", labels, people).map((lane) => [
      lane.name,
      lane.cards.map((item) => item.id),
    ]),
  ).toEqual([
    ["Expo", ["1", "3"]],
    ["No label", ["2"]],
  ]);
});

test("a record card's dates come from the record's first date and datetime fields", () => {
  const fields = [
    { id: "title", name: "Quote", type: "text", position: 0 },
    { id: "sent", name: "Sent at", type: "datetime", position: 1 },
    { id: "valid", name: "Valid until", type: "date", position: 2 },
    { id: "empty", name: "Signed on", type: "date", position: 3 },
  ];
  const choices = recordDateChoices(
    fields,
    {
      title: "Q-24112",
      // 23:30 UTC is the next day in Manila.
      sent: "2026-10-19T23:30:00Z",
      valid: "2026-11-13",
      empty: null,
    },
    "Asia/Manila",
  );
  expect(choices).toEqual([
    { fieldId: "sent", name: "Sent at", date: "2026-10-20" },
    { fieldId: "valid", name: "Valid until", date: "2026-11-13" },
  ]);
  expect(defaultCardDates(choices)).toEqual({
    start: "sent",
    due: "valid",
  });
  // One date is the due date; none leaves both empty.
  expect(defaultCardDates(choices.slice(1))).toEqual({
    start: null,
    due: "valid",
  });
  expect(defaultCardDates([])).toEqual({ start: null, due: null });
});
