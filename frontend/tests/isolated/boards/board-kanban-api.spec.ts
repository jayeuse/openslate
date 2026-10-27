import { expect, test } from "@playwright/test";
import { ApiError } from "../../../src/lib/api";
import {
  archiveKanbanStage,
  createRecordCard,
  kanbanErrorMessage,
  listBoardCards,
  moveKanbanCard,
  saveCardDates,
} from "../../../src/components/systems/boards/adapters/board-kanban-api";
import { installFetch } from "../helpers/fake-fetch";

const boardId = "00000000-0000-4000-8000-000000000001";
const stageId = "00000000-0000-4000-8000-000000000002";
const otherStageId = "00000000-0000-4000-8000-000000000003";
const recordId = "00000000-0000-4000-8000-000000000004";
const moduleId = "00000000-0000-4000-8000-000000000005";
const fieldId = "00000000-0000-4000-8000-000000000006";
const stamp = "2026-10-26T00:00:00Z";

function wireCard(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    board_id: boardId,
    stage_id: stageId,
    kind: "objective",
    title: "Book the expo booth crew",
    rank: 1024,
    assignee_id: null,
    start_on: null,
    due_on: null,
    label_ids: [],
    checklist: { done: 0, total: 3 },
    archived_at: null,
    revision: 4,
    created_at: stamp,
    updated_at: stamp,
    record: null,
    ...extra,
  };
}

const page = (offset: number, count: number, total: number) => ({
  limit: 100,
  offset,
  count,
  total,
  has_more: offset + count < total,
});

test("the board's cards are read to the end, with each record card's summary for this viewer", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    wireCard(`00000000-0000-4000-8000-2${String(index).padStart(11, "0")}`),
  );
  const record = wireCard("00000000-0000-4000-8000-300000000001", {
    kind: "record",
    title: null,
    record: {
      locked: false,
      record_id: recordId,
      module_id: moduleId,
      module_name: "Quotes",
      title: "Q-24112",
      fields: [{ field_id: fieldId, name: "Customer", value: "Pacific Rim" }],
      status: { field_id: fieldId, name: "Status", value: "Sent" },
    },
  });
  const mock = installFetch((input) =>
    new URL(String(input), "http://x").searchParams.get("offset") === "0"
      ? Response.json({ items: first, pagination: page(0, 100, 101) })
      : Response.json({ items: [record], pagination: page(100, 1, 101) }),
  );
  try {
    const cards = await listBoardCards(boardId);
    expect(cards).toHaveLength(101);
    expect(cards[100].record).toEqual({
      locked: false,
      recordId,
      moduleId,
      moduleName: "Quotes",
      title: "Q-24112",
      fields: [{ fieldId, name: "Customer", value: "Pacific Rim" }],
      status: { fieldId, name: "Status", value: "Sent" },
    });
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      `/api/boards/${boardId}/cards?limit=100&offset=0`,
      `/api/boards/${boardId}/cards?limit=100&offset=100`,
    ]);
  } finally {
    mock.restore();
  }

  const foreign = installFetch(() =>
    Response.json({
      items: [
        wireCard("00000000-0000-4000-8000-300000000002", {
          board_id: "00000000-0000-4000-8000-00000000ffff",
        }),
      ],
      pagination: page(0, 1, 1),
    }),
  );
  try {
    await expect(listBoardCards(boardId)).rejects.toThrow(
      "The server returned an invalid response",
    );
  } finally {
    foreign.restore();
  }
});

test("a move sends only the stage, the place and the revision", async () => {
  const bodies: unknown[] = [];
  const mock = installFetch((_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      ...wireCard("00000000-0000-4000-8000-300000000003"),
      stage_id: otherStageId,
      revision: 5,
      description: null,
      checklist_items: [],
    });
  });
  try {
    const moved = await moveKanbanCard(boardId, {
      cardId: "00000000-0000-4000-8000-300000000003",
      revision: 4,
      stageId: otherStageId,
      position: 2,
    });
    expect(moved.revision).toBe(5);
    await moveKanbanCard(boardId, {
      cardId: "00000000-0000-4000-8000-300000000003",
      revision: 5,
      stageId: otherStageId,
      position: null,
    });
    expect(bodies).toEqual([
      { revision: 4, stage_id: otherStageId, position: 2 },
      // Appending names no place: the server puts the card last.
      { revision: 5, stage_id: otherStageId },
    ]);
    expect(mock.requests.map(({ init }) => init?.method)).toEqual([
      "PATCH",
      "PATCH",
    ]);
  } finally {
    mock.restore();
  }
});

