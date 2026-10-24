import { expect, test } from "@playwright/test";

import type { ManageAuditLog } from "../../../src/components/systems/manage/adapters/audit-api";
import {
  auditArea,
  auditChanges,
  auditExportBlockedReason,
  auditFieldIds,
  auditKindLabel,
  auditListEntries,
  auditOnlySystemChanges,
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
  ).toBe("Notification");
  expect(
    auditTargetName(
      log({ target_label: "Records · name unavailable", entity_id: null }),
    ),
  ).toBe("Record");
  expect(
    auditTargetName(
      log({
        entity_type: "unknown_tables",
        target_label: "Unknown Tables · name unavailable",
      }),
    ),
  ).toBe("Unknown table");
});

test("a target with no name is the kind alone and shows no hex id", () => {
  const hexId = /[0-9a-f]{8}/i;
  for (const [entity_type, kind] of [
    ["sandbox_test_runs", "Test run"],
    ["group_members", "Group member"],
    ["memberships", "Organization member"],
    ["in_app_notifications", "Notification"],
  ] as const) {
    const unnamed = log({
      action: "create",
      entity_type,
      entity_id: "01a16a64-0000-4000-8000-000000000001",
      target_label: "X · name unavailable",
      after: { result: {} },
    });
    expect(auditTargetName(unnamed)).toBe(kind);
    expect(auditSentenceText(unnamed)).toBe(`Created · ${kind}`);
    expect(auditSentenceText(unnamed)).not.toMatch(hexId);
  }
});

