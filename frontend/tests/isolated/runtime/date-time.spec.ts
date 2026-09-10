import { expect, test } from "@playwright/test";
import {
  formatDateTimeLocal,
  formatWorkspaceDateTime,
  isSupportedWorkspaceLocale,
} from "../../../src/lib/date-time";

test.describe("datetime-local formatting", () => {
  test("uses local components that round-trip a minute-precision instant", () => {
    const instant = "2026-01-01T00:30:00.000Z";
    const displayValue = formatDateTimeLocal(instant, "America/New_York");

    expect(displayValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(displayValue).toBe("2025-12-31T19:30");
  });

  test("returns an empty value for invalid inputs", () => {
    expect(formatDateTimeLocal("not-an-instant")).toBe("");
    expect(formatDateTimeLocal(null)).toBe("");
    expect(formatDateTimeLocal(" ")).toBe("");
  });
});

test("rejects nonexistent times and requires an offset for duplicated times", async () => {
  const { datetimeInputToUtc, datetimeOffsets } =
    await import("../../../src/lib/date-time");
  expect(() =>
    datetimeInputToUtc("2026-03-08T02:30", "America/New_York"),
  ).toThrow(/does not exist/);
  expect(datetimeOffsets("2026-11-01T01:30", "America/New_York")).toEqual([
    "-04:00",
    "-05:00",
  ]);
  expect(() =>
    datetimeInputToUtc("2026-11-01T01:30", "America/New_York"),
  ).toThrow(/occurs twice/);
  expect(
    datetimeInputToUtc("2026-11-01T01:30", "America/New_York", "-05:00"),
  ).toBe("2026-11-01T06:30:00Z");
  expect(() =>
    datetimeInputToUtc("2026-11-01T01:30", "America/New_York", "+08:00"),
  ).toThrow(/valid UTC offset/);
});

test("keeps calendar dates unchanged across timezones", async () => {
  const { formatWorkspaceDate, formatWorkspaceDateTime } =
    await import("../../../src/lib/date-time");
  expect(
    formatWorkspaceDate("2026-01-01", {
      locale: "en-US",
      timezone: "America/Los_Angeles",
    }),
  ).toBe("Jan 1, 2026");
  expect(
    formatWorkspaceDateTime("2026-01-01T00:30:00Z", {
      locale: "en-US",
      timezone: "America/Los_Angeles",
    }),
  ).toContain("Dec 31, 2025");
});

test("formats invalid stored locales with the en-US fallback", () => {
  for (const locale of ["not_a_locale", "root", "zz-ZZ"]) {
    expect(isSupportedWorkspaceLocale(locale)).toBe(false);
    expect(() =>
      formatWorkspaceDateTime("2026-01-01T00:30:00Z", {
        locale,
        timezone: "America/Los_Angeles",
      }),
    ).not.toThrow();
    expect(
      formatWorkspaceDateTime("2026-01-01T00:30:00Z", {
        locale,
        timezone: "America/Los_Angeles",
      }),
    ).toContain("Dec 31, 2025");
  }
});
