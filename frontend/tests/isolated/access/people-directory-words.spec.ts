import { expect, test } from "@playwright/test";

import {
  activeFilterCount,
  clearedDirectoryFilters,
  defaultDirectoryFilters,
  directoryFilterChips,
  directoryFiltersFromParams,
  directoryParams,
  endsInLabel,
  lastActiveLabel,
  quickStatusFilters,
  rareStatusFilters,
  type DirectoryFilters,
} from "../../../src/components/systems/access/helpers/people";

// The words a People row and its toolbar show: relative last activity, the
// days left for an ending guest, the status quick filters, and the filters a
// People link keeps in its URL.

const now = Date.parse("2026-09-28T12:00:00Z");

test("last active reads as relative time and never claims a sign-in that was not recorded", () => {
  for (const [value, expected] of [
    [null, "Not recorded"],
    ["2026-09-28T11:59:40Z", "Just now"],
    // A clock a little ahead of the browser is still "just now".
    ["2026-09-28T12:00:30Z", "Just now"],
    ["2026-09-28T11:15:00Z", "45 minutes ago"],
    ["2026-09-28T09:00:00Z", "3 hours ago"],
    ["2026-09-27T09:00:00Z", "Yesterday"],
    ["2026-09-23T12:00:00Z", "5 days ago"],
    ["2026-09-07T12:00:00Z", "3 weeks ago"],
    ["2026-06-28T12:00:00Z", "3 months ago"],
    ["2024-09-28T12:00:00Z", "2 years ago"],
  ] as const)
    expect(lastActiveLabel(value, now), String(value)).toBe(expected);
});

test("an ending guest shows the whole days left", () => {
  for (const [value, expected] of [
    ["2026-10-04T12:00:00Z", "Ends in 6 days"],
    ["2026-10-04T08:00:00Z", "Ends in 6 days"],
    ["2026-09-29T12:00:00Z", "Ends in 1 day"],
    ["2026-09-28T18:00:00Z", "Ends today"],
  ] as const)
    expect(endsInLabel(value, now), value).toBe(expected);
});

test("the status strip names every directory status, and status never counts as a Filters filter", () => {
  expect(
    quickStatusFilters.map((filter) => [filter.label, filter.status]),
  ).toEqual([
    ["All", "current"],
    ["Active", "active"],
    ["Invited", "pending"],
    ["Ending soon", "ending"],
    ["Disabled", "disabled"],
  ]);
  // The rare statuses sit under the strip's More menu.
  expect(
    rareStatusFilters.map((filter) => [filter.label, filter.status]),
  ).toEqual([
    ["Expired", "expired"],
    ["Deleted", "deleted"],
    ["Everyone, including deleted", "all"],
  ]);
  // Status lives only in the strip, so no status is a Filters filter.
  for (const status of ["pending", "expired", "deleted", "all"] as const)
    expect(activeFilterCount({ ...defaultDirectoryFilters, status })).toBe(0);
  expect(
    activeFilterCount({
      ...defaultDirectoryFilters,
      status: "ending",
      role: "guest",
      history: "inactive",
    }),
  ).toBe(2);
});

test("active filters read as chips in Filters order, and each chip clears only its own filter", () => {
  const filters: DirectoryFilters = {
    ...defaultDirectoryFilters,
    query: "ben",
    status: "deleted",
    sort: "email",
    role: "admin",
    groupId: "00000000-0000-4000-8000-0000000000a1",
    departmentId: "00000000-0000-4000-8000-0000000000d2",
    mfa: "without",
    history: "inactive",
    inactiveDays: 30,
  };
  const chips = directoryFilterChips(filters, {
    group: "Finance readers",
    department: "Finance",
  });
  expect(chips.map((chip) => [chip.label, chip.value])).toEqual([
    ["Role", "Administrator"],
    ["Group", "Finance readers"],
    ["Department", "Finance"],
    ["Two-step", "Off (administrators)"],
    ["Activity", "Inactive 30 days"],
  ]);
  expect(chips.map((chip) => chip.clear)).toEqual([
    { role: "all" },
    { groupId: "all" },
    { departmentId: "all" },
    { mfa: "all" },
    { history: "all" },
  ]);
  // Words for the other values, and a name that has not loaded yet.
  expect(
    directoryFilterChips(
      {
        ...defaultDirectoryFilters,
        role: "guest",
        groupId: "none",
        departmentId: "00000000-0000-4000-8000-0000000000d2",
        mfa: "unknown",
        history: "no-recorded-sign-in",
      },
      {},
    ).map((chip) => chip.value),
  ).toEqual([
    "Guest",
    "In no group",
    "Selected department",
    "Unknown (administrators)",
    "No recorded sign-in",
  ]);
  expect(
    directoryFilterChips(
      { ...defaultDirectoryFilters, history: "inactive", inactiveDays: 1 },
      {},
    ).map((chip) => chip.value),
  ).toEqual(["Inactive 1 day"]);
  expect(directoryFilterChips(defaultDirectoryFilters, {})).toEqual([]);
  // Clear all keeps the search, the strip's status and the sort.
  expect(clearedDirectoryFilters(filters)).toEqual({
    ...defaultDirectoryFilters,
    query: "ben",
    status: "deleted",
    sort: "email",
  });
});

test("directory filters round-trip through the URL and leave defaults out", () => {
  expect(directoryParams(defaultDirectoryFilters)).toEqual([]);
  const filters: DirectoryFilters = {
    ...defaultDirectoryFilters,
    query: "  ben ",
    role: "member",
    status: "pending",
    groupId: "none",
    departmentId: "00000000-0000-4000-8000-0000000000d2",
    sort: "expiry",
    mfa: "unknown",
    history: "inactive",
    inactiveDays: 45,
  };
  const params = directoryParams(filters);
  expect(params).toEqual([
    ["role", "member"],
    ["status", "pending"],
    ["group", "none"],
    ["department", "00000000-0000-4000-8000-0000000000d2"],
    ["sort", "expiry"],
    ["mfa", "unknown"],
    ["history", "inactive"],
    ["inactive_days", "45"],
  ]);
  // The search text stays out of the URL; everything else comes back.
  expect(directoryFiltersFromParams(new URLSearchParams(params))).toEqual({
    ...filters,
    query: "",
  });
  // The inactivity period belongs only to the inactive history filter.
  expect(
    directoryParams({
      ...defaultDirectoryFilters,
      history: "no-recorded-sign-in",
      inactiveDays: 45,
    }),
  ).toEqual([["history", "no-recorded-sign-in"]]);
});
