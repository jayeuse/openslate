import { expect, test } from "@playwright/test";

import type {
  ManageBackupRun,
  ManageBackupStatus,
} from "../../../src/components/systems/manage/adapters/backup-api";
import { backupExportSourceAvailable } from "../../../src/components/systems/manage/adapters/backup-api";
import {
  backupExportReason,
  backupRunStatus,
  backupScheduleAtRequest,
  backupStatusFacts,
  shortSnapshotId,
} from "../../../src/components/systems/manage/domain/backup-rules";

// The words of the Backup status panel and history (MD8): the four facts
// from the status payload and the last completed run, the status word of a
// row, and the shortened snapshot id. The http journeys keep one example of
// each: "Backup opens on one status panel of facts, …", "Backup history lists
// 40px rows with a status word, …" and "a backup's detail shows label-left
// facts, a short snapshot id …".

const time = (value: string) => `<${value}>`;

function run(values: Partial<ManageBackupRun> = {}): ManageBackupRun {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    name: "Nightly",
    provenance: "scheduled",
    installation: "current",
    state: "succeeded",
    requested_at: "2026-10-07T02:00:00Z",
    started_at: "2026-10-07T02:01:00Z",
    finished_at: "2026-10-07T02:05:00Z",
    reconciled_at: "2026-10-07T02:05:00Z",
    schedule: "daily",
    retention_days: 30,
    snapshot_id: "a".repeat(64),
    manifest_sha256: "b".repeat(64),
    verified_at: "2026-10-07T02:04:00Z",
    failure_code: null,
    expired_at: null,
    ...values,
  };
}

function status(
  values: {
    policy?: Partial<ManageBackupStatus["policy"]>;
    runner?: Partial<ManageBackupStatus["runner"]>;
    active_run?: ManageBackupRun | null;
    queued_count?: number;
  } = {},
): ManageBackupStatus {
  return {
    policy: {
      schedule: "disabled",
      retention_days: 30,
      revision: 1,
      timezone: "Asia/Manila",
      next_due_at: null,
      adopted: true,
      ...values.policy,
    },
    runner: { state: "unknown", last_seen_at: null, ...values.runner },
    active_run: values.active_run ?? null,
    queued_count: values.queued_count ?? 0,
  };
}

test("the schedule fact says on or off, how often, and how long backups are kept", () => {
  const rows: [
    ManageBackupStatus["policy"]["schedule"],
    7 | 30 | 90,
    string,
  ][] = [
    ["disabled", 30, "Off · Kept 30 days"],
    ["daily", 7, "On · Daily at 02:00 · Kept 7 days"],
    ["weekly", 90, "On · Weekly on Sunday at 02:00 · Kept 90 days"],
  ];
  for (const [schedule, retention_days, words] of rows)
    expect(
      backupStatusFacts(
        status({ policy: { schedule, retention_days } }),
        null,
        time,
      ).schedule,
    ).toBe(words);
});

test("the last good backup names when it finished and its verification, or why it is missing", () => {
  const facts = (lastGood: Parameters<typeof backupStatusFacts>[1]) =>
    backupStatusFacts(status(), lastGood, time).lastGood;
  expect(facts(run())).toBe("<2026-10-07T02:05:00Z> · Verified");
  expect(facts(run({ verified_at: null }))).toBe(
    "<2026-10-07T02:05:00Z> · Not verified yet",
  );
  expect(facts(run({ expired_at: "2026-10-20T00:00:00Z" }))).toBe(
    "<2026-10-07T02:05:00Z> · Verified · Expired",
  );
  expect(facts(null)).toBe("None yet");
  expect(facts("loading")).toBe("Loading…");
  expect(facts("unavailable")).toBe("Not available");
});

