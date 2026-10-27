import { expect, test } from "@playwright/test";
import { listCrossBoardOccurrences } from "../../../src/components/systems/boards/adapters/board-my-calendar-api";
import { listMyDueCards } from "../../../src/components/systems/boards/adapters/board-due-cards-api";
import {
  listMyCalendarSources,
  removeMyCalendarSource,
} from "../../../src/components/systems/boards/adapters/board-calendar-sources-api";
import {
  boardConsequence,
  myCalendarBoards,
  postableBoards,
} from "../../../src/components/systems/boards/domain/my-calendar";
import {
  hiddenCalendarsKey,
  myCalendarHiddenKey,
  readHiddenCalendars,
  writeHiddenCalendars,
} from "../../../src/components/systems/boards/domain/hidden-calendars";
import { installFetch } from "../helpers/fake-fetch";

const companyId = "00000000-0000-4000-8000-000000000001";
const salesId = "00000000-0000-4000-8000-000000000002";
const fleetId = "00000000-0000-4000-8000-000000000003";
const inventoryId = "00000000-0000-4000-8000-000000000004";
const salesDepartment = "00000000-0000-4000-8000-000000000005";
const inventoryDepartment = "00000000-0000-4000-8000-000000000006";
const authorId = "00000000-0000-4000-8000-000000000007";
const stageId = "00000000-0000-4000-8000-000000000008";
const sourceId = "00000000-0000-4000-8000-000000000009";
const stamp = "2026-10-26T00:00:00Z";

const salesMark = {
  id: salesId,
  name: "Sales",
  scope: "department",
  department_id: salesDepartment,
} as const;

function occurrence(index: number) {
  const id = `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
  const start = `2026-11-02T${String(index % 24).padStart(2, "0")}:00:00Z`;
  const end = `2026-11-02T${String(index % 24).padStart(2, "0")}:30:00Z`;
  return {
    id: `${id}:${start}`,
    event_id: id,
    date: "2026-11-02",
    start,
    end,
    event: {
      id,
      board_id: salesId,
      author_id: authorId,
      title: `Event ${index}`,
      details: "",
      location: "",
      links: [],
      all_day: false,
      start_date: null,
      end_date: null,
      start_at: start,
      end_at: end,
      timezone_name: "UTC",
      recurrence: "none",
      repeat_until: null,
      reminders: [],
      archived: false,
      revision: 1,
      board_revision: 4,
      created_at: stamp,
      updated_at: stamp,
    },
    board: salesMark,
  };
}

const states = [
  { board_id: salesId, revision: 4, status: "ok", next_occurrence: null },
  {
    board_id: inventoryId,
    revision: null,
    status: "unavailable",
    next_occurrence: null,
  },
];

test("My calendar reads the window across boards and pages to completion", async () => {
  const items = Array.from({ length: 101 }, (_, index) => occurrence(index));
  const mock = installFetch((input) => {
    const offset = Number(
      new URL(String(input), "http://x").searchParams.get("offset"),
    );
    const page = items.slice(offset, offset + 100);
    return Response.json({
      items: page,
      boards: states,
      pagination: {
        limit: 100,
        offset,
        count: page.length,
        total: 101,
        has_more: offset + page.length < 101,
      },
    });
  });
  try {
    const result = await listCrossBoardOccurrences({
      windowStart: "2026-10-26",
      windowEnd: "2026-12-06",
      search: "review",
    });
    expect(result.items).toHaveLength(101);
    expect(result.items[100]).toMatchObject({
      eventId: "00000000-0000-4000-8000-000000000200",
      date: "2026-11-02",
      board: {
        id: salesId,
        name: "Sales",
        scope: "department",
        departmentId: salesDepartment,
      },
    });
    expect(result.boards).toEqual([
      { boardId: salesId, revision: 4, status: "ok", nextOccurrence: null },
      {
        boardId: inventoryId,
        revision: null,
        status: "unavailable",
        nextOccurrence: null,
      },
    ]);
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/boards/occurrences?window_start=2026-10-26&window_end=2026-12-06&limit=100&offset=0&search=review",
      "/api/boards/occurrences?window_start=2026-10-26&window_end=2026-12-06&limit=100&offset=100&search=review",
    ]);
  } finally {
    mock.restore();
  }
});

test("an occurrence whose board is not its event's board is refused", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [{ ...occurrence(0), board: { ...salesMark, id: fleetId } }],
      boards: states,
      pagination: {
        limit: 100,
        offset: 0,
        count: 1,
        total: 1,
        has_more: false,
      },
    }),
  );
  try {
    await expect(
      listCrossBoardOccurrences({
        windowStart: "2026-11-01",
        windowEnd: "2026-11-30",
      }),
    ).rejects.toThrow();
  } finally {
    mock.restore();
  }
});

function dueCard(index: number, patch: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(300 + index).padStart(12, "0")}`,
    board_id: salesId,
    stage_id: stageId,
    kind: "objective",
    title: `Card ${index}`,
    rank: index,
    assignee_id: authorId,
    start_on: null,
    due_on: "2026-11-04",
    label_ids: [],
    checklist: { done: 0, total: 0 },
    archived_at: null,
    revision: 1,
    created_at: stamp,
    updated_at: stamp,
    record: null,
    board: salesMark,
    ...patch,
  };
}

