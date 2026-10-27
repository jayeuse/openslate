import { expect, test } from "@playwright/test";
import {
  isStaleKanbanWrite,
  kanbanErrorMessage,
} from "../../../src/components/systems/boards/adapters/board-kanban-api";
import {
  listCardActivity,
  readCardSheet,
  saveCardFields,
  updateChecklistItem,
} from "../../../src/components/systems/boards/adapters/board-card-sheet-api";
import type {
  ChecklistItem,
  KanbanCard,
} from "../../../src/components/systems/boards/adapters/board-kanban-schemas";
import {
  canAddChecklistItem,
  cardLink,
  cardMetaLine,
  checklistCount,
  movedChecklist,
} from "../../../src/components/systems/boards/domain/card-sheet";
import { installFetch } from "../helpers/fake-fetch";

const boardId = "00000000-0000-4000-8000-000000000001";
const cardId = "00000000-0000-4000-8000-000000000002";
const stageId = "00000000-0000-4000-8000-000000000003";
const personId = "00000000-0000-4000-8000-000000000004";
const region = { timezone: "UTC", locale: "en-US" };
const stamp = "2026-10-26T00:00:00Z";

function card(extra: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: cardId,
    boardId,
    stageId,
    kind: "objective",
    title: "Renewal terms for Bayview",
    rank: 1024,
    assigneeId: null,
    startOn: null,
    dueOn: null,
    labelIds: [],
    checklist: { done: 0, total: 0 },
    archivedAt: null,
    revision: 4,
    createdAt: stamp,
    updatedAt: stamp,
    record: null,
    ...extra,
  };
}

function item(index: number, done = false): ChecklistItem {
  return {
    id: `00000000-0000-4000-8000-1000000000${String(index).padStart(2, "0")}`,
    cardId,
    text: `Step ${index}`,
    done,
    position: index,
    revision: 1,
  };
}

function wireSheet(extra: Record<string, unknown> = {}) {
  return {
    id: cardId,
    board_id: boardId,
    stage_id: stageId,
    kind: "objective",
    title: "Renewal terms for Bayview",
    rank: 1024,
    assignee_id: null,
    start_on: null,
    due_on: null,
    label_ids: [],
    checklist: { done: 1, total: 2 },
    archived_at: null,
    revision: 5,
    created_at: stamp,
    updated_at: stamp,
    record: null,
    description: "Agree the 2027 terms.",
    checklist_items: [
      { ...wireItem(2), done: false },
      { ...wireItem(1), done: true },
    ],
    ...extra,
  };
}

function wireItem(index: number) {
  const { cardId: card_id, ...rest } = item(index);
  return { ...rest, card_id };
}

test("the meta line names the stage, then the due date, in warn when it is late", () => {
  expect(
    cardMetaLine(card({ dueOn: "2026-10-30" }), "Doing", region, "2026-10-27")
      .text,
  ).toBe("Doing · Due Oct 30");
  expect(
    cardMetaLine(card({ dueOn: "2026-10-22" }), "Doing", region, "2026-10-27"),
  ).toEqual({
    stage: "Doing",
    due: "Overdue · Oct 22",
    late: true,
    text: "Doing · Overdue · Oct 22",
  });
  expect(cardMetaLine(card(), "Doing", region, "2026-10-27").text).toBe(
    "Doing",
  );
});

test("the checklist counts done items, holds at most 50, and moves one place at a time", () => {
  expect(checklistCount([])).toBeNull();
  expect(
    checklistCount([
      item(1, true),
      item(2, true),
      item(3, true),
      item(4),
      item(5),
    ]),
  ).toBe("3/5");
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => item(index));
  expect(canAddChecklistItem(many(49))).toBe(true);
  expect(canAddChecklistItem(many(50))).toBe(false);

  const list = [item(1), item(2), item(3)];
  expect(movedChecklist(list, item(2).id, -1)).toEqual([
    item(2).id,
    item(1).id,
    item(3).id,
  ]);
  expect(movedChecklist(list, item(2).id, 1)).toEqual([
    item(1).id,
    item(3).id,
    item(2).id,
  ]);
  // Already at an end: nothing to send.
  expect(movedChecklist(list, item(1).id, -1)).toBeNull();
  expect(movedChecklist(list, item(3).id, 1)).toBeNull();
});

