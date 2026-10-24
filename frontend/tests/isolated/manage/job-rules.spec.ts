import { expect, test } from "@playwright/test";

import {
  jobActions,
  jobAttempts,
  jobKindLabel,
  jobProblem,
  jobStatus,
  jobOtherTime,
  jobSubject,
  jobTime,
} from "../../../src/components/systems/manage/domain/job-rules";

// The words Jobs shows (MD9). The http journey "exact administrator sees
// server-priority composite Jobs and future registry rows" keeps one rendered
// example of the rows, the row menu and the columns.

test("each job state reads as one word with its dot tone, and a new state reads as its name", () => {
  expect(
    [
      "pending",
      "running",
      "failed",
      "succeeded",
      "queued",
      "canceled",
      "interrupted",
      "waiting_external",
      "",
    ].map(jobStatus),
  ).toEqual([
    { word: "Pending", tone: "muted" },
    { word: "Running", tone: "action" },
    { word: "Failed", tone: "danger" },
    { word: "Succeeded", tone: "flow" },
    { word: "Queued", tone: "muted" },
    { word: "Canceled", tone: "muted" },
    { word: "Interrupted", tone: "warn" },
    { word: "Waiting external", tone: "muted" },
    { word: "Unknown", tone: "muted" },
  ]);
});

test("each job kind reads in the server's words, and a new kind reads as its name", () => {
  expect(
    [
      "report-run",
      "post-publish",
      "event-reminder",
      "backup",
      "comms-scheduled-message",
      "comms-export",
      "comms-link-preview",
      "future-work",
    ].map(jobKindLabel),
  ).toEqual([
    "Report run",
    "Post publication",
    "Event reminder",
    "Backup",
    "Scheduled OpenComms message",
    "OpenComms export",
    "Link preview",
    "Future work",
  ]);
});

test("a waiting job shows its next run and every other job its last attempt", () => {
  const times = {
    nextAttemptAt: "2026-10-05T00:00:00Z",
    lastAttemptAt: "2026-10-01T00:05:00Z",
  };
  expect(
    ["pending", "queued", "running", "failed", "succeeded", "canceled"].map(
      (state) => jobTime({ state, ...times }),
    ),
  ).toEqual([
    { label: "Next run", at: "2026-10-05T00:00:00Z" },
    { label: "Next run", at: "2026-10-05T00:00:00Z" },
    { label: "Last attempt", at: "2026-10-01T00:05:00Z" },
    { label: "Last attempt", at: "2026-10-01T00:05:00Z" },
    { label: "Last attempt", at: "2026-10-01T00:05:00Z" },
    { label: "Last attempt", at: "2026-10-01T00:05:00Z" },
  ]);
  // A job that never started has no time to show.
  expect(
    jobTime({ state: "failed", nextAttemptAt: null, lastAttemptAt: null }),
  ).toEqual({ label: "Last attempt", at: null });
});

test("the time a row does not show is kept when it adds a fact", () => {
  const times = {
    nextAttemptAt: "2026-10-05T00:00:00Z",
    lastAttemptAt: "2026-10-01T00:05:00Z",
  };
  expect(
    [
      { state: "pending", attempts: 2 },
      { state: "pending", attempts: 0 },
      { state: "running", attempts: 1 },
      { state: "failed", attempts: 5 },
      { state: "succeeded", attempts: 1 },
    ].map((job) => jobOtherTime({ ...job, ...times })),
  ).toEqual([
    { label: "Last attempt", at: "2026-10-01T00:05:00Z" },
    null,
    { label: "Next run", at: "2026-10-05T00:00:00Z" },
    null,
    null,
  ]);
  expect(
    jobOtherTime({
      state: "running",
      attempts: 1,
      nextAttemptAt: null,
      lastAttemptAt: "2026-10-01T00:05:00Z",
    }),
  ).toBeNull();
});

test("attempts show only above zero, and empty subjects and problems have no words", () => {
  expect([0, 1, 5].map(jobAttempts)).toEqual([null, "1 attempt", "5 attempts"]);
  expect(
    [null, "  ", "The job failed after five attempts."].map((failureLabel) =>
      jobProblem({ failureLabel }),
    ),
  ).toEqual([null, null, "The job failed after five attempts."]);
  expect(
    ["  ", "Weekly Report"].map((subjectLabel) => jobSubject({ subjectLabel })),
  ).toEqual(["Unnamed job", "Weekly Report"]);
});

test("a row offers Retry only when the server allows it, and never Cancel", () => {
  expect(jobActions({ canRetry: true })).toEqual(["retry"]);
  expect(jobActions({ canRetry: false })).toEqual([]);
});