test("an organization target reads the organization's loaded name, not its id", () => {
  const orgId = "01a14acf-466b-7235-8367-6fa78cc3d7df";
  const organization = log({
    entity_type: "organizations",
    entity_id: orgId,
    target_label: "Organizations · name unavailable",
  });
  expect(
    auditTargetName(organization, {
      organizations: new Map([[orgId, "Harbor Operations Group"]]),
    }),
  ).toBe("Organization Harbor Operations Group");
  // Another organization's id, or no loaded name: the kind alone.
  expect(auditTargetName(organization)).toBe("Organization");
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

// Every table the server audits (`__audit_enabled__` is not False), read
// from backend/app/systems on 2026-10-24.
const AUDITED_TABLES = [
  "backup_export_operations",
  "backup_policies",
  "backup_runs",
  "board_attachments",
  "board_event_reminders",
  "board_events",
  "board_groups",
  "board_post_revision_attachments",
  "board_post_revision_record_links",
  "board_post_revisions",
  "board_posts",
  "board_record_links",
  "board_widgets",
  "boards",
  "charts",
  "comms_capability_grants",
  "comms_categories",
  "comms_channel_access",
  "comms_conversations",
  "comms_direct_blocks",
  "comms_exports",
  "comms_members",
  "comms_mentions",
  "comms_message_attachments",
  "comms_message_record_links",
  "comms_message_revisions",
  "comms_messages",
  "comms_reactions",
  "comms_reports",
  "comms_retention_policies",
  "comms_retention_sweeps",
  "comms_schedules",
  "comms_setting_locks",
  "comms_settings",
  "comms_templates",
  "comms_threads",
  "dashboard_widgets",
  "dashboards",
  "departments",
  "fields",
  "files",
  "group_access",
  "group_members",
  "groups",
  "in_app_notifications",
  "memberships",
  "modules",
  "organizations",
  "platform_operators",
  "platform_settings",
  "record_trigger_actions",
  "record_trigger_conditions",
  "record_trigger_events",
  "record_trigger_runs",
  "record_triggers",
  "records",
  "relationship_edges",
  "report_run_rows",
  "report_runs",
  "report_schedules",
  "reports",
  "sandbox_bindings",
  "sandbox_documents",
  "sandbox_publications",
  "sandbox_test_runs",
  "sandbox_versions",
  "saved_views",
  "update_statuses",
  "users",
];

test("every audited table has its own Area option, never a shared Other", () => {
  expect(AUDITED_TABLES).toHaveLength(69);
  const labels = AUDITED_TABLES.map(auditKindLabel);
  const repeated = labels.filter(
    (label, index) => labels.indexOf(label) !== index,
  );
  expect(repeated).toEqual([]);
  expect(labels.filter((label) => label.endsWith(" · Other"))).toEqual([]);
  // The kinds the hands-on pass found as "Other items".
  expect(auditKindLabel("comms_members")).toBe(
    "Conversation members · OpenComms",
  );
  expect(auditKindLabel("board_posts")).toBe("Posts · Boards");
  expect(auditKindLabel("platform_operators")).toBe(
    "Installation owners · Manage",
  );
});

test("system fields leave What changed and the sentence; a person id reads as a loaded name", () => {
  const orgId = "01a14acf-466b-7235-8367-6fa78cc3d7df";
  const userId = "01a15e0a-0444-7650-bab2-d6f9d32fa48a";
  const conversationId = "01a163e8-1436-7fc9-883d-6fdc17759a47";
  const organization = log({
    entity_type: "organizations",
    entity_id: orgId,
    target_label: "Organizations · name unavailable",
    before: { revision: 8, description: "Hands-on test note" },
    after: { revision: 9, description: null },
  });
  const names = {
    organizations: new Map([[orgId, "Harbor Operations Group"]]),
  };
  expect(auditChanges(organization, manila).map(({ label }) => label)).toEqual([
    "Description",
  ]);
  expect(auditSentenceText(organization, new Map(), names)).toBe(
    "Changed Description · Organization Harbor Operations Group",
  );
  expect(auditOnlySystemChanges(organization)).toBe(false);

  // Only bookkeeping changed: the row says settings, the sheet lists nothing.
  const bookkeeping = log({
    entity_type: "organizations",
    entity_id: orgId,
    target_label: "Organizations · name unavailable",
    before: { revision: 9, updated_at: "2026-10-24T07:00:00Z" },
    after: { revision: 10, updated_at: "2026-10-24T07:07:00Z" },
  });
  expect(auditSentenceText(bookkeeping, new Map(), names)).toBe(
    "Changed settings · Organization Harbor Operations Group",
  );
  expect(auditChanges(bookkeeping, manila)).toEqual([]);
  expect(auditOnlySystemChanges(bookkeeping)).toBe(true);

  // A created conversation member: ids and hashes are system values.
  const member = log({
    action: "create",
    entity_type: "comms_members",
    entity_id: conversationId,
    target_label: "Comms Members · name unavailable",
    after: {
      role: "member",
      org_id: orgId,
      user_id: userId,
      joined_at: "2026-10-22T13:58:00Z",
      conversation_id: conversationId,
      content_hash: "ab12",
      idempotency_key: "k-1",
    },
  });
  const rows = (people?: ReadonlyMap<string, string>) =>
    auditChanges(member, manila, new Map(), { people }).map(
      ({ label, before, after }) => [label, before, after],
    );
  // The member and the conversation are references: a loaded name, else Set.
  expect(rows()).toEqual([
    ["Role", "Not set", "member"],
    ["Person", null, "Set"],
    ["Joined at", "Not set", "Oct 22, 2026, 9:58 PM"],
    ["Conversation", null, "Set"],
  ]);
  expect(rows(new Map([[userId, "HO Manager"]]))).toEqual([
    ["Role", "Not set", "member"],
    ["Person", "Not set", "HO Manager"],
    ["Joined at", "Not set", "Oct 22, 2026, 9:58 PM"],
    ["Conversation", null, "Set"],
  ]);
  // Record values keyed by field id are the record's own fields, not ids.
  const fieldId = "9e8d7c6b-0000-4000-8000-000000000009";
  expect(
    auditChanges(
      log({
        before: { data: { [fieldId]: 1 } },
        after: { data: { [fieldId]: 2 } },
      }),
      manila,
    ).map(({ label }) => label),
  ).toEqual(["Field 9e8d7c6b"]);
});

test("reference columns read as names, or Set, Changed or Removed without an id; only bookkeeping goes to Advanced", () => {
  const groupId = "01a1682c-0000-4000-8000-000000000001";
  const sales = "01a10000-0000-4000-8000-0000000000aa";
  const service = "01a10000-0000-4000-8000-0000000000bb";
  const userId = "01a15e0a-0444-7650-bab2-d6f9d32fa48a";
  const departments = new Map([
    [sales, "Sales"],
    [service, "Service"],
  ]);
  const rows = (changes: ReturnType<typeof auditChanges>) =>
    changes.map(({ label, before, after }) => [label, before, after]);
  const created = log({
    action: "create",
    entity_type: "group_access",
    target_label: "Group Access · name unavailable",
    after: {
      org_id: sales,
      group_id: groupId,
      department_id: sales,
      module_id: null,
      level: "write",
    },
  });
  expect(
    rows(auditChanges(created, manila, new Map(), { departments })),
  ).toEqual([
    ["Group", null, "Set"],
    ["Department", "Not set", "Sales"],
    ["Level", "Not set", "write"],
  ]);
  const moved = log({
    entity_type: "group_access",
    target_label: "Group Access · name unavailable",
    before: { department_id: sales, module_id: groupId, revision: 1 },
    after: { department_id: service, module_id: null, revision: 2 },
  });
  expect(rows(auditChanges(moved, manila, new Map(), { departments }))).toEqual(
    [
      ["Department", "Sales", "Service"],
      ["Module", null, "Removed"],
    ],
  );
  expect(auditSentenceText(moved, new Map(), { departments })).toBe(
    "Changed Department, Module · Group access",
  );
  // `*_by` and blocked_user_id are people; client_key is bookkeeping.
  const conversation = log({
    action: "create",
    entity_type: "comms_conversations",
    target_label: "general",
    after: {
      created_by: userId,
      blocked_user_id: userId,
      client_key: "client-1",
    },
  });
  expect(rows(auditChanges(conversation, manila))).toEqual([
    ["Created by", null, "Set"],
    ["Blocked person", null, "Set"],
  ]);
  expect(
    rows(
      auditChanges(conversation, manila, new Map(), {
        people: new Map([[userId, "HO Manager"]]),
      }),
    ),
  ).toEqual([
    ["Created by", "Not set", "HO Manager"],
    ["Blocked person", "Not set", "HO Manager"],
  ]);
  const changedOwner = log({
    entity_type: "groups",
    target_label: "Sales Desk",
    before: { owner_user_id: userId },
    after: { owner_user_id: groupId },
  });
  expect(rows(auditChanges(changedOwner, manila))).toEqual([
    ["Owner", null, "Changed"],
  ]);
});

test("record values read as option labels and names, or Set without an id", () => {
  const statusField = "9e8d7c6b-0000-4000-8000-00000000000a";
  const ownerField = "9e8d7c6b-0000-4000-8000-00000000000b";
  const unreadField = "9e8d7c6b-0000-4000-8000-00000000000c";
  const quantityField = "9e8d7c6b-0000-4000-8000-00000000000d";
  const openOption = "0b0b0b0b-0000-4000-8000-000000000001";
  const userId = "01a15e0a-0444-7650-bab2-d6f9d32fa48a";
  const created = log({
    action: "create",
    after: {
      data: {
        [statusField]: openOption,
        [ownerField]: userId,
        [unreadField]: "0c0c0c0c-0000-4000-8000-000000000001",
        [quantityField]: 3,
      },
    },
  });
  const fieldNames = new Map([
    [statusField, "Status"],
    [ownerField, "Assigned to"],
    [quantityField, "Quantity"],
  ]);
  const fields = new Map([
    [statusField, { type: "select", options: new Map([[openOption, "Open"]]) }],
    [ownerField, { type: "user", options: new Map<string, string>() }],
    [quantityField, { type: "int", options: new Map<string, string>() }],
  ]);
  expect(
    auditChanges(created, manila, fieldNames, { fields }).map(
      ({ label, before, after }) => [label, before, after],
    ),
  ).toEqual([
    ["Status", "Not set", "Open"],
    ["Assigned to", null, "Set"],
    ["Field 9e8d7c6b", null, "Set"],
    ["Quantity", "Not set", "3"],
  ]);
  expect(
    auditChanges(created, manila, fieldNames, {
      fields,
      people: new Map([[userId, "HO Manager"]]),
    })[1],
  ).toMatchObject({
    label: "Assigned to",
    before: "Not set",
    after: "HO Manager",
  });
});

test("a target without a record name reads a name from its own values before a short id", () => {
  const userId = "01a15e0a-0444-7650-bab2-d6f9d32fa48a";
  const people = new Map([[userId, "HO Manager"]]);
  const unnamed = { target_label: "X · name unavailable" };
  expect(
    auditTargetName(
      log({
        ...unnamed,
        action: "create",
        entity_type: "group_members",
        after: { group_id: "g", user_id: userId },
      }),
      { people },
    ),
  ).toBe("Group member HO Manager");
  expect(
    auditTargetName(
      log({
        ...unnamed,
        entity_type: "users",
        after: { display_name: "Rosa Reyes" },
      }),
    ),
  ).toBe("Person Rosa Reyes");
  expect(
    auditTargetName(
      log({
        ...unnamed,
        entity_type: "platform_settings",
        after: { key: "locale" },
      }),
    ),
  ).toBe("Setting locale");
  // Nothing names a test run: the kind alone is the last resort.
  expect(
    auditTargetName(
      log({
        ...unnamed,
        entity_type: "sandbox_test_runs",
        after: { result: {}, module_id: userId },
      }),
    ),
  ).toBe("Test run");
});

test("retired and future OpenComms tables read in OpenComms words, never Comms", () => {
  expect(auditKindLabel("comms_admissions")).toBe("Join requests · OpenComms");
  expect(auditKindLabel("comms_conversation_groups")).toBe(
    "Conversation group access · OpenComms",
  );
  expect(auditKindLabel("comms_future_things")).toBe(
    "Future things · OpenComms",
  );
  for (const table of [
    "comms_member_preferences",
    "comms_personal_preferences",
    "comms_read_states",
    "comms_thread_follows",
    ...AUDITED_TABLES,
  ])
    expect(auditKindLabel(table), table).not.toMatch(/^Comms /);
});

test("the Area filter names a kind and its page once", () => {
  expect(auditKindLabel("records")).toBe("Records · Sandbox");
  expect(auditKindLabel("in_app_notifications")).toBe("Notifications");
  expect(auditKindLabel("unknown_tables")).toBe("Unknown tables · Other");
  expect(auditKindLabel("other_things")).toBe("Other things · Other");
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
  expect(auditArea(log({ entity_type: "unknown_tables" }), departments)).toBe(
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
