import { expect, test } from "@playwright/test";

import type { ManageAuditLog } from "../../../src/components/systems/manage/adapters/audit-api";
import {
  auditArea,
  auditChanges,
  auditExportBlockedReason,
  auditFieldIds,
  auditKindLabel,
  auditListEntries,
  auditRowTime,
  auditSentenceName,
  auditSentenceText,
  auditTargetName,
  isSystemEvent,
  readShowSystemEvents,
  writeShowSystemEvents,
} from "../../../src/components/systems/manage/domain/audit-rules";

// Manage relayout MD6, MD7, MD13 and MD16 (docs/specs/manage-relayout.md). The
// http journeys in manage-audit-api.spec.ts show these rules once on screen.

const manila = { timezone: "Asia/Manila", locale: "en-US" };
const recordId = "3f2a1b9c-0000-4000-8000-000000000001";

function log(patch: Partial<ManageAuditLog> = {}): ManageAuditLog {
  return {
    id: "a1c49f02-0000-4000-8000-000000000001",
    created_at: "2026-10-24T07:07:00Z",
    performed_by: null,
    action: "update",
    entity_type: "records",
    entity_id: recordId,
    department_id: null,
    before: null,
    after: null,
    request_id: null,
    request_method: null,
    request_path: null,
    actor_label: null,
    actor_name: null,
    target_label: "Q-1042",
    note: null,
    ...patch,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test("only machine-written kinds count as system events", () => {
  expect(isSystemEvent({ entity_type: "in_app_notifications" })).toBe(true);
  expect(isSystemEvent({ entity_type: "record_trigger_runs" })).toBe(true);
  expect(isSystemEvent({ entity_type: "records" })).toBe(false);
  expect(isSystemEvent({ entity_type: "groups" })).toBe(false);
  expect(isSystemEvent({ entity_type: "organizations" })).toBe(false);
});

test("system events fold into one row where the first sits, and a search lists them all", () => {
  const person = log({ id: "p1" });
  const receiptA = log({ id: "s1", entity_type: "in_app_notifications" });
  const receiptB = log({ id: "s2", entity_type: "in_app_notifications" });
  const later = log({ id: "p2" });
  const rows = [person, receiptA, later, receiptB];
  const shape = (entries: ReturnType<typeof auditListEntries>) =>
    entries.map((entry) =>
      entry.kind === "system"
        ? `fold:${entry.count}:${entry.shown}`
        : entry.log.id,
    );

  expect(
    shape(auditListEntries(rows, { showSystem: false, searching: false })),
  ).toEqual(["p1", "fold:2:false", "p2"]);
  expect(
    shape(auditListEntries(rows, { showSystem: true, searching: false })),
  ).toEqual(["p1", "fold:2:true", "s1", "p2", "s2"]);
  expect(
    shape(auditListEntries(rows, { showSystem: false, searching: true })),
  ).toEqual(["p1", "s1", "p2", "s2"]);
  expect(
    shape(
      auditListEntries([person, later], {
        showSystem: false,
        searching: false,
      }),
    ),
  ).toEqual(["p1", "p2"]);
  // Choosing a system kind as the Area lists its events, never one fold row.
  expect(
    shape(
      auditListEntries([receiptA, receiptB], {
        showSystem: false,
        searching: false,
        entity: "in_app_notifications",
      }),
    ),
  ).toEqual(["s1", "s2"]);
  expect(
    shape(
      auditListEntries(rows, {
        showSystem: false,
        searching: false,
        entity: "records",
      }),
    ),
  ).toEqual(["p1", "fold:2:false", "p2"]);
});

test("the Show choice is remembered per viewer and survives blocked storage", () => {
  const storage = memoryStorage();
  expect(readShowSystemEvents("viewer-a", storage)).toBe(false);
  writeShowSystemEvents("viewer-a", true, storage);
  expect(readShowSystemEvents("viewer-a", storage)).toBe(true);
  expect(readShowSystemEvents("viewer-b", storage)).toBe(false);
  writeShowSystemEvents("viewer-a", false, storage);
  expect(readShowSystemEvents("viewer-a", storage)).toBe(false);

  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(readShowSystemEvents("viewer-a", blocked)).toBe(false);
  expect(() => writeShowSystemEvents("viewer-a", true, blocked)).not.toThrow();
});

test("changed values read as words: Not set, Yes and No, Hidden, and organization dates", () => {
  const changes = auditChanges(
    log({
      before: {
        status: "draft",
        read_at: null,
        is_pinned: false,
        due_on: "2026-10-30",
        token_hint: "[REDACTED]",
        tags: [],
      },
      after: {
        status: "sent",
        read_at: "2026-10-24T07:07:00Z",
        is_pinned: true,
        due_on: "2026-11-02",
        token_hint: "[REDACTED]",
        tags: ["urgent", "east"],
      },
    }),
    manila,
  );
  expect(
    changes.map(({ label, before, after }) => [label, before, after]),
  ).toEqual([
    ["Status", "draft", "sent"],
    ["Read at", "Not set", "Oct 24, 2026, 3:07 PM"],
    ["Pinned", "No", "Yes"],
    ["Due on", "Oct 30, 2026", "Nov 2, 2026"],
    ["Token hint", "Hidden", "Hidden"],
    ["Tags", "None", "urgent, east"],
  ]);
});

test("a created record lists only values that differ; record fields keyed by id keep a short name", () => {
  const fieldId = "9e8d7c6b-0000-4000-8000-000000000009";
  expect(
    auditChanges(
      log({
        action: "create",
        after: { module_id: null, data: { [fieldId]: 12 } },
      }),
      manila,
    ).map(({ label, before, after }) => [label, before, after]),
  ).toEqual([["Field 9e8d7c6b", "Not set", "12"]]);
});

test("targets use the record name, else the kind and the record id, never a table name", () => {
  expect(auditTargetName(log())).toBe("Q-1042");
  expect(
    auditTargetName(log({ entity_type: "groups", target_label: "Sales Desk" })),
  ).toBe("Group Sales Desk");
  expect(
    auditTargetName(
      log({
        entity_type: "in_app_notifications",
        target_label: "In App Notifications · name unavailable",
      }),
    ),
  ).toBe("Notification 3f2a1b9c");
  expect(
    auditTargetName(
      log({ target_label: "Records · name unavailable", entity_id: null }),
    ),
  ).toBe("Record");
  expect(
    auditTargetName(
      log({
        entity_type: "unknown_table",
        target_label: "Unknown Table · name unavailable",
      }),
    ),
  ).toBe("Item 3f2a1b9c");
});

test("the sentence names the change, up to two changed fields and the target, in the dot form", () => {
  const fieldA = "9e8d7c6b-0000-4000-8000-00000000000a";
  const fieldB = "9e8d7c6b-0000-4000-8000-00000000000b";
  const fieldC = "9e8d7c6b-0000-4000-8000-00000000000c";
  const update = (keys: string[]) =>
    log({
      before: Object.fromEntries(keys.map((key) => [key, "a"])),
      after: Object.fromEntries(keys.map((key) => [key, "b"])),
    });
  expect(auditSentenceText(update(["status"]))).toBe("Changed Status · Q-1042");
  expect(auditSentenceText(update(["status", "sent_on"]))).toBe(
    "Changed Status, Sent on · Q-1042",
  );
  expect(
    auditSentenceText(
      update(["status", "sent_on", "priority", "owner", "due_on"]),
    ),
  ).toBe("Changed Status, Sent on +3 · Q-1042");
  // A record's values are keyed by field id; without names they are counted.
  const record = log({
    before: { data: { [fieldA]: 1, [fieldB]: 2, [fieldC]: 3 } },
    after: { data: { [fieldA]: 4, [fieldB]: 5, [fieldC]: 6 } },
  });
  expect(auditSentenceText(record)).toBe("Changed 3 fields · Q-1042");
  expect(auditSentenceText(record, new Map([[fieldA, "Quantity"]]))).toBe(
    "Changed Quantity +2 · Q-1042",
  );
  expect(auditSentenceText(log({ action: "create" }))).toBe("Created · Q-1042");
  expect(
    auditSentenceText(
      log({
        action: "delete",
        entity_type: "fields",
        target_label: "Old notes",
      }),
    ),
  ).toBe("Deleted · Field Old notes");
  // The accessible name reads a period where the row shows the dot.
  expect(auditSentenceName(update(["status", "sent_on"]))).toBe(
    "Changed Status, Sent on. Q-1042",
  );
  expect(auditSentenceName(log({ action: "create" }))).toBe("Created. Q-1042");
});

test("record field ids on a page are listed once, and their names label the changes", () => {
  const fieldA = "9e8d7c6b-0000-4000-8000-00000000000a";
  const fieldB = "9e8d7c6b-0000-4000-8000-00000000000b";
  const first = log({
    before: { data: { [fieldA]: 1 } },
    after: { data: { [fieldA]: 2, [fieldB]: "x" } },
  });
  const second = log({
    id: "second",
    before: { status: "a", data: { [fieldA]: 2 } },
    after: { status: "b", data: { [fieldA]: 3 } },
  });
  expect(
    auditFieldIds([first, second, log({ after: { title: "Pump" } })]),
  ).toEqual([fieldA, fieldB]);
  expect(
    auditChanges(first, manila, new Map([[fieldA, "Quantity"]])).map(
      ({ label }) => label,
    ),
  ).toEqual(["Quantity", "Field 9e8d7c6b"]);
});

test("the Area filter names a kind and its page once", () => {
  expect(auditKindLabel("records")).toBe("Records · Sandbox");
  expect(auditKindLabel("in_app_notifications")).toBe("Notifications");
  expect(auditKindLabel("unknown_table")).toBe("Items · Other");
  // Internal glossary words become the customer words (Phase 7, MG7).
  expect(auditKindLabel("sandbox_bindings")).toBe("Live item links · Sandbox");
  expect(auditKindLabel("sandbox_publications")).toBe(
    "Published changes · Sandbox",
  );
  expect(auditKindLabel("memberships")).toBe("Organization members · Access");
  expect(auditKindLabel("report_run_rows")).toBe("Report results · OpenView");
});

test("the area names the department, else the page of the kind", () => {
  const departments = new Map([["dept-1", "Sales"]]);
  expect(auditArea(log({ department_id: "dept-1" }), departments)).toBe(
    "Sales",
  );
  expect(auditArea(log({ department_id: "dept-9" }), departments)).toBe(
    "Sandbox",
  );
  expect(auditArea(log({ entity_type: "groups" }), departments)).toBe("Access");
  expect(
    auditArea(log({ entity_type: "in_app_notifications" }), departments),
  ).toBe("Notifications");
  expect(auditArea(log({ entity_type: "unknown_table" }), departments)).toBe(
    "Other",
  );
});

test("row times read Today and Yesterday in the organization zone, then a date", () => {
  const now = new Date("2026-10-24T10:00:00Z");
  expect(auditRowTime("2026-10-24T07:07:00Z", now, manila)).toBe(
    "Today 3:07 PM",
  );
  expect(auditRowTime("2026-10-23T09:40:00Z", now, manila)).toBe(
    "Yesterday 5:40 PM",
  );
  // 23:30 UTC on the 23rd is already the 24th in Manila.
  expect(auditRowTime("2026-10-23T23:30:00Z", now, manila)).toBe(
    "Today 7:30 AM",
  );
  expect(auditRowTime("2026-10-22T01:05:00Z", now, manila)).toBe(
    "Oct 22, 9:05 AM",
  );
  expect(auditRowTime("2025-10-22T01:05:00Z", now, manila)).toBe(
    "Oct 22, 2025, 9:05 AM",
  );
  // Row names add seconds, so two events in one minute keep unique names.
  expect(
    auditRowTime("2026-10-24T07:07:42Z", now, manila, { seconds: true }),
  ).toBe("Today 3:07:42 PM");
  expect(
    auditRowTime("2026-10-22T01:05:09Z", now, manila, { seconds: true }),
  ).toBe("Oct 22, 9:05:09 AM");
  // A personal date order shows the whole date, in that order.
  expect(
    auditRowTime("2026-10-22T01:05:00Z", now, {
      ...manila,
      dateFormat: "ymd",
      timeFormat: "24h",
    }),
  ).toBe("2026-10-22 9:05");
});

test("Export is blocked with its reason only above 10,000 matching events", () => {
  expect(auditExportBlockedReason(10_000)).toBeNull();
  expect(auditExportBlockedReason(0)).toBeNull();
  expect(auditExportBlockedReason(10_001)).toBe(
    "Narrow the filters to 10,000 events or fewer to export.",
  );
});
