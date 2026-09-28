import { expect, test } from "@playwright/test";

import {
  invitationSettingsErrors,
  invitationSettingsPatch,
  overviewHealth,
} from "../../../src/components/systems/access/helpers/overview";
import {
  directoryFiltersFromParams,
  directoryRows,
  filterDirectory,
} from "../../../src/components/systems/access/helpers/people";
import type {
  AccessGroup,
  AccessUser,
} from "../../../src/components/systems/access/state/api-contracts";
import { group, user } from "./fixtures";

const DAY = 86_400_000;
const now = Date.parse("2026-09-28T12:00:00Z");
const base = { ...user, sponsor_user_id: null, expires_at: null } as AccessUser;
let next = 0;
function person(fields: Partial<AccessUser>): AccessUser {
  next += 1;
  const id = `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  return { ...base, id, username: `user${next}`, role: "member", ...fields };
}

const admin = person({ role: "admin" });
const disabledAdmin = person({ role: "admin", status: "disabled" });
const grouped = person({});
const loose = person({});
const pending = person({ status: "pending" });
const deleted = person({
  is_deleted: true,
  deleted_at: "2026-09-01T00:00:00Z",
});
const endingGuest = person({
  role: "guest",
  expires_at: new Date(now + 3 * DAY).toISOString(),
});
const laterGuest = person({
  role: "guest",
  expires_at: new Date(now + 40 * DAY).toISOString(),
});
const endedGuest = person({
  role: "guest",
  expires_at: new Date(now - DAY).toISOString(),
});
const users = [
  admin,
  disabledAdmin,
  grouped,
  loose,
  pending,
  deleted,
  endingGuest,
  laterGuest,
  endedGuest,
];
const groups: AccessGroup[] = [
  {
    ...(group as AccessGroup),
    id: "00000000-0000-4000-8000-0000000000a1",
    member_ids: [grouped.id, endingGuest.id, laterGuest.id],
  },
  {
    ...(group as AccessGroup),
    id: "00000000-0000-4000-8000-0000000000a2",
    member_ids: [],
    access: [],
  },
];

test("health counts what needs attention, leaving deleted people out", () => {
  const health = overviewHealth(users, groups, now);
  expect(health.administrators).toBe(1);
  // Members and guests with no group: loose, pending and the ended guest.
  expect(health.withoutGroup).toBe(3);
  expect(health.groupsWithoutAccess).toBe(1);
  expect(health.groupsWithoutMembers).toBe(1);
  expect(health.guestsEndingSoon).toBe(1);
  expect(health.pendingInvitations).toBe(1);
});

test("each health link opens a People view with the same count", () => {
  const rows = directoryRows(users, groups, [], now);
  const count = (query: string) =>
    filterDirectory(
      rows,
      directoryFiltersFromParams(new URLSearchParams(query)),
    ).length;
  const health = overviewHealth(users, groups, now);
  expect(count("role=admin&status=active")).toBe(health.administrators);
  expect(count("group=none")).toBe(health.withoutGroup);
  expect(count("status=ending")).toBe(health.guestsEndingSoon);
  expect(count("status=pending")).toBe(health.pendingInvitations);
});

test("filters from the URL fall back to the defaults for unknown values", () => {
  expect(
    directoryFiltersFromParams(new URLSearchParams("role=owner&status=gone")),
  ).toMatchObject({ role: "all", status: "current", groupId: "all" });
});

test("invitation settings accept whole days from 1 to 365", () => {
  expect(
    invitationSettingsErrors({
      invitationExpiryDays: "7",
      guestDurationDays: "365",
    }),
  ).toEqual({});
  expect(
    invitationSettingsErrors({
      invitationExpiryDays: "0",
      guestDurationDays: "",
    }),
  ).toEqual({
    invitationExpiryDays: "Enter a whole number from 1 to 365.",
    guestDurationDays: "Enter the number of days.",
  });
  expect(
    invitationSettingsErrors({
      invitationExpiryDays: "2.5",
      guestDurationDays: "366",
    }),
  ).toEqual({
    invitationExpiryDays: "Enter a whole number from 1 to 365.",
    guestDurationDays: "Enter a whole number from 1 to 365.",
  });
});

test("the settings patch sends only changed values with the revision", () => {
  const saved = {
    invitation_expiry_days: 7,
    guest_duration_days: 30,
    revision: 4,
  };
  expect(
    invitationSettingsPatch(saved, {
      invitationExpiryDays: "7",
      guestDurationDays: "45",
    }),
  ).toEqual({ revision: 4, guest_duration_days: 45 });
  expect(
    invitationSettingsPatch(saved, {
      invitationExpiryDays: "7",
      guestDurationDays: "30",
    }),
  ).toBeNull();
});
