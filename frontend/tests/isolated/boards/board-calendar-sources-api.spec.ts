import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import {
  addBoardCalendarSource,
  addMyCalendarSource,
  listBoardCalendarSources,
  removeBoardCalendarSource,
} from "../../../src/components/systems/boards/adapters/board-calendar-sources-api";
import { listDueBoardCards } from "../../../src/components/systems/boards/adapters/board-due-cards-api";
import { parseWorkspaceInvalidation } from "../../../src/components/systems/shared/adapters/workspace-event-source";
import { installFetch } from "../helpers/fake-fetch";

const boardId = "00000000-0000-4000-8000-000000000001";
const sourceId = "00000000-0000-4000-8000-000000000002";
const moduleId = "00000000-0000-4000-8000-000000000003";
const departmentId = "00000000-0000-4000-8000-000000000004";
const fieldId = "00000000-0000-4000-8000-000000000005";
const stageId = "00000000-0000-4000-8000-000000000006";
const recordId = "00000000-0000-4000-8000-000000000007";
const timestamp = "2026-10-26T00:00:00Z";

const sourceWire = {
  id: sourceId,
  module_id: moduleId,
  module_name: "Quotes",
  department_id: departmentId,
  date_field_id: fieldId,
  field_name: "Valid until",
  field_type: "date",
  position: 0,
};
const source = {
  id: sourceId,
  moduleId,
  moduleName: "Quotes",
  departmentId,
  dateFieldId: fieldId,
  fieldName: "Valid until",
  fieldType: "date",
  position: 0,
};

test("board calendar sources list, add, and remove on the board's own path", async () => {
  const mock = installFetch((input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "POST")
      return Response.json(sourceWire, { status: 201 });
    return Response.json({ items: [sourceWire] });
  });
  try {
    expect(await listBoardCalendarSources(boardId)).toEqual([source]);
    expect(
      await addBoardCalendarSource(boardId, { moduleId, dateFieldId: fieldId }),
    ).toEqual(source);
    await removeBoardCalendarSource(boardId, sourceId);
    expect(
      mock.requests.map(({ input, init }) => [
        init?.method ?? "GET",
        String(input),
        init?.body ?? null,
      ]),
    ).toEqual([
      ["GET", `/api/boards/${boardId}/calendar-sources`, null],
      [
        "POST",
        `/api/boards/${boardId}/calendar-sources`,
        JSON.stringify({ module_id: moduleId, date_field_id: fieldId }),
      ],
      ["DELETE", `/api/boards/${boardId}/calendar-sources/${sourceId}`, null],
    ]);
  } finally {
    mock.restore();
  }
});

test("Add to My calendar posts a copy to the person's own sources", async () => {
  const mock = installFetch(() => Response.json(sourceWire, { status: 201 }));
  try {
    expect(
      await addMyCalendarSource({ moduleId, dateFieldId: fieldId }),
    ).toEqual(source);
    expect(String(mock.requests[0]?.input)).toBe("/api/me/calendar-sources");
    expect(mock.requests[0]?.init?.method).toBe("POST");
  } finally {
    mock.restore();
  }
});

test("the source limit reads as a plain sentence and names no module", async () => {
  for (const [add, expected] of [
    [
      () => addBoardCalendarSource(boardId, { moduleId, dateFieldId: fieldId }),
      "This calendar already has 5 record sources. Remove one to add another.",
    ],
    [
      () => addMyCalendarSource({ moduleId, dateFieldId: fieldId }),
      "My calendar already has 5 record sources. Remove one to add another.",
    ],
  ] as const) {
    const mock = installFetch(() =>
      Response.json(
        {
          detail: {
            code: "calendar_source_limit",
            message: "A calendar holds at most 5 sources: Hidden Payroll",
          },
        },
        { status: 409 },
      ),
    );
    try {
      const failure = await add().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).message).toBe(expected);
      expect((failure as ApiError).code).toBe("calendar_source_limit");
    } finally {
      mock.restore();
    }
  }
});

test("a source list refuses a field type the calendar cannot place", async () => {
  const mock = installFetch(() =>
    Response.json({ items: [{ ...sourceWire, field_type: "text" }] }),
  );
  try {
    await expect(listBoardCalendarSources(boardId)).rejects.toThrow();
  } finally {
    mock.restore();
  }
});

function card(id: string, dueOn: string) {
  return {
    id,
    board_id: boardId,
    stage_id: stageId,
    kind: "objective",
    title: `Card ${id.slice(-1)}`,
    rank: 1,
    assignee_id: null,
    start_on: null,
    due_on: dueOn,
    label_ids: [],
    checklist: { done: 0, total: 0 },
    archived_at: null,
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    record: null,
  };
}

test("Cards · Due reads the visible window and pages to completion", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    card(
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      "2026-11-02",
    ),
  );
  const locked = {
    ...card("00000000-0000-4000-8000-100000000001", "2026-11-03"),
    kind: "record",
    title: null,
    record: { locked: true },
  };
  const readable = {
    ...card("00000000-0000-4000-8000-100000000002", "2026-11-04"),
    kind: "record",
    title: null,
    record: {
      locked: false,
      record_id: recordId,
      module_id: moduleId,
      module_name: "Quotes",
      title: "Q-24118 Cebu",
      fields: [],
      status: null,
    },
  };
  const mock = installFetch((input) => {
    const offset = new URL(String(input), "http://x").searchParams.get(
      "offset",
    );
    return Response.json(
      offset === "0"
        ? {
            items: first,
            pagination: {
              limit: 100,
              offset: 0,
              count: 100,
              total: 102,
              has_more: true,
            },
          }
        : {
            items: [locked, readable],
            pagination: {
              limit: 100,
              offset: 100,
              count: 2,
              total: 102,
              has_more: false,
            },
          },
    );
  });
  try {
    const cards = await listDueBoardCards(boardId, {
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(cards).toHaveLength(102);
    expect(cards.slice(100)).toEqual([
      {
        id: "00000000-0000-4000-8000-100000000001",
        kind: "record",
        title: null,
        dueOn: "2026-11-03",
        stageId,
        assigneeId: null,
        record: { locked: true },
      },
      {
        id: "00000000-0000-4000-8000-100000000002",
        kind: "record",
        title: null,
        dueOn: "2026-11-04",
        stageId,
        assigneeId: null,
        record: {
          locked: false,
          recordId,
          moduleId,
          moduleName: "Quotes",
          title: "Q-24118 Cebu",
        },
      },
    ]);
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      `/api/boards/${boardId}/cards?due_from=2026-11-01&due_to=2026-11-30&limit=100&offset=0`,
      `/api/boards/${boardId}/cards?due_from=2026-11-01&due_to=2026-11-30&limit=100&offset=100`,
    ]);
  } finally {
    mock.restore();
  }
});

test("a calendar source change reaches the stream as a board invalidation", () => {
  expect(
    parseWorkspaceInvalidation(
      "invalidate",
      JSON.stringify({ entity: "board_calendar_sources", board_id: boardId }),
    ),
  ).toEqual({
    type: "invalidate",
    entity: "board_calendar_sources",
    boardId,
  });
});

test("Kanban stage, card and label changes reach the stream as board invalidations", () => {
  for (const entity of ["board_stages", "board_cards", "board_labels"])
    expect(
      parseWorkspaceInvalidation(
        "invalidate",
        JSON.stringify({ entity, board_id: boardId }),
      ),
    ).toEqual({ type: "invalidate", entity, boardId });
});
