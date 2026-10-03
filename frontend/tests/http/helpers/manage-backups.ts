import type { Page } from "./test";
import { installOpenViewEventSource } from "./openview-event-source";

type RunState = "queued" | "running" | "succeeded" | "failed" | "interrupted";
type Schedule = "disabled" | "daily" | "weekly";
export type BackupRunFixture = {
  id: string;
  name: string;
  provenance: "manual" | "scheduled";
  installation: "current" | "previous";
  state: RunState;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  reconciled_at: string | null;
  schedule: Schedule;
  retention_days: 7 | 30 | 90;
  snapshot_id: string | null;
  manifest_sha256: string | null;
  verified_at: string | null;
  failure_code: string | null;
  expired_at: string | null;
};

export function backupRun(
  index: number,
  values: Partial<BackupRunFixture> = {},
): BackupRunFixture {
  return {
    id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`,
    name: `Backup ${index}`,
    provenance: "manual",
    installation: "current",
    state: "succeeded",
    requested_at: `2026-10-0${8 - index}T02:00:00Z`,
    started_at: `2026-10-0${8 - index}T02:01:00Z`,
    finished_at: `2026-10-0${8 - index}T02:05:00Z`,
    reconciled_at: `2026-10-0${8 - index}T02:05:00Z`,
    schedule: "daily",
    retention_days: 30,
    snapshot_id: String(index).repeat(64),
    manifest_sha256: "a".repeat(64),
    verified_at: `2026-10-0${8 - index}T02:04:00Z`,
    failure_code: null,
    expired_at: null,
    ...values,
  };
}

export async function mockManageBackups(page: Page) {
  await installOpenViewEventSource(page);
  const state = {
    policy: {
      schedule: "disabled" as Schedule,
      retention_days: 30 as 7 | 30 | 90,
      revision: 1,
      timezone: "Asia/Manila",
      next_due_at: null as string | null,
      adopted: true,
    },
    runner: {
      state: "unknown" as
        | "unknown"
        | "available"
        | "stale"
        | "recovery_required"
        | "adoption_required",
      last_seen_at: null as string | null,
    },
    runs: Array.from({ length: 6 }, (_, index) => backupRun(index + 1)),
    version: {
      current_version: "0.1.0",
      status: "unavailable" as
        "unknown" | "available" | "current" | "unavailable" | "stale",
      latest_version: null as string | null,
      observed_at: null as string | null,
      checked_at: "2026-10-08T03:00:00Z" as string | null,
      failure_code: "release_unavailable" as string | null,
      release_url: null as string | null,
    },
    statusReadStatus: 200,
    historyReadStatus: 200,
    versionReadStatus: 200,
    malformedStatus: false,
    patchFailure: null as { status: number; code: string } | null,
    queueFailureAfterCommit: false,
    holdWrite: null as Promise<void> | null,
    statusReads: 0,
    versionReads: 0,
    historyReads: [] as URLSearchParams[],
    patches: [] as Record<string, unknown>[],
    queueRequests: [] as { name: string; key: string }[],
    replay: new Map<string, BackupRunFixture>(),
  };
  const status = () => ({
    policy: state.policy,
    runner: state.runner,
    active_run:
      state.runs.find(
        (run) =>
          run.installation === "current" &&
          run.started_at !== null &&
          run.reconciled_at === null,
      ) ?? null,
    queued_count: state.runs.filter(
      (run) => run.installation === "current" && run.state === "queued",
    ).length,
  });
  await page.route("**/api/backups/status", async (route) => {
    if (route.request().method() === "GET") {
      state.statusReads += 1;
      await route.fulfill({
        status: state.statusReadStatus,
        json:
          state.statusReadStatus !== 200
            ? { detail: { code: "unavailable" } }
            : state.malformedStatus
              ? { policy: { schedule: "daily" } }
              : status(),
      });
      return;
    }
    if (route.request().method() !== "PATCH") {
      await route.fulfill({ status: 405 });
      return;
    }
    const body: Record<string, unknown> = route.request().postDataJSON();
    state.patches.push(body);
    if (state.holdWrite) await state.holdWrite;
    const failure = state.patchFailure;
    if (failure || body.revision !== state.policy.revision) {
      await route.fulfill({
        status: failure?.status ?? 409,
        json: { detail: { code: failure?.code ?? "stale_revision" } },
      });
      return;
    }
    if (
      Object.keys(body).some(
        (key) => !["revision", "schedule", "retention_days"].includes(key),
      ) ||
      Object.keys(body).length < 2 ||
      typeof body.revision !== "number"
    )
      throw new Error("Backup PATCH must contain only approved policy fields");
    Object.assign(state.policy, body, { revision: state.policy.revision + 1 });
    state.policy.next_due_at =
      state.policy.schedule === "disabled" ? null : "2026-10-09T18:00:00Z";
    await route.fulfill({ json: status() });
  });
  await page.route(/\/api\/backups(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const body: Record<string, unknown> = route.request().postDataJSON();
      const key = route.request().headers()["idempotency-key"] ?? "";
      if (
        Object.keys(body).length !== 1 ||
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.length > 120 ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(key)
      )
        throw new Error("Backup queue command violates its strict wire");
      state.queueRequests.push({ name: body.name, key });
      if (state.holdWrite) await state.holdWrite;
      const previous = state.replay.get(key);
      if (previous && previous.name !== body.name) {
        await route.fulfill({
          status: 409,
          json: { detail: { code: "backup_idempotency_conflict" } },
        });
        return;
      }
      const run =
        previous ??
        backupRun(7, {
          id: `00000000-0000-4000-8000-${String(900 + state.replay.size).padStart(12, "0")}`,
          name: body.name,
          state: "queued",
          requested_at: "2026-10-08T12:00:00Z",
          started_at: null,
          finished_at: null,
          reconciled_at: null,
          schedule: state.policy.schedule,
          retention_days: state.policy.retention_days,
          snapshot_id: null,
          manifest_sha256: null,
          verified_at: null,
        });
      if (!previous) {
        state.replay.set(key, run);
        state.runs.unshift(run);
      }
      if (state.queueFailureAfterCommit) {
        state.queueFailureAfterCommit = false;
        await route.fulfill({
          status: 503,
          json: { detail: { code: "temporarily_unavailable" } },
        });
        return;
      }
      await route.fulfill({
        status: 201,
        headers: { Location: `/api/backups?run_id=${run.id}` },
        json: run,
      });
      return;
    }
    const query = new URL(route.request().url()).searchParams;
    state.historyReads.push(query);
    if (state.historyReadStatus !== 200) {
      await route.fulfill({
        status: state.historyReadStatus,
        json: { detail: { code: "unavailable" } },
      });
      return;
    }
    const search = (query.get("search") ?? "").toLowerCase();
    const filtered = state.runs.filter(
      (run) =>
        [run.name, run.state, run.provenance, run.snapshot_id ?? ""].some(
          (value) => value.toLowerCase().includes(search),
        ) &&
        ["state", "provenance", "installation", "run_id"].every(
          (field) =>
            !query.has(field) ||
            query.get(field) ===
              (field === "run_id"
                ? run.id
                : run[field as "state" | "provenance" | "installation"]),
        ),
    );
    const sortBy = query.get("sort_by") ?? "requested_at";
    const direction = query.get("sort_order") === "asc" ? 1 : -1;
    filtered.sort(
      (a, b) =>
        direction *
          String(a[sortBy as "requested_at" | "name"] ?? "").localeCompare(
            String(b[sortBy as "requested_at" | "name"] ?? ""),
          ) || a.id.localeCompare(b.id),
    );
    const limit = Number(query.get("limit") ?? 4);
    const offset = Number(query.get("offset") ?? 0);
    const items = filtered.slice(offset, offset + limit);
    await route.fulfill({
      json: {
        items,
        pagination: {
          limit,
          offset,
          count: items.length,
          total: filtered.length,
          has_more: offset + items.length < filtered.length,
        },
      },
    });
  });
  await page.route("**/api/version", async (route) => {
    state.versionReads += 1;
    await route.fulfill({
      status: state.versionReadStatus,
      json:
        state.versionReadStatus === 200
          ? state.version
          : { detail: { code: "unavailable" } },
    });
  });
  return state;
}