test("a refused Kanban write says what happened in plain words", async () => {
  const mock = installFetch(() =>
    Response.json(
      {
        detail: {
          code: "stale_card_revision",
          message: "Changed by someone else; reload before saving",
          current_revision: 6,
        },
      },
      { status: 409 },
    ),
  );
  let failure: unknown;
  try {
    await moveKanbanCard(boardId, {
      cardId: "00000000-0000-4000-8000-300000000003",
      revision: 4,
      stageId,
      position: 0,
    });
  } catch (error) {
    failure = error;
  } finally {
    mock.restore();
  }
  expect(failure).toBeInstanceOf(ApiError);
  expect(kanbanErrorMessage(failure)).toBe("Someone changed this card first.");
  expect(
    kanbanErrorMessage(
      new ApiError(409, "x", { code: "stage_unavailable" }, undefined),
    ),
  ).toBe("That stage was archived. Reload the board.");
  expect(
    kanbanErrorMessage(
      new ApiError(409, "x", { code: "record_card_exists" }, undefined),
    ),
  ).toBe("This record already has a card on this board.");
  expect(kanbanErrorMessage(new ApiError(500, "Traceback ..."))).toBe(
    "The change was not saved. Try again.",
  );
});

test("a stage archive names where its cards go; a record card names its record and dates", async () => {
  const bodies: unknown[] = [];
  const mock = installFetch((input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return String(input).endsWith("/archive")
      ? Response.json({
          id: stageId,
          board_id: boardId,
          name: "Waiting",
          color: "chart-4",
          wip_limit: null,
          card_sort: "manual",
          position: 2,
          revision: 3,
          archived_at: stamp,
          card_count: 0,
        })
      : Response.json(
          {
            ...wireCard("00000000-0000-4000-8000-300000000004", {
              kind: "record",
              title: null,
              start_on: "2026-10-20",
              due_on: "2026-11-13",
              record: { locked: true },
            }),
            description: null,
            checklist_items: [],
          },
          { status: 201 },
        );
  });
  try {
    await archiveKanbanStage(boardId, {
      stageId,
      revision: 2,
      cards: "move",
      targetStageId: otherStageId,
    });
    await archiveKanbanStage(boardId, {
      stageId,
      revision: 2,
      cards: "archive",
      targetStageId: null,
    });
    await createRecordCard(boardId, {
      stageId,
      recordId,
      startOn: "2026-10-20",
      dueOn: "2026-11-13",
    });
    expect(bodies).toEqual([
      { revision: 2, cards: "move", target_stage_id: otherStageId },
      { revision: 2, cards: "archive" },
      {
        kind: "record",
        stage_id: stageId,
        record_id: recordId,
        start_on: "2026-10-20",
        due_on: "2026-11-13",
      },
    ]);
  } finally {
    mock.restore();
  }
});

test("Save changes sends every staged card's dates in one batch and reads one result per card", async () => {
  const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-40000000000${n}`);
  const requests: { url: string; method?: string; body: unknown }[] = [];
  const mock = installFetch((input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({
      results: [
        {
          status: "updated",
          card_id: ids[0],
          revision: 5,
          start_on: "2026-10-07",
          due_on: "2026-11-04",
        },
        { status: "stale", card_id: ids[1] },
        { status: "forbidden", card_id: ids[2] },
      ],
    });
  });
  try {
    const results = await saveCardDates(boardId, {
      items: [
        {
          card_id: ids[0],
          revision: 4,
          start_on: "2026-10-07",
          due_on: "2026-11-04",
        },
        { card_id: ids[1], revision: 2, start_on: null, due_on: "2026-10-28" },
        { card_id: ids[2], revision: 1, start_on: null, due_on: "2026-10-29" },
      ],
    });
    expect(results).toEqual([
      {
        status: "updated",
        cardId: ids[0],
        revision: 5,
        startOn: "2026-10-07",
        dueOn: "2026-11-04",
      },
      { status: "stale", cardId: ids[1] },
      { status: "forbidden", cardId: ids[2] },
    ]);
    expect(requests).toEqual([
      {
        url: `/api/boards/${boardId}/cards/batch-dates`,
        method: "POST",
        body: {
          items: [
            {
              card_id: ids[0],
              revision: 4,
              start_on: "2026-10-07",
              due_on: "2026-11-04",
            },
            {
              card_id: ids[1],
              revision: 2,
              start_on: null,
              due_on: "2026-10-28",
            },
            {
              card_id: ids[2],
              revision: 1,
              start_on: null,
              due_on: "2026-10-29",
            },
          ],
        },
      },
    ]);
  } finally {
    mock.restore();
  }

  // A result for a card that was not sent, or a missing one, is refused.
  const wrong = installFetch(() =>
    Response.json({ results: [{ status: "stale", card_id: ids[2] }] }),
  );
  try {
    await expect(
      saveCardDates(boardId, {
        items: [{ card_id: ids[0], revision: 4, start_on: null, due_on: null }],
      }),
    ).rejects.toThrow("The server returned an invalid response");
  } finally {
    wrong.restore();
  }
});
