import { expect, test } from "@playwright/test";

import {
  attentionItems,
  departmentAccess,
  lastSignInSegments,
  recentSignIns,
  signedInNow,
  signInPage,
  type SignInCursor,
  type SignInPage,
} from "../../../src/components/systems/access/helpers/overview-dashboard";
import { overviewSignInRequests } from "../../../src/components/systems/access/adapters/access-queries";
import type {
  AccessSecurityEvent,
  AccessSecurityEventsRequest,
} from "../../../src/components/systems/access/adapters/security-events-api";
import type { AccessGroup } from "../../../src/components/systems/access/state/api-contracts";

const id = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("the last-sign-in bar splits active and invited people into seven segments that add up", () => {
  const bar = lastSignInSegments({
    active: 49,
    pending: 3,
    signedInNow: 3,
    inactive: { 1: 33, 7: 13, 30: 4 },
    neverSignedIn: 5,
  });
  expect(bar.segments.map((segment) => [segment.id, segment.count])).toEqual([
    ["now", 3],
    ["today", 8],
    ["week", 20],
    ["month", 9],
    ["older", 4],
    ["never", 5],
    ["invited", 3],
  ]);
  expect(bar).toMatchObject({ now: 3, today: 11, week: 31, total: 52 });
  expect(bar.label).toBe(
    "52 people by last sign-in: 3 now, 8 earlier in the last day, 20 earlier in the last 7 days, 9 earlier in the last 30 days, 4 older, 5 never signed in, 3 invited",
  );
});

test("the bar never shows a negative segment when the counts disagree", () => {
  // More people signed in now than active within a day, and summaries read
  // at slightly different moments: every segment is clamped and the total
  // still equals active plus invited.
  const bar = lastSignInSegments({
    active: 4,
    pending: 0,
    signedInNow: 6,
    inactive: { 1: 0, 7: 2, 30: 3 },
    neverSignedIn: 1,
  });
  expect(bar.segments.map((segment) => segment.count)).toEqual([
    3, 0, 0, 0, 0, 1, 0,
  ]);
  expect(bar.total).toBe(4);
});

test("signed in now counts each person once, however many sessions they have", () => {
  const sessions = [
    { user_id: id(1), person_name: "Ana" },
    { user_id: id(2), person_name: "Ben" },
    { user_id: id(1), person_name: "Ana" },
  ];
  expect(signedInNow(sessions)).toEqual([
    { id: id(1), name: "Ana" },
    { id: id(2), name: "Ben" },
  ]);
});

function event(
  index: number,
  fields: Partial<AccessSecurityEvent>,
): AccessSecurityEvent {
  return {
    id: id(700 + index),
    occurred_at: `2026-10-06T${String(10 + index).padStart(2, "0")}:00:00Z`,
    event_type: "identity.sign_in",
    outcome: "success",
    source: "identity.login",
    operation_id: id(900),
    actor_id: id(1),
    subject_id: id(1),
    labels: {},
    fingerprint: null,
    reason: null,
    request_id: null,
    request_method: null,
    request_path: null,
    metadata: { ip_address: "198.51.100.7" },
    ...fields,
  };
}

test("recent sign-ins merge the reads newest first and keep only sign-in results", () => {
  const signIns = [
    event(5, {}),
    event(3, {
      event_type: "identity.sign_in_failure",
      outcome: "failure",
      actor_id: null,
      subject_id: null,
      metadata: { ip_address: "203.0.113.9" },
    }),
    // A search on "identity.sign_in" can match other types; they are dropped.
    event(4, { event_type: "identity.sign_in_other" }),
  ];
  const lockouts = [
    event(6, {
      event_type: "identity.lockout",
      outcome: "denied",
      actor_id: null,
      subject_id: id(2),
      metadata: {},
    }),
    event(5, {}),
  ];
  expect(recentSignIns([signIns, lockouts], 10)).toEqual([
    {
      id: id(706),
      occurredAt: "2026-10-06T16:00:00Z",
      personId: id(2),
      address: null,
      result: "locked",
    },
    {
      id: id(705),
      occurredAt: "2026-10-06T15:00:00Z",
      personId: id(1),
      address: "198.51.100.7",
      result: "signed-in",
    },
    {
      id: id(703),
      occurredAt: "2026-10-06T13:00:00Z",
      personId: null,
      address: "203.0.113.9",
      result: "failed",
    },
  ]);
  expect(recentSignIns([signIns, lockouts], 1)).toHaveLength(1);
});

