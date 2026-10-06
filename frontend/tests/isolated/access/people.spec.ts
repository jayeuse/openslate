import { expect, test } from "@playwright/test";

import {
  defaultGuestDays,
  directoryRows,
  draftFromUser,
  guestDaysError,
  guestExpiryFromDays,
  personConflicts,
  personPatch,
  personState,
  presentAccess,
  resolvePersonDraft,
} from "../../../src/components/systems/access/helpers/people";
import type {
  AccessDepartment,
  AccessGroup,
  AccessUser,
  AccessUserAccess,
} from "../../../src/components/systems/access/state/api-contracts";
import { accessModule, department, group, ids, user } from "./fixtures";

const now = Date.parse("2026-09-28T12:00:00Z");
const guest = user as AccessUser;
const member: AccessUser = {
  ...guest,
  id: "00000000-0000-4000-8000-000000000011",
  email: "ben@example.com",
  username: "ben",
  role: "member",
  display_name: null,
  job_title: null,
  sponsor_user_id: null,
  expires_at: null,
};
const admin: AccessUser = {
  ...member,
  id: ids.admin,
  email: "root@example.com",
  username: "root",
  role: "admin",
  display_name: "Rosa Admin",
};
const secondDepartment: AccessDepartment = {
  ...(department as AccessDepartment),
  id: "00000000-0000-4000-8000-0000000000d2",
  department_name: "Finance",
};
const inventory = group as AccessGroup;
const finance: AccessGroup = {
  ...inventory,
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "Finance readers",
  member_ids: [guest.id, member.id],
  access: [
    { department_id: secondDepartment.id, module_id: null, level: "read" },
  ],
};
const departments = [department as AccessDepartment, secondDepartment];

test("a person's departments come from the access of their groups, named and sorted", () => {
  const rows = directoryRows(
    [guest, member, admin],
    [inventory, finance],
    departments,
    now,
  );
  const byId = new Map(rows.map((row) => [row.user.id, row]));

  expect(byId.get(guest.id)?.groups.map((item) => item.name)).toEqual([
    "Finance readers",
    "Inventory clerks",
  ]);
  // Inventory is reached twice (department and module rows) but listed once.
  expect(byId.get(guest.id)?.departments.map((item) => item.name)).toEqual([
    "Finance",
    "Inventory",
  ]);
  expect(byId.get(member.id)?.departments.map((item) => item.name)).toEqual([
    "Finance",
  ]);
  // Administrators are not group members and reach every department.
  expect(byId.get(admin.id)?.groups).toEqual([]);
  expect(byId.get(admin.id)?.allDepartments).toBe(true);
});

test("a department the caller cannot name is left out rather than shown as an id", () => {
  const [row] = directoryRows([member], [finance], [], now);
  expect(row?.departments).toEqual([]);
});

test("status shows pending, disabled, deleted, expired and flags guests expiring soon", () => {
  expect(personState({ ...member, status: "pending" }, now).label).toBe(
    "Pending",
  );
  expect(personState({ ...member, status: "disabled" }, now).label).toBe(
    "Disabled",
  );
  expect(personState({ ...member, is_deleted: true }, now).label).toBe(
    "Deleted",
  );
  expect(
    personState({ ...guest, expires_at: "2026-09-27T00:00:00Z" }, now).label,
  ).toBe("Expired");

  const soon = personState(
    { ...guest, expires_at: "2026-10-05T00:00:00Z" },
    now,
  );
  expect(soon).toMatchObject({ label: "Active", expiresSoon: true });
  const later = personState(
    { ...guest, expires_at: "2026-12-30T00:00:00Z" },
    now,
  );
  expect(later.expiresSoon).toBe(false);
  expect(personState(member, now).expiresSoon).toBe(false);
});

test("guest expiry defaults to the invitation setting and stays within 1 to 365 days", () => {
  expect(defaultGuestDays({ guest_duration_days: 45 })).toBe("45");
  expect(defaultGuestDays(undefined)).toBe("");

  expect(guestDaysError("30")).toBeNull();
  expect(guestDaysError("")).toBe("Enter the number of days.");
  expect(guestDaysError("0")).toBe("Enter a whole number from 1 to 365.");
  expect(guestDaysError("366")).toBe("Enter a whole number from 1 to 365.");
  expect(guestDaysError("2.5")).toBe("Enter a whole number from 1 to 365.");

  expect(guestExpiryFromDays("30", new Date(now))).toBe(
    "2026-10-28T12:00:00.000Z",
  );
  expect(guestExpiryFromDays("0", new Date(now))).toBeNull();
});

