import { expect, test } from "@playwright/test";
import {
  buildActivityCsv,
  initialActivityFilters,
  queryManageActivity,
} from "../../src/components/systems/manage/components/audit";
import { completeCollection } from "../../src/components/systems/shared/helpers/page-collections";

test("audit filtering reaches later source rows and export covers every filtered page", () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    user: "Audit test user",
    date: "2026-09-11",
    entity: "Records",
    action: "Update",
    before: "Before",
    after: "After",
    source: "manage" as const,
    id: `entry-${String(index).padStart(2, "0")}`,
    target: index < 10 ? "other" : `needle ${index}`,
  }));
  const result = queryManageActivity(
    completeCollection(entries, "audit"),
    {
      ...initialActivityFilters,
      query: "needle",
      order: "oldest",
    },
    5,
  );
  expect(result.page.total).toBe(20);
  expect(result.page.items.map((entry) => entry.id)).toEqual([
    "entry-15",
    "entry-16",
    "entry-17",
    "entry-18",
    "entry-19",
  ]);
  const csv = buildActivityCsv(result.complete.items);
  expect(csv).toContain("needle 10");
  expect(csv).toContain("needle 29");
  expect(csv).not.toContain("other");
});

test("CSV export quotes multiline text and neutralizes spreadsheet formulas", () => {
  const csv = buildActivityCsv([
    {
      id: "csv",
      user: "\t=1+1",
      date: "2026-09-12",
      entity: "Organization",
      action: "Update",
      target: "+SUM(1,2)",
      before: 'A "quoted" name\nSecond line',
      after: "@formula",
      source: "manage",
    },
  ]);
  expect(csv).toContain('"\'\t=1+1"');
  expect(csv).toContain('"\'+SUM(1,2)"');
  expect(csv).toContain('"A ""quoted"" name\nSecond line"');
  expect(csv).toContain('"\'@formula"');
  expect(csv).toContain("Your change");
});