/**
 * The security-events list as the server answers it
 * (app/systems/manage/audit/service.py): `search` matches the event type by
 * substring, `event_type` exactly, `occurred_after` is inclusive,
 * `occurred_before` exclusive, and rows sort by time, then id, before the
 * limit. Times keep their microseconds, as PostgreSQL does.
 */
function serverRead(
  events: readonly AccessSecurityEvent[],
  request: AccessSecurityEventsRequest,
): AccessSecurityEvent[] {
  // Microseconds since the epoch stay below 2^53, so a number holds them.
  const micros = (value: string) => {
    const [whole, fraction = ""] = value.replace("Z", "").split(".");
    return (
      Date.parse(`${whole}Z`) * 1000 +
      Number(fraction.padEnd(6, "0").slice(0, 6))
    );
  };
  const direction = request.sort_order === "asc" ? 1 : -1;
  return events
    .filter(
      (item) =>
        (!request.search || item.event_type.includes(request.search)) &&
        (!request.event_type || item.event_type === request.event_type) &&
        (!request.occurred_after ||
          micros(item.occurred_at) >= micros(request.occurred_after)) &&
        (!request.occurred_before ||
          micros(item.occurred_at) < micros(request.occurred_before)),
    )
    .sort((left, right) => {
      const time = micros(left.occurred_at) - micros(right.occurred_at);
      if (time !== 0) return time > 0 ? direction : -direction;
      return (left.id > right.id ? 1 : -1) * direction;
    })
    .slice(0, request.limit);
}

test("sign-in pages turn by time with no gap or repeat, back and forth", () => {
  const events = [
    event(1, { occurred_at: "2026-10-06T15:00:00Z" }),
    event(2, { occurred_at: "2026-10-06T14:00:00Z" }),
    // A failed sign-in and its lockout are written at one instant, and that
    // instant falls on the first page's last row.
    event(3, {
      occurred_at: "2026-10-06T13:00:00.000500Z",
      event_type: "identity.sign_in_failure",
      outcome: "failure",
    }),
    event(4, {
      occurred_at: "2026-10-06T13:00:00.000500Z",
      event_type: "identity.lockout",
      outcome: "denied",
    }),
    event(5, { occurred_at: "2026-10-06T12:00:00Z" }),
    // Not a sign-in: no read returns it.
    event(6, {
      occurred_at: "2026-10-06T11:30:00Z",
      event_type: "identity.mfa.enrolled",
    }),
    event(7, { occurred_at: "2026-10-06T11:00:00Z" }),
    // A lockout between two sign-ins.
    event(8, {
      occurred_at: "2026-10-06T10:00:00Z",
      event_type: "identity.lockout",
      outcome: "denied",
    }),
    event(9, { occurred_at: "2026-10-06T09:00:00Z" }),
  ];
  const turn = (cursor: SignInCursor) =>
    signInPage(
      overviewSignInRequests(cursor).map((request) =>
        serverRead(events, request),
      ),
      cursor,
      3,
    );
  const edge = (
    page: SignInPage,
    direction: "older" | "newer",
  ): SignInCursor => {
    const row = direction === "older" ? page.rows.at(-1) : page.rows[0];
    return row ? { direction, at: row.occurredAt, id: row.id } : null;
  };
  const shown = (page: SignInPage) => ({
    ids: page.rows.map((row) => row.id),
    hasNewer: page.hasNewer,
    hasOlder: page.hasOlder,
  });

  const first = turn(null);
  const second = turn(edge(first, "older"));
  const third = turn(edge(second, "older"));
  expect([first, second, third].map(shown)).toEqual([
    { ids: [id(701), id(702), id(704)], hasNewer: false, hasOlder: true },
    { ids: [id(703), id(705), id(707)], hasNewer: true, hasOlder: true },
    { ids: [id(708), id(709)], hasNewer: true, hasOlder: false },
  ]);

  const backToSecond = turn(edge(third, "newer"));
  const backToFirst = turn(edge(backToSecond, "newer"));
  expect([backToSecond, backToFirst].map(shown)).toEqual([
    { ids: [id(703), id(705), id(707)], hasNewer: true, hasOlder: true },
    { ids: [id(701), id(702), id(704)], hasNewer: false, hasOlder: true },
  ]);
});

