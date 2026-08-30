import { expect, test } from "@playwright/test";
import { formatDateTimeLocal } from "../src/lib/date-time";

test.describe("datetime-local formatting", () => {
  test("uses local components that round-trip a minute-precision instant", () => {
    const instant = "2026-01-01T00:30:00.000Z";
    const displayValue = formatDateTimeLocal(instant);

    expect(displayValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(displayValue).toISOString()).toBe(instant);
  });

  test("returns an empty value for invalid inputs", () => {
    expect(formatDateTimeLocal("not-an-instant")).toBe("");
    expect(formatDateTimeLocal(null)).toBe("");
    expect(formatDateTimeLocal(" ")).toBe("");
  });
});
