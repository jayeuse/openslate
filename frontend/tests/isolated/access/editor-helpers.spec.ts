import { expect, test } from "@playwright/test";
import {
  applyPatch,
  changedPatch,
  hasThreeWayConflict,
  resolveThreeWayValue,
  sameList,
} from "../../../src/components/sample/access/editor-helpers";

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
