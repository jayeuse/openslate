import { expect, test } from "@playwright/test";

import { RecordHistoryView } from "../../../src/components/systems/openview/components/record-history-panel";
import { listOpenViewRecordHistory } from "../../../src/components/systems/openview/adapters/records-api";
import { recordHistoryItems } from "../../../src/components/systems/openview/domain/record-history";
import { installFetch } from "../helpers/fake-fetch";
import { staticMarkup } from "../sandbox/static-markup";

// Record history for every reader (docs/specs/system-health.md, S4-C4,
// S4-C5 and D10): the read each viewer sends (API contract S4, the reader
// path), the second guard that leaves hidden fields out for a reader, the
// old and new values of each change, and the panel's states.

const recordId = "00000000-0000-4000-8000-000000000301";
const departmentId = "00000000-0000-4000-8000-000000000302";
const statusId = "00000000-0000-4000-8000-000000000401";
const amountId = "00000000-0000-4000-8000-000000000402";
const ownerId = "00000000-0000-4000-8000-000000000403";
const hiddenId = "00000000-0000-4000-8000-000000000499";
const region = { locale: "en-US", timezone: "America/New_York" };

const fields = [
  {
    id: statusId,
    name: "Status",
    type: "select",
    config: {
      options: [
        { id: "open", label: "Open" },
        { id: "closed", label: "Closed" },
      ],
    },
  },
  { id: amountId, name: "Amount", type: "number", config: {} },
  { id: ownerId, name: "Owner", type: "user", config: {} },
] as const;

const entry = (
  id: number,
  action: "create" | "update" | "delete",
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  who: { actorName?: string | null; actorLabel?: string | null } = {},
) => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  createdAt: "2026-11-02T14:42:00Z",
  performedBy: null,
  action,
  before,
  after,
  actorName: "actorName" in who ? (who.actorName ?? null) : "Ana Cruz",
  actorLabel: who.actorLabel ?? null,
});