test("Newer returns the rows nearest the cursor when more events are newer than one read holds", () => {
  // 60 sign-ins one minute apart, 10:00 newest; the cursor is the oldest.
  const events = Array.from({ length: 60 }, (_, index) =>
    event(index, {
      id: id(1000 + index),
      occurred_at: new Date(
        Date.parse("2026-10-06T10:00:00Z") - index * 60_000,
      ).toISOString(),
    }),
  );
  const cursor: SignInCursor = {
    direction: "newer",
    at: "2026-10-06T09:01:00.000Z",
    id: id(1059),
  };
  const page = signInPage(
    overviewSignInRequests(cursor).map((request) =>
      serverRead(events, request),
    ),
    cursor,
    3,
  );
  expect(page.rows.map((row) => row.id)).toEqual([
    id(1056),
    id(1057),
    id(1058),
  ]);
  expect(page.hasNewer).toBe(true);
});

const zero = {
  administrators: 2,
  adminsWithoutTwoStep: 0,
  adminsTwoStepUnknown: 0,
  pendingInvitations: 0,
  withoutGroup: 0,
  groupsWithoutAccess: 0,
  groupsWithoutMembers: 0,
  guestsEndingSoon: 0,
};

test("needs attention lists counts above zero, administrators without two-step first", () => {
  const { items, clear } = attentionItems({
    ...zero,
    adminsWithoutTwoStep: 2,
    pendingInvitations: 3,
    withoutGroup: 4,
  });
  expect(
    items.map((item) => [item.id, item.text, item.verb, item.href, item.tone]),
  ).toEqual([
    [
      "adminsWithoutTwoStep",
      "administrators without two-step",
      "Review",
      "/access?view=people&role=admin&mfa=without",
      "warn",
    ],
    [
      "pendingInvitations",
      "invitations not accepted",
      "Review",
      "/access?view=people&status=pending",
      "info",
    ],
    [
      "withoutGroup",
      "people in no group",
      "Add to groups",
      "/access?view=people&group=none",
      "info",
    ],
  ]);
  expect(clear).toEqual([
    "groups without access",
    "groups without members",
    "guest access ending soon",
  ]);
});

test("one active administrator is an attention item; unknown two-step links to its own list", () => {
  const { items, clear } = attentionItems({
    ...zero,
    administrators: 1,
    adminsTwoStepUnknown: 1,
  });
  expect(items.map((item) => [item.id, item.count, item.text])).toEqual([
    ["administrators", 1, "active administrator"],
    ["adminsTwoStepUnknown", 1, "administrator, two-step unknown"],
  ]);
  expect(items[0]).toMatchObject({
    tone: "warn",
    detail: "Make a second person an administrator.",
    href: "/access?view=people&role=admin&status=active",
  });
  expect(items[1]?.href).toBe("/access?view=people&role=admin&mfa=unknown");
  expect(clear).toContain("administrators without two-step");
});

function group(
  index: number,
  members: string[],
  access: { department: string; level: "read" | "write" | "manage" }[],
): AccessGroup {
  return {
    id: id(500 + index),
    name: `Group ${index}`,
    description: "",
    revision: 1,
    member_ids: members,
    access: access.map((entry, position) => ({
      department_id: entry.department,
      module_id: position % 2 ? id(800 + index) : null,
      level: entry.level,
      department_name: "Unused",
      module_name: null,
    })),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  };
}

test("access by department counts each person once at their highest level", () => {
  const inventory = id(41);
  const finance = id(42);
  const rows = departmentAccess(
    [
      { id: inventory, name: "Inventory" },
      { id: finance, name: "Finance" },
      { id: id(43), name: "Sales" },
    ],
    [
      group(
        1,
        [id(1), id(2), id(3)],
        [{ department: inventory, level: "read" }],
      ),
      // A module entry counts on its department.
      group(
        2,
        [id(2)],
        [
          { department: finance, level: "read" },
          { department: inventory, level: "manage" },
        ],
      ),
      group(3, [id(3)], [{ department: inventory, level: "write" }]),
    ],
  );
  expect(rows).toEqual([
    {
      id: inventory,
      name: "Inventory",
      people: 3,
      read: 1,
      write: 1,
      manage: 1,
    },
    { id: finance, name: "Finance", people: 1, read: 1, write: 0, manage: 0 },
    { id: id(43), name: "Sales", people: 0, read: 0, write: 0, manage: 0 },
  ]);
});

test("a guest counts at Read whatever level the group gives", () => {
  const inventory = id(41);
  const rows = departmentAccess(
    [{ id: inventory, name: "Inventory" }],
    [group(1, [id(1), id(2)], [{ department: inventory, level: "manage" }])],
    new Set([id(2)]),
  );
  expect(rows).toEqual([
    {
      id: inventory,
      name: "Inventory",
      people: 2,
      read: 1,
      write: 0,
      manage: 1,
    },
  ]);
});
