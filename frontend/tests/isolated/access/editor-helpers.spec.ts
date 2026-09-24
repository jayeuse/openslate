import { expect, test } from "@playwright/test";
import {
  applyPatch,
  changedPatch,
  closedDepartmentMemberships,
  hasThreeWayConflict,
  resolveThreeWayValue,
  sameList,
  updateDepartmentSelection,
} from "../../../src/components/systems/access/helpers/editor-helpers";

test("three-way conflict detection ignores untouched or converged fields", () => {
  expect(hasThreeWayConflict("same", "same", "draft")).toBe(false);
  expect(hasThreeWayConflict("current", "baseline", "current")).toBe(false);
  expect(hasThreeWayConflict("current", "baseline", "draft")).toBe(true);
});

test("three-way resolution keeps the selected side of a real conflict", () => {
  expect(resolveThreeWayValue("current", "baseline", "draft", "current")).toBe(
    "current",
  );
  expect(resolveThreeWayValue("current", "baseline", "draft", "draft")).toBe(
    "draft",
  );
  expect(resolveThreeWayValue("current", "baseline", "draft", undefined)).toBe(
    "draft",
  );
  expect(
    resolveThreeWayValue("current", "baseline", "baseline", undefined),
  ).toBe("current");
});

test("list comparison preserves ordered membership semantics", () => {
  expect(sameList(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameList(["a", "b"], ["b", "a"])).toBe(false);
  expect(sameList(["a"], ["a", "b"])).toBe(false);
});

test("changed patches copy only submitted fields and apply immutably", () => {
  const baseline = { name: "Member", grants: ["read"], enabled: true };
  const draft = { name: "Operator", grants: ["read"], enabled: false };
  const patch = changedPatch(baseline, draft, ["name", "grants", "enabled"]);

  expect(patch).toEqual({
    name: "Operator",
    grants: ["read"],
    enabled: false,
  });
  expect(applyPatch(baseline, patch)).toEqual(draft);
  expect(baseline).toEqual({
    name: "Member",
    grants: ["read"],
    enabled: true,
  });
});

test("closed department memberships keep their names and can only be removed", () => {
  const activeIds = new Set(["current"]);
  const identity = {
    departmentIds: ["closed", "current"],
    departments: ["Former operations", "Current team"],
    primaryDepartmentId: "closed",
  };

  expect(
    closedDepartmentMemberships(
      identity.departmentIds,
      activeIds,
      new Map([["closed", "Former operations"]]),
    ),
  ).toEqual([{ id: "closed", name: "Former operations" }]);
  expect(closedDepartmentMemberships(["closed"], activeIds, new Map())).toEqual(
    [{ id: "closed", name: "Closed department" }],
  );
  expect(
    updateDepartmentSelection(identity, "closed", true, activeIds),
  ).toEqual({
    departmentIds: ["closed", "current"],
    primaryDepartmentId: "closed",
  });
  expect(
    updateDepartmentSelection(identity, "closed", false, activeIds),
  ).toEqual({
    departmentIds: ["current"],
    primaryDepartmentId: "current",
  });
  expect(
    updateDepartmentSelection(identity, "current", false, activeIds),
  ).toEqual({
    departmentIds: ["closed"],
    primaryDepartmentId: "closed",
  });
  expect(updateDepartmentSelection(identity, "new", true, activeIds)).toEqual({
    departmentIds: ["closed", "current"],
    primaryDepartmentId: "closed",
  });
});