test("My cards · Due reads the person's cards in the window, page by page, with their boards", async () => {
  const cards = [
    ...Array.from({ length: 100 }, (_, index) => dueCard(index)),
    dueCard(100, { kind: "record", title: null, record: { locked: true } }),
  ];
  const mock = installFetch((input) => {
    const offset = Number(
      new URL(String(input), "http://x").searchParams.get("offset"),
    );
    const page = cards.slice(offset, offset + 100);
    return Response.json({
      items: page,
      pagination: {
        limit: 100,
        offset,
        count: page.length,
        total: 101,
        has_more: offset + page.length < 101,
      },
    });
  });
  try {
    const result = await listMyDueCards({
      from: "2026-10-26",
      to: "2026-12-06",
    });
    expect(result).toHaveLength(101);
    expect(result[100]).toEqual({
      id: "00000000-0000-4000-8000-000000000400",
      kind: "record",
      title: null,
      dueOn: "2026-11-04",
      stageId,
      assigneeId: authorId,
      record: { locked: true },
      board: {
        id: salesId,
        name: "Sales",
        scope: "department",
        departmentId: salesDepartment,
      },
    });
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/boards/cards/due?from=2026-10-26&to=2026-12-06&limit=100&offset=0",
      "/api/boards/cards/due?from=2026-10-26&to=2026-12-06&limit=100&offset=100",
    ]);
  } finally {
    mock.restore();
  }
});

test("My calendar's own sources list and remove on the person's path", async () => {
  const wire = {
    id: sourceId,
    module_id: "00000000-0000-4000-8000-00000000000a",
    module_name: "Sales Orders",
    department_id: salesDepartment,
    date_field_id: "00000000-0000-4000-8000-00000000000b",
    field_name: "Promised delivery",
    field_type: "datetime",
    position: 0,
  };
  const mock = installFetch((_input, init) =>
    init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ items: [wire] }),
  );
  try {
    expect(await listMyCalendarSources()).toEqual([
      {
        id: sourceId,
        moduleId: "00000000-0000-4000-8000-00000000000a",
        moduleName: "Sales Orders",
        departmentId: salesDepartment,
        dateFieldId: "00000000-0000-4000-8000-00000000000b",
        fieldName: "Promised delivery",
        fieldType: "datetime",
        position: 0,
      },
    ]);
    await removeMyCalendarSource(sourceId);
    expect(
      mock.requests.map(({ input, init }) => [
        init?.method ?? "GET",
        String(input),
      ]),
    ).toEqual([
      ["GET", "/api/me/calendar-sources"],
      ["DELETE", `/api/me/calendar-sources/${sourceId}`],
    ]);
  } finally {
    mock.restore();
  }
});

