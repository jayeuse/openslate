import { expect, test } from "@playwright/test";

import { constrainFilterValue } from "../../../src/components/sample/openview/filter-editor";

test("bounded filter values stay within the persisted value limit", () => {
  const oversizedNumber = "9".repeat(241);

  expect(constrainFilterValue(oversizedNumber, 240)).toHaveLength(240);
  expect(constrainFilterValue("Open", 240)).toBe("Open");
});

test("unbounded filter values preserve the full input", () => {
  const oversizedNumber = "9".repeat(241);

  expect(constrainFilterValue(oversizedNumber, null)).toBe(oversizedNumber);
});