const history = [
  entry(
    6,
    "update",
    { data: { [hiddenId]: "a" } },
    { data: { [hiddenId]: "b" } },
  ),
  entry(
    5,
    "update",
    { data: { [amountId]: "[REDACTED]" } },
    { data: { [amountId]: "[REDACTED]" } },
  ),
  entry(
    4,
    "update",
    { is_deleted: true, data: {} },
    { is_deleted: false, data: {} },
  ),
  entry(
    3,
    "update",
    { data: { [statusId]: "open", [amountId]: 10, [hiddenId]: "x" } },
    { data: { [statusId]: "closed", [amountId]: 12, [hiddenId]: "y" } },
  ),
  entry(2, "delete", { data: {} }, null),
  entry(
    1,
    "create",
    null,
    { data: { [statusId]: "open" } },
    {
      actorName: null,
      actorLabel: null,
    },
  ),
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const emptyPage = {
  items: [],
  pagination: { limit: 50, offset: 0, count: 0, total: 0, has_more: false },
};

test("S4-C5: a manager reads the department's history; a reader reads the record's alone", async () => {
  const fetchStub = installFetch(() => json(emptyPage));
  try {
    await listOpenViewRecordHistory({ recordId, departmentId, manages: true });
    await listOpenViewRecordHistory({ recordId, departmentId, manages: false });
    expect(fetchStub.requests.map((request) => String(request.input))).toEqual([
      `/api/audit-logs?entity_id=${recordId}&department_id=${departmentId}&limit=50`,
      // The reader path: no department, so the server checks the record's
      // own read access (API contract S4).
      `/api/audit-logs?entity_type=records&entity_id=${recordId}&limit=50`,
    ]);
  } finally {
    fetchStub.restore();
  }
});

test("S4-C5: each entry keeps the server's name of the person who made it", async () => {
  const fetchStub = installFetch(() =>
    json({
      ...emptyPage,
      items: [
        {
          id: "00000000-0000-4000-8000-000000000501",
          created_at: "2026-11-02T14:42:00Z",
          performed_by: null,
          action: "create",
          before: null,
          after: { data: {} },
          actor_label: null,
          actor_name: "Ana Cruz",
        },
      ],
      pagination: { ...emptyPage.pagination, count: 1, total: 1 },
    }),
  );
  try {
    const [first] = await listOpenViewRecordHistory({
      recordId,
      departmentId,
      manages: false,
    });
    expect(first?.actorName).toBe("Ana Cruz");
  } finally {
    fetchStub.restore();
  }
});

test("S4-C4: a reader trusts the server's fields and names one beyond the loaded page neutrally", () => {
  // The server leaves out what a reader cannot read, so a key the panel's
  // first page of fields lacks is a live field on a later page: the entry
  // stays and reads "a field" until its name loads. A redacted value still
  // counts as hidden (entry 5 is left out).
  const items = recordHistoryItems(history, {
    fields,
    fieldsComplete: false,
    manages: false,
    region,
  });
  expect(items.map((item) => item.sentence)).toEqual([
    "Changed a field",
    "Restored the record",
    "Changed Status, Amount, a field",
    "Deleted the record",
    "Created the record",
  ]);
  expect(items[0]?.changes).toEqual([
    { key: hiddenId, label: "A field", before: "a", after: "b" },
  ]);
  expect(items[2]?.changes).toEqual([
    { key: statusId, label: "Status", before: "Open", after: "Closed" },
    { key: amountId, label: "Amount", before: "10", after: "12" },
    { key: hiddenId, label: "A field", before: "x", after: "y" },
  ]);
  const text = JSON.stringify(items);
  expect(text).not.toMatch(/no longer shown|Updated the record|Hidden/);
  // Created, Deleted and Restored entries have no change rows.
  expect(items.filter((item) => item.changes.length > 0)).toHaveLength(2);
  // The name comes from the server; with none, "Someone".
  expect(items.map((item) => item.who)).toEqual([
    "Ana Cruz",
    "Ana Cruz",
    "Ana Cruz",
    "Ana Cruz",
    "Someone",
  ]);
  // With every field name loaded, the later field reads by its name.
  const named = recordHistoryItems(history, {
    fields: [
      ...fields,
      { id: hiddenId, name: "Notes", type: "text", config: {} },
    ],
    fieldsComplete: true,
    manages: false,
    region,
  });
  expect(named[0]?.sentence).toBe("Changed Notes");
  expect(named[0]?.changes[0]?.label).toBe("Notes");
});

test("S4-C4: a manager's field missing from an incomplete list is never called retired", () => {
  const items = recordHistoryItems(history, {
    fields,
    fieldsComplete: false,
    manages: true,
    region,
  });
  expect(items[0]?.sentence).toBe("Changed a field");
  expect(items[0]?.changes[0]?.label).toBe("A field");
  expect(JSON.stringify(items)).not.toContain("no longer shown");
});

test("S4-C4: managers keep every entry and today's words for a retired field", () => {
  // The field list is complete, so a missing key is a retired field.
  const items = recordHistoryItems(history, {
    fields,
    fieldsComplete: true,
    manages: true,
    region,
  });
  expect(items.map((item) => item.sentence)).toEqual([
    "Changed a field that is no longer shown",
    // Today's sentence: an unchanged redacted value names no field.
    "Updated the record",
    "Restored the record",
    "Changed Status, Amount, a field that is no longer shown",
    "Deleted the record",
    "Created the record",
  ]);
  expect(items[0]?.changes).toEqual([
    {
      key: hiddenId,
      label: "A field that is no longer shown",
      before: "a",
      after: "b",
    },
  ]);
  expect(items[1]?.changes).toEqual([
    { key: amountId, label: "Amount", before: "Hidden", after: "Hidden" },
  ]);
});

test("S4-C4: a person reads as what happened, never as an ID", () => {
  const owner = (value: unknown) => ({ data: { [ownerId]: value } });
  const items = recordHistoryItems(
    [
      entry(3, "update", owner(null), owner(recordId)),
      entry(2, "update", owner(recordId), owner(departmentId)),
      entry(1, "update", owner(departmentId), owner(null)),
    ],
    { fields, fieldsComplete: true, manages: false, region },
  );
  expect(items.map((item) => item.changes)).toEqual([
    [{ key: ownerId, label: "Owner", before: null, after: "Set" }],
    [{ key: ownerId, label: "Owner", before: null, after: "Changed" }],
    [{ key: ownerId, label: "Owner", before: null, after: "Removed" }],
  ]);
});

const words = (markup: string) => markup.replace(/ class="[^"]*"/g, "");
const view = (state: Parameters<typeof RecordHistoryView>[0]["state"]) =>
  words(
    staticMarkup(RecordHistoryView, {
      state,
      region,
      onRetry: () => {},
    }),
  );

test("S4-C5: a change entry lists each change as old, to, new", () => {
  const markup = view({
    kind: "items",
    items: recordHistoryItems(history.slice(3, 4), {
      fields,
      fieldsComplete: true,
      manages: false,
      region,
    }),
  });
  expect(markup).toContain('<ol aria-label="Record history">');
  expect(markup).toContain(">Changed Status, Amount, a field</p>");
  expect(markup).toMatch(/>Ana Cruz · <time dateTime="2026-11-02T14:42:00Z">/);
  expect(markup).toContain(
    "<span>Status</span><span><span>Open</span> <span>to</span><svg",
  );
  expect(markup).toContain(
    '<path d="m12 5 7 7-7 7"></path></svg> <b>Closed</b>',
  );
});

test("S4-C5: the history says when it is empty, and its error ends with the reference", () => {
  expect(view({ kind: "items", items: [] })).toContain(
    ">No changes are recorded for this record.</p>",
  );
  expect(view({ kind: "loading" })).toContain(">Loading history…</p>");
  const failed = view({
    kind: "error",
    reference: "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c",
  });
  // D10.4, S1-C4: the message, Retry, then the reference.
  const order = [
    ">History could not be loaded.</p>",
    ">Retry</button>",
    ">2e1a0b2c</code>",
  ].map((part) => failed.indexOf(part));
  expect(order.every((position) => position > -1)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});
