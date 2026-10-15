import { expect, test } from "@playwright/test";
import {
  hasThreeWayConflict,
  resolveThreeWayValue,
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