const listed = [
  {
    id: fleetId,
    name: "Fleet Reliability",
    scope: "project",
    departmentId: null,
    level: "write",
  },
  {
    id: inventoryId,
    name: "Inventory",
    scope: "department",
    departmentId: inventoryDepartment,
    level: "read",
  },
  {
    id: salesId,
    name: "Sales",
    scope: "department",
    departmentId: salesDepartment,
    level: "manage",
  },
  {
    id: companyId,
    name: "Company",
    scope: "company",
    departmentId: null,
    level: "read",
  },
] as const;

test("each board the read covered is a calendar, named and ordered, with its read status", () => {
  const boards = myCalendarBoards(
    [
      { boardId: fleetId, revision: 2, status: "ok" },
      { boardId: inventoryId, revision: null, status: "unavailable" },
      { boardId: salesId, revision: 4, status: "occurrence_limit" },
      { boardId: companyId, revision: 9, status: "candidate_limit" },
      // Not in the list yet: the item's mark names it, or it reads "Board".
      { boardId: authorId, revision: 1, status: "ok" },
      { boardId: stageId, revision: 1, status: "ok" },
    ],
    listed,
    [
      {
        id: authorId,
        name: "Spring Launch",
        scope: "project",
        departmentId: null,
      },
    ],
    // Inventory comes before Sales in the sidebar.
    (department) =>
      department === inventoryDepartment
        ? 0
        : department === salesDepartment
          ? 1
          : null,
  );
  expect(
    boards.map((board) => [
      board.calendarId,
      board.name,
      board.ownerName,
      board.level,
      board.revision,
      board.status,
    ]),
  ).toEqual([
    [
      `board:${companyId}`,
      "Company announcements",
      "Company",
      "read",
      9,
      "limited",
    ],
    [
      `board:${inventoryId}`,
      "Inventory announcements",
      "Inventory",
      "read",
      null,
      "error",
    ],
    [
      `board:${salesId}`,
      "Sales announcements",
      "Sales",
      "manage",
      4,
      "limited",
    ],
    [
      `board:${fleetId}`,
      "Fleet Reliability announcements",
      "Fleet Reliability",
      "write",
      2,
      "ready",
    ],
    [
      `board:${authorId}`,
      "Spring Launch announcements",
      "Spring Launch",
      null,
      1,
      "ready",
    ],
    [`board:${stageId}`, "Board", "this board", null, 1, "ready"],
  ]);
  // A board the read did not cover is not a calendar (the Same Answer Rule).
  expect(
    myCalendarBoards([], listed, [], () => null).map((board) => board.id),
  ).toEqual([]);
});

test("the Board field lists only the boards the person posts on, and names who sees the event", () => {
  const boards = myCalendarBoards(
    [
      { boardId: companyId, revision: 9, status: "ok" },
      { boardId: salesId, revision: 4, status: "ok" },
      { boardId: inventoryId, revision: null, status: "unavailable" },
      { boardId: fleetId, revision: 2, status: "ok" },
      { boardId: authorId, revision: 1, status: "ok" },
    ],
    listed,
    [],
    () => null,
  );
  expect(postableBoards(boards).map((board) => board.name)).toEqual([
    "Sales announcements",
    "Fleet Reliability announcements",
  ]);
  expect(boardConsequence(postableBoards(boards)[0])).toBe(
    "Everyone who reads Sales sees this event.",
  );
  expect(boardConsequence(boards[0])).toBe(
    "Everyone who reads Company sees this event.",
  );
});

test("My calendar's hidden calendars are kept apart from every board's own", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const mine = myCalendarHiddenKey(authorId);
  expect(mine).toBe(`openslate.boards.calendar.hidden.${authorId}.my-calendar`);
  writeHiddenCalendars(() => storage, mine, [`board:${salesId}`, "my-due"]);
  expect(
    readHiddenCalendars(() => storage, hiddenCalendarsKey(authorId, salesId)),
  ).toEqual([]);
  expect(readHiddenCalendars(() => storage, mine)).toEqual([
    `board:${salesId}`,
    "my-due",
  ]);
});
