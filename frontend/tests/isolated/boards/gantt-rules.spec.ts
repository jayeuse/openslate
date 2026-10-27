import { expect, test } from "@playwright/test";
import type {
  KanbanCard,
  KanbanLabel,
  KanbanStage,
} from "../../../src/components/systems/boards/adapters/board-kanban-schemas";
import {
  MAX_STAGED,
  barColor,
  barLabel,
  barPlacement,
  batchPayload,
  cardProgress,
  cardSpan,
  dayWidth,
  ganttAnnouncement,
  ganttGroups,
  ganttLines,
  ganttMonths,
  ganttTitle,
  ganttWeeks,
  ganttWindow,
  moveDates,
  parseGanttGroup,
  parseGanttZoom,
  pruneStaged,
  resizeDue,
  settleResults,
  shiftGanttAnchor,
  stageDates,
  todayOffset,
  withStaged,
  type StagedDates,
} from "../../../src/components/systems/boards/domain/gantt";

const boardId = "00000000-0000-4000-8000-000000000001";
const todo = "00000000-0000-4000-8000-0000000000a1";
const doing = "00000000-0000-4000-8000-0000000000a2";
const done = "00000000-0000-4000-8000-0000000000a3";
const ana = "00000000-0000-4000-8000-0000000000b1";
const ben = "00000000-0000-4000-8000-0000000000b2";
const expo = "00000000-0000-4000-8000-0000000000c1";
const pricing = "00000000-0000-4000-8000-0000000000c2";
const region = { timezone: "UTC", locale: "en-US" };
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function card(
  cardId: string,
  shape: Partial<KanbanCard> & { title?: string | null } = {},
): KanbanCard {
  return {
    id: cardId,
    boardId,
    stageId: todo,
    kind: "objective",
    title: cardId,
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

function stage(stageId: string, name: string, position: number): KanbanStage {
  return {
    id: stageId,
    boardId,
    name,
    color: null,
    wipLimit: null,
    cardSort: "manual",
    position,
    revision: 1,
    cardCount: 0,
  };
}

// Pricing is first on the card, Expo first on the board.
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
const lockedRecord = { locked: true as const };
const quote = {
  locked: false as const,
  recordId: id(900),
  moduleId: id(901),
  moduleName: "Quotes",
  title: "Q-24128",
  fields: [],
  status: null,
};

test("zoom and group come from the address; phones open at Month", () => {
  expect([
    parseGanttZoom(null, false),
    parseGanttZoom(null, true),
    parseGanttZoom("week", false),
    parseGanttZoom("quarter", true),
    parseGanttZoom("year", false),
  ]).toEqual(["quarter", "month", "week", "quarter", "quarter"]);
  expect(
    [null, "stage", "assignee", "label", "lane"].map(parseGanttGroup),
  ).toEqual(["stage", "stage", "assignee", "label", "stage"]);
});

test("each zoom shows whole weeks around its period; previous and next step one period", () => {
  // Monday weeks that touch Q4 2026: Sep 28 to Jan 3, 14 weeks.
  expect(ganttWindow("quarter", "2026-10-26", "monday")).toEqual({
    start: "2026-09-28",
    end: "2027-01-03",
    days: 98,
  });
  expect(ganttWindow("month", "2026-10-26", "monday")).toEqual({
    start: "2026-09-28",
    end: "2026-11-01",
    days: 35,
  });
  expect(ganttWindow("month", "2026-10-26", "sunday")).toEqual({
    start: "2026-09-27",
    end: "2026-10-31",
    days: 35,
  });
  // Week zoom: the anchor's week and the two after it.
  expect(ganttWindow("week", "2026-10-28", "monday")).toEqual({
    start: "2026-10-26",
    end: "2026-11-15",
    days: 21,
  });
  expect([
    shiftGanttAnchor("quarter", "2026-10-26", 1),
    shiftGanttAnchor("quarter", "2026-10-26", -1),
    shiftGanttAnchor("month", "2026-10-31", 1),
    shiftGanttAnchor("week", "2026-10-28", -1),
  ]).toEqual(["2027-01-01", "2026-07-01", "2026-11-01", "2026-10-21"]);
  expect([
    ganttTitle("quarter", "2026-10-26", "monday", region, false),
    ganttTitle("month", "2026-10-26", "monday", region, false),
    ganttTitle("month", "2026-10-26", "monday", region, true),
    ganttTitle("week", "2026-10-28", "monday", region, false),
    ganttTitle("week", "2026-10-28", "monday", region, true),
  ]).toEqual([
    "Q4 2026",
    "October 2026",
    "Oct 2026",
    "Oct 26 – Nov 15, 2026",
    "Oct 26 – Nov 15",
  ]);
});

test("the week row reads W1–W5 by each week's place in its month at Quarter, start dates otherwise", () => {
  const quarter = ganttWindow("quarter", "2026-10-26", "monday");
  expect(
    ganttWeeks(quarter, "quarter", region).map((week) => week.label),
  ).toEqual([
    // Sep 28 holds Thursday Oct 1, so it is October's first week.
    "W1",
    "W2",
    "W3",
    "W4",
    "W5",
    "W1",
    "W2",
    "W3",
    "W4",
    "W1",
    "W2",
    "W3",
    "W4",
    // Dec 28 holds Thursday Dec 31.
    "W5",
  ]);
  const month = ganttWindow("month", "2026-10-26", "monday");
  expect(ganttWeeks(month, "month", region)).toEqual([
    { offset: 0, label: "Sep 28" },
    { offset: 7, label: "Oct 5" },
    { offset: 14, label: "Oct 12" },
    { offset: 21, label: "Oct 19" },
    { offset: 28, label: "Oct 26" },
  ]);
  expect(
    ganttWeeks(ganttWindow("week", "2026-10-28", "monday"), "week", region),
  ).toEqual([
    { offset: 0, label: "Oct 26" },
    { offset: 7, label: "Nov 2" },
    { offset: 14, label: "Nov 9" },
  ]);
});

test("months head their days; a sliver under a week has a line but no name", () => {
  const quarter = ganttWindow("quarter", "2026-10-26", "monday");
  expect(ganttMonths(quarter, region)).toEqual([
    { offset: 3, label: "October" },
    { offset: 34, label: "November" },
    { offset: 64, label: "December" },
    { offset: 95, label: null },
  ]);
  // March 2027 starts on a Monday: its line is the window's left edge.
  const march = ganttWindow("month", "2027-03-10", "monday");
  expect(ganttMonths(march, region)).toEqual([
    { offset: 0, label: "March" },
    { offset: 31, label: null },
  ]);
  // Weeks are dotted and months solid; a month line wins where both fall.
  expect(ganttLines(march)).toEqual([
    { offset: 0, kind: "month" },
    { offset: 7, kind: "week" },
    { offset: 14, kind: "week" },
    { offset: 21, kind: "week" },
    { offset: 28, kind: "week" },
    { offset: 31, kind: "month" },
  ]);
});

test("a day fills the panel, but never narrower than its zoom allows", () => {
  expect(dayWidth("quarter", 980, 98)).toBe(10);
  expect(dayWidth("quarter", 400, 98)).toBe(6);
  expect(dayWidth("month", 300, 35)).toBe(14);
  expect(dayWidth("week", 2100, 21)).toBe(100);
  expect(dayWidth("week", 500, 21)).toBe(40);
});

test("a bar runs from start to due; one date is a one-day bar; the window clips it", () => {
  expect([
    cardSpan({ startOn: null, dueOn: null }),
    cardSpan({ startOn: "2026-11-23", dueOn: null }),
    cardSpan({ startOn: null, dueOn: "2026-10-27" }),
    cardSpan({ startOn: "2026-10-05", dueOn: "2026-11-02" }),
  ]).toEqual([
    null,
    { start: "2026-11-23", end: "2026-11-23" },
    { start: "2026-10-27", end: "2026-10-27" },
    { start: "2026-10-05", end: "2026-11-02" },
  ]);
  const quarter = ganttWindow("quarter", "2026-10-26", "monday");
  expect([
    barPlacement({ start: "2026-10-05", end: "2026-11-02" }, quarter),
    barPlacement({ start: "2026-10-27", end: "2026-10-27" }, quarter),
    barPlacement({ start: "2026-09-20", end: "2026-10-02" }, quarter),
    barPlacement({ start: "2026-12-30", end: "2027-01-10" }, quarter),
    barPlacement({ start: "2027-01-05", end: "2027-01-09" }, quarter),
    barPlacement({ start: "2026-09-01", end: "2026-09-27" }, quarter),
  ]).toEqual([
    { from: 7, length: 29, clippedStart: false, clippedEnd: false },
    { from: 29, length: 1, clippedStart: false, clippedEnd: false },
    { from: 0, length: 5, clippedStart: true, clippedEnd: false },
    { from: 93, length: 5, clippedStart: false, clippedEnd: true },
    null,
    null,
  ]);
  expect([
    todayOffset(quarter, "2026-10-26"),
    todayOffset(quarter, "2027-01-04"),
  ]).toEqual([28, null]);
});

test("a bar takes its card's first label in board order; record cards have no progress", () => {
  expect([
    barColor(card(id(1), { labelIds: [pricing, expo] }), labels),
    barColor(card(id(2), { labelIds: [pricing] }), labels),
    barColor(card(id(3)), labels),
    barColor(card(id(4), { labelIds: [id(999)] }), labels),
    // A locked card shows nothing of itself, so its bar is neutral.
    barColor(
      card(id(5), { kind: "record", record: lockedRecord, labelIds: [expo] }),
      labels,
    ),
  ]).toEqual(["chart-4", "chart-2", null, null, null]);
  expect([
    cardProgress(card(id(1), { checklist: { done: 1, total: 4 } })),
    cardProgress(card(id(2), { checklist: { done: 0, total: 0 } })),
    cardProgress(
      card(id(3), {
        kind: "record",
        record: quote,
        checklist: { done: 1, total: 2 },
      }),
    ),
  ]).toEqual([0.25, null, null]);
  expect([
    barLabel(
      card(id(1), {
        title: "Update the Q4 price list",
        startOn: "2026-10-05",
        dueOn: "2026-11-02",
        checklist: { done: 1, total: 4 },
      }),
      region,
    ),
    barLabel(card(id(2), { title: "Call back", dueOn: "2026-10-27" }), region),
  ]).toEqual([
    "Update the Q4 price list, Oct 5 to Nov 2, checklist 1 of 4 done",
    "Call back, Oct 27",
  ]);
});

test("groups follow the stages with a summary from the earliest start to the latest due; undated cards go last", () => {
  const stages = [
    stage(todo, "To do", 0),
    stage(doing, "In progress", 1),
    stage(done, "Done", 2),
  ];
  const cards = [
    card(id(1), {
      rank: 1024,
      startOn: "2026-10-05",
      dueOn: "2026-11-02",
      checklist: { done: 1, total: 4 },
    }),
    card(id(2), { rank: 2048, dueOn: "2026-10-27" }),
    card(id(3), { stageId: doing, rank: 1024 }),
    card(id(4), {
      stageId: doing,
      rank: 2048,
      kind: "record",
      record: quote,
      startOn: "2026-10-21",
      dueOn: "2026-11-04",
    }),
    card(id(5), {
      rank: 3072,
      startOn: "2026-11-23",
      checklist: { done: 3, total: 4 },
    }),
    // Done has only an undated card, so it draws no group.
    card(id(6), { stageId: done }),
  ];
  const result = ganttGroups({
    cards,
    stages,
    labels,
    group: "stage",
    personName: () => null,
  });
  expect(
    result.groups.map((group) => ({
      id: group.id,
      name: group.name,
      cards: group.cards.map((item) => item.id),
      span: group.span,
      progress: group.progress,
    })),
  ).toEqual([
    {
      id: todo,
      name: "To do",
      cards: [id(1), id(2), id(5)],
      span: { start: "2026-10-05", end: "2026-11-23" },
      // 4 of 8 checklist items; the record card has none.
      progress: 0.5,
    },
    {
      id: doing,
      name: "In progress",
      cards: [id(4)],
      span: { start: "2026-10-21", end: "2026-11-04" },
      progress: null,
    },
  ]);
  expect(result.unscheduled.map((item) => item.id)).toEqual([id(3), id(6)]);
});

test("group progress counts checklist items across the group's objectives", () => {
  const result = ganttGroups({
    cards: [
      card(id(1), { dueOn: "2026-10-27", checklist: { done: 1, total: 1 } }),
      card(id(2), { dueOn: "2026-10-28", checklist: { done: 0, total: 3 } }),
    ],
    stages: [stage(todo, "To do", 0)],
    labels,
    group: "stage",
    personName: () => null,
  });
  // 1 of 4 items, where a mean of the cards would say 50%.
  expect(result.groups[0].progress).toBe(0.25);
});

test("Group by label or assignee draws a group per lane, the empty lane last", () => {
  const cards = [
    card(id(1), { dueOn: "2026-10-27", labelIds: [pricing], assigneeId: ben }),
    card(id(2), { dueOn: "2026-10-28", labelIds: [expo, pricing] }),
    card(id(3), { dueOn: "2026-10-29", assigneeId: ana }),
  ];
  const names: Record<string, string> = {
    [ana]: "Ana Santos",
    [ben]: "Ben Reyes",
  };
  const by = (group: "label" | "assignee") =>
    ganttGroups({
      cards,
      stages: [stage(todo, "To do", 0)],
      labels,
      group,
      personName: (person) => names[person] ?? null,
    }).groups.map((lane) => [lane.name, lane.cards.map((item) => item.id)]);
  expect(by("label")).toEqual([
    ["Expo", [id(2)]],
    ["Pricing", [id(1)]],
    ["No label", [id(3)]],
  ]);
  expect(by("assignee")).toEqual([
    ["Ana Santos", [id(3)]],
    ["Ben Reyes", [id(1)]],
    ["No assignee", [id(2)]],
  ]);
});

test("a move shifts the dates a card has; a resize changes the due date and never ends before the start", () => {
  expect([
    moveDates({ startOn: "2026-10-05", dueOn: "2026-11-02" }, 2),
    moveDates({ startOn: null, dueOn: "2026-10-27" }, 1),
    moveDates({ startOn: "2026-11-23", dueOn: null }, -3),
  ]).toEqual([
    { startOn: "2026-10-07", dueOn: "2026-11-04" },
    { startOn: null, dueOn: "2026-10-28" },
    { startOn: "2026-11-20", dueOn: null },
  ]);
  expect([
    resizeDue({ startOn: "2026-10-05", dueOn: "2026-11-02" }, 3),
    resizeDue({ startOn: "2026-10-05", dueOn: "2026-11-02" }, -40),
    // A one-day bar grows from its day; shrinking it changes nothing.
    resizeDue({ startOn: null, dueOn: "2026-10-27" }, 3),
    resizeDue({ startOn: null, dueOn: "2026-10-27" }, -2),
    resizeDue({ startOn: "2026-11-23", dueOn: null }, 1),
    resizeDue({ startOn: "2026-11-23", dueOn: null }, -1),
  ]).toEqual([
    { startOn: "2026-10-05", dueOn: "2026-11-05" },
    { startOn: "2026-10-05", dueOn: "2026-10-05" },
    { startOn: "2026-10-27", dueOn: "2026-10-30" },
    { startOn: null, dueOn: "2026-10-27" },
    { startOn: "2026-11-23", dueOn: "2026-11-24" },
    { startOn: "2026-11-23", dueOn: null },
  ]);
});

test("staged changes keep each card's first revision; a change back to the saved dates leaves the set", () => {
  const booth = card(id(1), {
    revision: 3,
    startOn: "2026-10-05",
    dueOn: "2026-11-02",
  });
  let staged: StagedDates = new Map();
  staged = stageDates(staged, booth, {
    startOn: "2026-10-07",
    dueOn: "2026-11-04",
  }).staged;
  // A live refresh gave the card a new revision; the change keeps its own.
  staged = stageDates(
    staged,
    { ...booth, revision: 4 },
    {
      startOn: "2026-10-07",
      dueOn: "2026-11-06",
    },
  ).staged;
  expect([...staged.values()]).toEqual([
    {
      cardId: id(1),
      revision: 3,
      from: { startOn: "2026-10-05", dueOn: "2026-11-02" },
      to: { startOn: "2026-10-07", dueOn: "2026-11-06" },
    },
  ]);
  expect(
    withStaged([booth, card(id(2))], staged).map((item) => [
      item.startOn,
      item.dueOn,
    ]),
  ).toEqual([
    ["2026-10-07", "2026-11-06"],
    [null, null],
  ]);
  staged = stageDates(staged, booth, {
    startOn: "2026-10-05",
    dueOn: "2026-11-02",
  }).staged;
  expect(staged.size).toBe(0);
});

test("one save holds at most 100 cards; the 101st waits, edits to staged cards do not", () => {
  let staged: StagedDates = new Map();
  for (let index = 1; index <= MAX_STAGED; index += 1)
    staged = stageDates(staged, card(id(index), { dueOn: "2026-10-27" }), {
      startOn: null,
      dueOn: "2026-10-28",
    }).staged;
  expect(staged.size).toBe(100);
  const extra = stageDates(staged, card(id(101), { dueOn: "2026-10-27" }), {
    startOn: null,
    dueOn: "2026-10-28",
  });
  expect([extra.refused, extra.staged.size]).toEqual([true, 100]);
  const again = stageDates(staged, card(id(7), { dueOn: "2026-10-27" }), {
    startOn: null,
    dueOn: "2026-10-30",
  });
  expect([again.refused, again.staged.get(id(7))?.to.dueOn]).toEqual([
    false,
    "2026-10-30",
  ]);
});

test("a card that left the board leaves the staged set; the payload names each card's revision", () => {
  let staged: StagedDates = new Map();
  for (const [cardId, revision] of [
    [id(1), 3],
    [id(2), 7],
  ] as const)
    staged = stageDates(
      staged,
      card(cardId, { revision, startOn: "2026-10-05", dueOn: "2026-10-09" }),
      { startOn: "2026-10-06", dueOn: "2026-10-10" },
    ).staged;
  expect(batchPayload(staged)).toEqual({
    items: [
      {
        card_id: id(1),
        revision: 3,
        start_on: "2026-10-06",
        due_on: "2026-10-10",
      },
      {
        card_id: id(2),
        revision: 7,
        start_on: "2026-10-06",
        due_on: "2026-10-10",
      },
    ],
  });
  const pruned = pruneStaged(staged, [card(id(2))]);
  expect([...pruned.keys()]).toEqual([id(2)]);
  // Nothing left out returns the same set, so a render keeps its identity.
  expect(pruneStaged(pruned, [card(id(2))])).toBe(pruned);
});

test("each card's result settles its change: updated saves, stale and forbidden say why", () => {
  let staged: StagedDates = new Map();
  for (const n of [1, 2, 3])
    staged = stageDates(staged, card(id(n), { dueOn: "2026-10-27" }), {
      startOn: null,
      dueOn: "2026-10-28",
    }).staged;
  const settled = settleResults(staged, [
    {
      status: "updated",
      cardId: id(1),
      revision: 2,
      startOn: null,
      dueOn: "2026-10-28",
    },
    { status: "stale", cardId: id(2) },
    { status: "forbidden", cardId: id(3) },
  ]);
  expect(settled).toEqual({
    staged: new Map(),
    updated: [
      { cardId: id(1), revision: 2, startOn: null, dueOn: "2026-10-28" },
    ],
    problems: [
      { cardId: id(2), message: "Someone changed this card first." },
      {
        cardId: id(3),
        message:
          "This card is no longer on this board, or you cannot read its record.",
      },
    ],
  });
});

test("the live region says the card, its new dates and the unsaved count", () => {
  expect([
    ganttAnnouncement(
      "Book the expo booth crew",
      { startOn: "2026-10-27", dueOn: "2026-10-31" },
      1,
      region,
    ),
    ganttAnnouncement(
      "Call back",
      { startOn: null, dueOn: "2026-10-28" },
      2,
      region,
    ),
    ganttAnnouncement(
      "Call back",
      { startOn: null, dueOn: "2026-10-27" },
      0,
      region,
    ),
  ]).toEqual([
    "Book the expo booth crew: Oct 27 to Oct 31. 1 unsaved change.",
    "Call back: Oct 28. 2 unsaved changes.",
    "Call back: Oct 27. No unsaved changes.",
  ]);
});
