import { expect, test } from "@playwright/test";
import { queryValue } from "../../../src/lib/record-query";

test("preserves decimal precision and distinguishes empty values from missing predicates", () => {
  expect(queryValue("decimal", "eq", "12345678901234567890.123")).toBe(
    "12345678901234567890.123",
  );
  expect(queryValue("text", "eq", "")).toBe("");
  expect(queryValue("text", "empty", "ignored")).toBeNull();
  expect(queryValue("boolean", "eq", "false")).toBe(false);
});

test("serializes only finite numeric query values that match the form grammar", () => {
  expect(queryValue("number", "eq", "2.5")).toBe(2.5);
  expect(queryValue("number", "eq", ".5e2")).toBe(50);
  expect(queryValue("int", "eq", "2e0")).toBe(2);
  expect(queryValue("int", "eq", "9007199254740992")).toBe("9007199254740992");
  expect(queryValue("int", "eq", "2.5")).toBe("2.5");
  expect(queryValue("number", "eq", "1e309")).toBe("1e309");
  expect(queryValue("number", "eq", "12prefix")).toBe("12prefix");
  expect(queryValue("number", "eq", "")).toBe("");
});
