import { expect, test } from "@playwright/test";
import {
  defaultReportScheduleDraft,
  reportScheduleDraftFrom,
  reportSchedulePolicyFrom,
  type ReportScheduleDraft,
} from "../../../src/components/systems/openview/components/report-schedule-controls";

test("new Report schedule starts disabled in the browser's valid IANA timezone", () => {
  expect(defaultReportScheduleDraft("Asia/Manila")).toMatchObject({
    enabled: false,
    timezoneName: "Asia/Manila",
    cadence: "daily",
    localTime: "09:00",
  });
  expect(defaultReportScheduleDraft("+08:00").timezoneName).toBe("UTC");
});

test("existing schedule retains the server policy and never computes the due cursor", () => {
  const draft = reportScheduleDraftFrom({
    id: "00000000-0000-4000-8000-000000000401",
    reportId: "00000000-0000-4000-8000-000000000402",
    revision: 7,
    enabled: true,
    cadence: "weekly",
    timezoneName: "America/New_York",
    localTime: "16:45",
    weekday: 4,
    monthDay: null,
    nextDueAt: "2026-09-25T20:45:00Z",
    lastRun: null,
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
  });
  expect(draft).toEqual({
    enabled: true,
    cadence: "weekly",
    timezoneName: "America/New_York",
    localTime: "16:45",
    weekday: 4,
    monthDay: "1",
  });
  expect(reportSchedulePolicyFrom(draft)).toEqual({
    enabled: true,
    cadence: "weekly",
    timezoneName: "America/New_York",
    localTime: "16:45",
    weekday: 4,
    monthDay: null,
  });
});

test("switching cadence sends the active anchor and clears the inactive one", () => {
  const draft: ReportScheduleDraft = {
    enabled: false,
    cadence: "monthly",
    timezoneName: "UTC",
    localTime: "08:30",
    weekday: 2,
    monthDay: "31",
  };
  expect(reportSchedulePolicyFrom(draft)).toMatchObject({
    weekday: null,
    monthDay: 31,
  });
  expect(
    reportSchedulePolicyFrom({ ...draft, cadence: "daily" }),
  ).toMatchObject({
    weekday: null,
    monthDay: null,
  });
});

test("invalid monthly day is rejected without silently changing the draft", () => {
  const draft: ReportScheduleDraft = {
    ...defaultReportScheduleDraft("UTC"),
    cadence: "monthly",
    monthDay: "",
  };
  expect(() => reportSchedulePolicyFrom(draft)).toThrow(
    "Choose a day from 1 to 31",
  );
  expect(draft.monthDay).toBe("");
});
