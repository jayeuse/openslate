import { expect, test } from "@playwright/test";

import {
  activeFilterCount,
  defaultDirectoryFilters,
  directoryFiltersFromParams,
  directoryParams,
  endsInLabel,
  lastActiveLabel,
  quickStatusFilters,
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

test("status quick filters name the directory status they apply, and only other filters count as active", () => {
  expect(
    quickStatusFilters.map((filter) => [filter.label, filter.status]),
  ).toEqual([
    ["All", "current"],
    ["Active", "active"],
    ["Invited", "pending"],
    ["Ending soon", "ending"],
    ["Disabled", "disabled"],
  ]);
  // The segmented control shows a quick status, so it is not a hidden filter.
  expect(
    activeFilterCount({ ...defaultDirectoryFilters, status: "pending" }),
  ).toBe(0);
  // Expired, Deleted and Everyone live only under More filters.
  expect(
    activeFilterCount({ ...defaultDirectoryFilters, status: "expired" }),
  ).toBe(1);
  expect(
    activeFilterCount({
      ...defaultDirectoryFilters,
      status: "ending",
      role: "guest",
      history: "inactive",
    }),
  ).toBe(2);
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