test("the service fact and its warning follow the runner state", () => {
  const rows: [
    ManageBackupStatus["runner"]["state"],
    string | null,
    string,
    string | null,
  ][] = [
    [
      "available",
      "2026-10-08T03:00:00Z",
      "Available · Checked in <2026-10-08T03:00:00Z>",
      null,
    ],
    [
      "unknown",
      null,
      "Unknown · Never checked in",
      "The backup service has not checked in yet.",
    ],
    [
      "stale",
      "2026-10-08T03:00:00Z",
      "Not checked in recently · Checked in <2026-10-08T03:00:00Z>",
      "The backup service has not checked in recently.",
    ],
    [
      "recovery_required",
      "2026-10-08T03:00:00Z",
      "Operator recovery required · Checked in <2026-10-08T03:00:00Z>",
      "The person who runs your server must fix the backup service. New requests wait in the queue.",
    ],
    [
      "adoption_required",
      null,
      "Operator adoption required · Never checked in",
      "The person who runs your server must fix the backup service. New requests wait in the queue.",
    ],
  ];
  for (const [state, last_seen_at, words, warning] of rows) {
    const facts = backupStatusFacts(
      status({ runner: { state, last_seen_at } }),
      null,
      time,
    );
    expect(`${facts.service.state} · ${facts.service.detail}`, state).toBe(
      words,
    );
    expect(facts.warning, state).toBe(warning);
  }
});

test("the queue fact counts queued and running backups", () => {
  const queue = (queued_count: number, active_run: ManageBackupRun | null) =>
    backupStatusFacts(status({ queued_count, active_run }), null, time).queue;
  expect(queue(0, null)).toBe("Nothing queued or running");
  expect(queue(2, null)).toBe("2 queued");
  expect(queue(0, run({ state: "running" }))).toBe("1 running");
  expect(queue(1, run({ state: "running" }))).toBe("1 queued · 1 running");
});

test("a history row's status word follows its state, verification and expiry", () => {
  const rows: [Partial<ManageBackupRun>, string, string][] = [
    [{ state: "queued" }, "Queued", "muted"],
    [{ state: "running" }, "Running", "action"],
    [{ state: "succeeded" }, "Verified", "flow"],
    [{ state: "succeeded", verified_at: null }, "Completed", "flow"],
    [
      { state: "succeeded", expired_at: "2026-10-20T00:00:00Z" },
      "Expired",
      "muted",
    ],
    [{ state: "failed" }, "Failed", "danger"],
    [{ state: "interrupted" }, "Interrupted", "warn"],
  ];
  for (const [values, word, tone] of rows)
    expect(backupRunStatus(run(values)), word).toEqual({ word, tone });
});

test("the schedule at request reads the run's own schedule and retention", () => {
  expect(backupScheduleAtRequest(run())).toBe("Daily at 02:00 · Kept 30 days");
  expect(
    backupScheduleAtRequest(run({ schedule: "disabled", retention_days: 7 })),
  ).toBe("Off · Kept 7 days");
});

test("a long snapshot id shortens to its first and last eight characters", () => {
  expect(shortSnapshotId("a1b2c3d4" + "0".repeat(48) + "e5f6a7b8")).toBe(
    "a1b2c3d4…e5f6a7b8",
  );
  expect(shortSnapshotId("12345678901234567")).toBe("12345678901234567");
  expect(shortSnapshotId("x".repeat(18))).toBe("xxxxxxxx…xxxxxxxx");
});

test("a backup that cannot be exported says why, and only an exportable one has no reason", () => {
  const rows: [Partial<ManageBackupRun>, string | null][] = [
    [{}, null],
    [{ state: "failed", failure_code: "retention_failed" }, null],
    [
      { installation: "previous" },
      "Backups from a previous installation cannot be exported.",
    ],
    [{ expired_at: "2026-10-20T00:00:00Z" }, "This backup has expired."],
    [
      {
        state: "queued",
        started_at: null,
        finished_at: null,
        reconciled_at: null,
        snapshot_id: null,
        verified_at: null,
      },
      "This backup has not run yet.",
    ],
    [
      {
        state: "running",
        finished_at: null,
        reconciled_at: null,
        snapshot_id: null,
        verified_at: null,
      },
      "This backup is still running.",
    ],
    [
      { state: "failed", snapshot_id: null, verified_at: null },
      "This backup did not finish, so there is nothing to export.",
    ],
    [{ verified_at: null }, "This backup is not verified yet."],
    [
      { reconciled_at: null },
      "This backup is waiting for the server's restart check.",
    ],
  ];
  for (const [values, reason] of rows) {
    const candidate = run(values);
    expect(backupExportReason(candidate), JSON.stringify(values)).toBe(reason);
    expect(backupExportSourceAvailable(candidate)).toBe(reason === null);
  }
});