test("a card's link is its board address with the Kanban and the card only", () => {
  expect(cardLink("https://slate.test", boardId, cardId)).toBe(
    `https://slate.test/boards?board=${boardId}&section=kanban&card=${cardId}`,
  );
});

test("the sheet reads the description and the checklist in order", async () => {
  const mock = installFetch(() => Response.json(wireSheet()));
  try {
    const sheet = await readCardSheet(boardId, cardId);
    expect(sheet.description).toBe("Agree the 2027 terms.");
    expect(sheet.checklist.map((entry) => entry.text)).toEqual([
      "Step 1",
      "Step 2",
    ]);
    expect(sheet.card.revision).toBe(5);
    expect(String(mock.requests[0].input)).toBe(
      `/api/boards/${boardId}/cards/${cardId}`,
    );
  } finally {
    mock.restore();
  }
});

test("a field save sends the revision the edit started from and only the changed fields", async () => {
  const bodies: unknown[] = [];
  const mock = installFetch((_input, init) => {
    bodies.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json(wireSheet());
  });
  try {
    await saveCardFields(
      boardId,
      { id: cardId, revision: 4 },
      { dueOn: "2026-10-30" },
    );
    await saveCardFields(
      boardId,
      { id: cardId, revision: 5 },
      { assigneeId: personId, description: "   " },
    );
    await saveCardFields(
      boardId,
      { id: cardId, revision: 6 },
      { startOn: "", labelIds: [stageId], title: "  New name  " },
    );
    expect(bodies).toEqual([
      { method: "PATCH", body: { revision: 4, due_on: "2026-10-30" } },
      // A blank description clears it.
      {
        method: "PATCH",
        body: { revision: 5, assignee_id: personId, description: null },
      },
      {
        method: "PATCH",
        body: {
          revision: 6,
          title: "New name",
          start_on: null,
          label_ids: [stageId],
        },
      },
    ]);
  } finally {
    mock.restore();
  }
});

test("a stale card or checklist revision is the stale answer, with its own words", async () => {
  const stale = (code: string) =>
    installFetch(() =>
      Response.json(
        { detail: { code, message: "Changed", current_revision: 6 } },
        { status: 409 },
      ),
    );
  const card409 = stale("stale_card_revision");
  try {
    const error = await saveCardFields(
      boardId,
      { id: cardId, revision: 4 },
      { dueOn: "2026-10-30" },
    ).catch((caught: unknown) => caught);
    expect(isStaleKanbanWrite(error)).toBe(true);
    expect(kanbanErrorMessage(error)).toBe("Someone changed this card first.");
  } finally {
    card409.restore();
  }
  const item409 = stale("stale_checklist_revision");
  try {
    const error = await updateChecklistItem(
      boardId,
      { id: item(1).id, revision: 1 },
      { done: true },
    ).catch((caught: unknown) => caught);
    expect(isStaleKanbanWrite(error)).toBe(true);
    expect(kanbanErrorMessage(error)).toBe(
      "Someone changed this checklist first.",
    );
  } finally {
    item409.restore();
  }
  // Another refusal is not stale: it says why, and nothing refetches.
  const limit = installFetch(() =>
    Response.json(
      { detail: { code: "assignee_unavailable", message: "No" } },
      { status: 409 },
    ),
  );
  try {
    const error = await saveCardFields(
      boardId,
      { id: cardId, revision: 4 },
      { assigneeId: personId },
    ).catch((caught: unknown) => caught);
    expect(isStaleKanbanWrite(error)).toBe(false);
    expect(kanbanErrorMessage(error)).toBe(
      "That person cannot read this board.",
    );
  } finally {
    limit.restore();
  }
});

test("card activity reads the newest rows first, a page at a time", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [
        {
          id: item(1).id,
          created_at: stamp,
          kind: "card",
          action: "update",
          summary: "Dates changed",
          actor_label: "ana",
        },
      ],
      pagination: {
        limit: 25,
        offset: 0,
        count: 1,
        total: 1,
        has_more: false,
      },
    }),
  );
  try {
    const page = await listCardActivity(boardId, cardId, 0);
    expect(page).toEqual({
      items: [
        { id: item(1).id, at: stamp, summary: "Dates changed", actor: "ana" },
      ],
      hasMore: false,
    });
    expect(String(mock.requests[0].input)).toBe(
      `/api/boards/${boardId}/cards/${cardId}/activity?limit=25&offset=0&sort_order=desc`,
    );
  } finally {
    mock.restore();
  }
});