test("a person patch sends only changed fields and clears empty text to null", () => {
  const baseline = draftFromUser(guest);
  expect(personPatch(baseline, baseline)).toEqual({});
  expect(
    personPatch(baseline, { ...baseline, job_title: " ", display_name: "Ana" }),
  ).toEqual({ job_title: null, display_name: "Ana" });

  const memberBaseline = draftFromUser(member);
  expect(
    personPatch(memberBaseline, { ...memberBaseline, role: "admin" }),
  ).toEqual({ role: "admin" });
  // A guest keeps the guest role; a changed expiry date ends that local day.
  const changed = personPatch(baseline, {
    ...baseline,
    expires_on: "2026-11-15",
  });
  expect(Object.keys(changed)).toEqual(["expires_at"]);
  expect(new Date(changed.expires_at ?? "").getDate()).toBe(15);
});

test("a stale person draft conflicts only where both sides changed the same field", () => {
  const baseline = draftFromUser(member);
  const draft = { ...baseline, role: "admin" as const, job_title: "Lead" };
  const current = { ...baseline, role: "member" as const, display_name: "Ben" };

  // The server changed the display name only; the draft changed the role and
  // job title only: nothing to choose.
  expect(personConflicts(current, baseline, draft)).toEqual([]);
  expect(resolvePersonDraft(current, baseline, draft, {})).toEqual({
    ...draft,
    display_name: "Ben",
  });

  const disagreeing = { ...current, job_title: "Manager" };
  expect(personConflicts(disagreeing, baseline, draft)).toEqual([
    { id: "job_title", label: "Job title", current: "Manager", draft: "Lead" },
  ]);
  expect(
    resolvePersonDraft(disagreeing, baseline, draft, { job_title: "current" })
      .job_title,
  ).toBe("Manager");
});

const access = (
  role: AccessUserAccess["role"],
  unrestricted: boolean,
  entries: AccessUserAccess["entries"] = [],
): AccessUserAccess => ({ user_id: guest.id, role, unrestricted, entries });

test("effective access lists the level per department and module with the groups that give it", () => {
  const view = presentAccess(
    access("member", false, [
      {
        department_id: department.id,
        module_id: accessModule.id,
        level: "write",
        groups: [
          { group_id: inventory.id, name: "Inventory clerks", level: "write" },
        ],
      },
      {
        department_id: department.id,
        module_id: null,
        level: "manage",
        groups: [
          { group_id: finance.id, name: "Finance readers", level: "manage" },
          { group_id: inventory.id, name: "Inventory clerks", level: "manage" },
        ],
      },
    ]),
    member,
    departments,
    [accessModule],
    now,
  );
  expect(view.kind).toBe("entries");
  if (view.kind !== "entries") return;
  expect(
    view.rows.map((row) => [
      row.departmentName,
      row.moduleName,
      row.levelLabel,
      row.sources.map((source) => source.name),
    ]),
  ).toEqual([
    ["Inventory", null, "Manage", ["Finance readers", "Inventory clerks"]],
    ["Inventory", "Prices", "Write", ["Inventory clerks"]],
  ]);
  expect(view.inactive).toBe(false);
  expect(view.guestCapped).toBe(false);
});

test("administrators show full access and guests show the read limit", () => {
  expect(presentAccess(access("admin", true), admin, [], [], now).kind).toBe(
    "full",
  );
  const disabledAdmin = presentAccess(
    access("admin", false),
    { ...admin, status: "disabled" },
    [],
    [],
    now,
  );
  expect(disabledAdmin).toMatchObject({ kind: "full", inactive: true });

  const view = presentAccess(
    access("guest", false, [
      {
        department_id: department.id,
        module_id: null,
        level: "read",
        groups: [
          { group_id: inventory.id, name: "Inventory clerks", level: "write" },
        ],
      },
    ]),
    guest,
    departments,
    [],
    now,
  );
  expect(view).toMatchObject({ kind: "entries", guestCapped: true });
  if (view.kind === "entries") expect(view.rows[0]?.capped).toBe(true);
});
