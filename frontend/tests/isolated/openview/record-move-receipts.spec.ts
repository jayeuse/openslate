import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  updateOpenViewRecordMoves,
  type OpenViewRecordMove,
} from "../../../src/components/systems/openview/adapters/records-api";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const moduleId = id(1900);
const startId = id(1904);
const endId = id(1905);
const laneId = id(1906);
const recordId = id(1910);
const revision = "2026-03-05T12:00:00Z";

type Receipt = { status: number; body: unknown };

function updated(data: Record<string, string>) {
  return {
    record_id: recordId,
    status: "updated",
    record: {
      id: recordId,
      module_id: moduleId,
      data,
      display_values: {},
      created_at: revision,
      updated_at: "2026-03-05T12:01:00Z",
      deleted_at: null,
      is_deleted: false,
      performed_by: id(1),
    },
  };
}

// A Timeline move stages the start and the end of one record together.
const compound: OpenViewRecordMove = {
  recordId,
  revision,
  changes: [
    { fieldId: startId, value: "2026-03-07" },
    { fieldId: endId, value: "2026-03-12" },
  ],
};
const compoundResult = updated({
  [startId]: "2026-03-07",
  [endId]: "2026-03-12",
});
// A Kanban move changes the lane field only.
const single: OpenViewRecordMove = {
  recordId,
  revision,
  fieldId: laneId,
  value: "ready",
};

function save(move: OpenViewRecordMove, receipt: Receipt) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(receipt.body), {
        status: receipt.status,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
  return updateOpenViewRecordMoves({ moduleId, items: [move] }).finally(() => {
    globalThis.fetch = original;
  });
}

test("a confirmed compound receipt returns the updated record", async () => {
  const [result] = await save(compound, {
    status: 200,
    body: { results: [compoundResult] },
  });
  expect(result).toMatchObject({
    status: "updated",
    record_id: recordId,
    record: { data: { [startId]: "2026-03-07", [endId]: "2026-03-12" } },
  });
});

// Each receipt below could hide a partial or foreign write, so the save
// stays unconfirmed. The http journeys keep "missing" and "503" (Timeline)
// and "denied" (Kanban) for the screen's recovery.
for (const fault of [
  {
    name: "half",
    move: compound,
    body: {
      results: [updated({ [startId]: "2026-03-07", [endId]: "2026-03-10" })],
    },
  },
  { name: "missing", move: compound, body: { results: [] } },
  {
    name: "duplicate",
    move: compound,
    body: { results: [compoundResult, compoundResult] },
  },
  {
    name: "foreign",
    move: compound,
    body: { results: [{ ...compoundResult, record_id: id(1999) }] },
  },
  {
    name: "module",
    move: compound,
    body: {
      results: [
        {
          ...compoundResult,
          record: { ...compoundResult.record, module_id: id(1998) },
        },
      ],
    },
  },
  {
    name: "deleted",
    move: compound,
    body: {
      results: [
        {
          ...compoundResult,
          record: { ...compoundResult.record, is_deleted: true },
        },
      ],
    },
  },
  { name: "malformed single", move: single, body: { results: [] } },
]) {
  test(`a ${fault.name} move receipt is a contract error`, async () => {
    await expect(
      save(fault.move, { status: 200, body: fault.body }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });
}

for (const current of [
  { name: "compound", move: compound, detail: "Private batch canary" },
  { name: "single", move: single, detail: "Private failure canary" },
]) {
  test(`an unknown ${current.name} move receipt keeps its 503 status`, async () => {
    const failure = await save(current.move, {
      status: 503,
      body: { detail: current.detail },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(503);
  });
}
