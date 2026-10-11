import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Page, Route } from "./test";
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

export type BackupExportFixture = {
  id: string;
  backup_run_id: string;
  state:
    "queued" | "preparing" | "ready" | "failed" | "interrupted" | "expired";
  requested_at: string;
  ready_at: string | null;
  expires_at: string | null;
  size_bytes: number | null;
  sha256: string | null;
  failure_code:
    | "source_unavailable"
    | "source_unproven"
    | "copy_failed"
    | "verification_failed"
    | "export_interrupted"
    | "result_unconfirmed"
    | null;
};

type ExportError = {
  status: 403 | 404 | 409 | 410 | 413 | 416 | 429 | 503 | 504;
  code:
    | "export_not_found"
    | "export_source_unavailable"
    | "export_source_unproven"
    | "export_not_ready"
    | "export_idempotency_conflict"
    | "export_expired"
    | "export_password_invalid"
    | "export_admission_required"
    | "export_navigation_required"
    | "export_password_rate_limited"
    | "export_transfer_busy"
    | "export_preparation_timeout"
    | "export_artifact_invalid"
    | "export_unavailable"
    | "export_identity_conflict"
    | "export_range_unsupported"
    | "export_body_too_large";
  message: string;
  retryAfter?: string;
};

/** A `heldResponse()` from `./test`: the fake enters it, then waits. */
type HeldExportResponse = {
  enter: () => void;
  released: Promise<void>;
};

export const exportFixtureBytes = Buffer.from("owned native export fixture\n");
export const syntheticExportPassphrase = "Harbor-鍵-export-passphrase";
export const syntheticActingPassword = "synthetic-current-password";

export function backupExport(
  sourceId: string,
  values: Partial<BackupExportFixture> = {},
): BackupExportFixture {
  return {
    id: "00000000-0000-4000-8000-000000006001",
    backup_run_id: sourceId,
    state: "queued",
    requested_at: new Date().toISOString(),
    ready_at: null,
    expires_at: null,
    size_bytes: null,
    sha256: null,
    failure_code: null,
    ...values,
  };
}

export function readyBackupExport(
  sourceId: string,
  values: Partial<BackupExportFixture> = {},
): BackupExportFixture {
  const readyAt = new Date();
  return backupExport(sourceId, {
    state: "ready",
    ready_at: readyAt.toISOString(),
    expires_at: new Date(readyAt.getTime() + 86_400_000).toISOString(),
    size_bytes: exportFixtureBytes.byteLength,
    sha256: createHash("sha256").update(exportFixtureBytes).digest("hex"),
    ...values,
  });
}

/**
 * Browser-boundary fakes only. Real claim/HMAC/SQL/stream guarantees are owned
 * by the API/host tests; these observations never retain request secret bodies.
 */
export async function mockManageBackupExports(page: Page, baseURL: string) {
  const backups = await mockManageBackups(page);
  const origin = new URL(baseURL).origin;
  const csrf = "synthetic-export-csrf";
  await page.context().addCookies([
    {
      name: "openslate_csrf",
      value: csrf,
      url: origin,
      sameSite: "Strict",
    },
    {
      name: "openslate_access",
      value: "synthetic-export-session",
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const state = {
    backups,
    actorId: "00000000-0000-4000-8000-000000000001",
    role: "admin" as "admin" | "member" | "guest",
    sessionError: false,
    holdSession: null as HeldExportResponse | null,
    holdCreate: null as HeldExportResponse | null,
    holdAdmission: null as HeldExportResponse | null,
    createError: null as ExportError | null,
    readError: null as ExportError | null,
    readRefused: false,
    admissionError: null as ExportError | null,
    contentError: null as ExportError | null,
    createFailureAfterCommit: false,
    malformedMetadata: false,
    operations: new Map<string, BackupExportFixture>(),
    createSubmissions: 0,
    admissionSubmissions: 0,
    createRequests: [] as {
      sourceId: string;
      key: string;
      passphraseValid: boolean;
      csrfPresent: boolean;
    }[],
    metadataReads: [] as { id: string; actorId: string }[],
    admissionRequests: [] as {
      id: string;
      actorId: string;
      csrfPresent: boolean;
    }[],
    contentRequests: [] as {
      id: string;
      method: string;
      navigation: boolean;
      outcome: "pending" | "denied" | "attempt";
      headersHasAdmission: boolean;
      allHeadersHasAdmission: boolean;
      allHeadersMatchesAdmission: boolean;
      serverCookiePresent: boolean;
      serverCookieMatchesAdmission: boolean;
      responseStatus: number | null;
      responseCode: string | null;
      forwardedProtocolMatches: boolean;
      forwardedHostnameMatches: boolean;
      forwardedPathMatches: boolean;
    }[],
    attempts: 0,
  };
  const replay = new Map<string, { payload: string; id: string }>();
  const admissions = new Map<
    string,
    { handle: string; actorId: string; expiresAt: number }
  >();
  const safeError = (route: Route, error: ExportError) =>
    route.fulfill({
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}),
      },
      json: { detail: { code: error.code, message: error.message } },
    });
  const invalidBody = (route: Route) =>
    route.fulfill({
      status: 422,
      headers: { "Cache-Control": "no-store" },
      json: {
        detail: [
          { loc: ["body"], msg: "Invalid export input.", type: "value_error" },
        ],
      },
    });
  const administrator = async (route: Route) => {
    if (state.role === "admin") return true;
    await route.fulfill({
      status: 403,
      headers: { "Cache-Control": "no-store" },
      json: { detail: { message: "Only administrators can review exports." } },
    });
    return false;
  };
  const readBody = (route: Route): Record<string, unknown> | null => {
    const raw = route.request().postData();
    if (raw === null || Buffer.byteLength(raw, "utf8") > 1024) return null;
    try {
      const body: unknown = JSON.parse(raw);
      return typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const csrfPresent = (route: Route) =>
    route.request().headers()["x-csrf-token"] === csrf;
  const checkCsrf = async (route: Route) => {
    if (csrfPresent(route)) return true;
    await route.fulfill({
      status: 403,
      headers: { "Cache-Control": "no-store" },
      json: { detail: { message: "Request verification failed." } },
    });
    return false;
  };

  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: { id: state.actorId, role: state.role, access: [] },
    }),
  );
  await page.route("**/api/auth/session", async (route) => {
    const held = state.holdSession;
    state.holdSession = null;
    if (held) {
      held.enter();
      await held.released;
    }
    await route.fulfill({
      status: state.sessionError ? 503 : 200,
      json: state.sessionError
        ? { detail: "Session verification unavailable." }
        : {
            authenticated: true,
            user_id: state.actorId,
            setup_required: false,
          },
    });
  });
  await page.route("**/api/backups/exports", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ status: 405 });
      return;
    }
    state.createSubmissions += 1;
    if (!(await administrator(route))) return;
    const body = readBody(route);
    const passphrase = body?.passphrase;
    const sourceId = body?.backup_run_id;
    const key = route.request().headers()["idempotency-key"] ?? "";
    const valid =
      typeof passphrase === "string" &&
      Array.from(passphrase).length >= 16 &&
      Array.from(passphrase).length <= 128 &&
      Buffer.byteLength(passphrase, "utf8") <= 512 &&
      passphrase.trim() === passphrase &&
      !/[\p{C}\p{Z}]/u.test(passphrase.replaceAll(" ", ""));
    state.createRequests.push({
      sourceId: typeof sourceId === "string" ? sourceId : "",
      key,
      passphraseValid: valid,
      csrfPresent: csrfPresent(route),
    });
    if (!(await checkCsrf(route))) return;
    if (
      !body ||
      Object.keys(body).length !== 2 ||
      typeof sourceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        sourceId,
      ) ||
      !valid ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(key)
    ) {
      await invalidBody(route);
      return;
    }
    const held = state.holdCreate;
    if (held) {
      held.enter();
      await held.released;
    }
    if (state.createError) {
      await safeError(route, state.createError);
      return;
    }
    const source = backups.runs.find((run) => run.id === sourceId);
    if (
      !source ||
      source.installation !== "current" ||
      !source.snapshot_id ||
      !source.verified_at ||
      !source.reconciled_at ||
      source.expired_at
    ) {
      await safeError(route, {
        status: 409,
        code: "export_source_unavailable",
        message: "This source backup is unavailable for export.",
      });
      return;
    }
    const payload = createHash("sha256")
      .update(sourceId + "\0" + passphrase)
      .digest("hex");
    const previous = replay.get(state.actorId + ":" + key);
    if (previous && previous.payload !== payload) {
      await safeError(route, {
        status: 409,
        code: "export_idempotency_conflict",
        message: "This request differs from the previous export request.",
      });
      return;
    }
    const operation = previous
      ? state.operations.get(previous.id)!
      : backupExport(sourceId, {
          id:
            "00000000-0000-4000-8000-" +
            String(6001 + state.operations.size).padStart(12, "0"),
        });
    if (!previous) {
      state.operations.set(operation.id, operation);
      replay.set(state.actorId + ":" + key, { payload, id: operation.id });
    }
    if (state.createFailureAfterCommit) {
      state.createFailureAfterCommit = false;
      await safeError(route, {
        status: 503,
        code: "export_unavailable",
        message: "The export request could not be confirmed.",
      });
      return;
    }
    await route.fulfill({
      status: 201,
      headers: {
        "Cache-Control": "no-store",
        Location: "/api/backups/exports/" + operation.id,
      },
      json: operation,
    });
  });
  await page.route(/\/api\/backups\/exports\/[0-9a-f-]+$/i, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 405 });
      return;
    }
    const id = new URL(route.request().url()).pathname
      .split("/")
      .at(-1)!
      .toLowerCase();
    state.metadataReads.push({ id, actorId: state.actorId });
    if (!(await administrator(route))) return;
    if (state.readRefused) {
      await route.fulfill({
        status: 403,
        headers: { "Cache-Control": "no-store" },
        json: {
          detail: { message: "Only administrators can review exports." },
        },
      });
      return;
    }
    if (state.readError) {
      await safeError(route, state.readError);
      return;
    }
    const operation = state.operations.get(id);
    if (!operation) {
      await safeError(route, {
        status: 404,
        code: "export_not_found",
        message: "This export is unavailable.",
      });
      return;
    }
    await route.fulfill({
      headers: { "Cache-Control": "no-store" },
      json: state.malformedMetadata
        ? { ...operation, sha256: "invalid" }
        : operation,
    });
  });
  await page.route(
    /\/api\/backups\/exports\/[0-9a-f-]+\/download-admission$/,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fulfill({ status: 405 });
        return;
      }
      state.admissionSubmissions += 1;
      if (!(await administrator(route))) return;
      const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
      const actorId = state.actorId;
      const body = readBody(route);
      state.admissionRequests.push({
        id,
        actorId,
        csrfPresent: csrfPresent(route),
      });
      if (!(await checkCsrf(route))) return;
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        typeof body.password !== "string" ||
        body.password.length < 1 ||
        body.password.length > 128
      ) {
        await invalidBody(route);
        return;
      }
      const operation = state.operations.get(id);
      if (!operation || operation.state === "expired") {
        await safeError(route, {
          status: operation ? 410 : 404,
          code: operation ? "export_expired" : "export_not_found",
          message: "This export is unavailable.",
        });
        return;
      }
      if (operation.state !== "ready" || !operation.expires_at) {
        await safeError(route, {
          status: 409,
          code: "export_not_ready",
          message: "This export is not ready.",
        });
        return;
      }
      if (state.admissionError || body.password !== syntheticActingPassword) {
        await safeError(
          route,
          state.admissionError ?? {
            status: 403,
            code: "export_password_invalid",
            message: "The current password could not be verified.",
          },
        );
        return;
      }
      const expiresAt = Math.min(
        Date.now() + 600_000,
        Date.parse(operation.expires_at),
      );
      const handle = randomBytes(32).toString("base64url");
      admissions.set(id, { handle, actorId, expiresAt });
      // A held reply represents delayed delivery after accepted admission,
      // so prior-account response handling can be tested independently.
      const held = state.holdAdmission;
      if (held) {
        held.enter();
        await held.released;
      }
      const path = "/api/backups/exports/" + id + "/content";
      await route.fulfill({
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie":
            "openslate_export_admission=" +
            handle +
            "; HttpOnly; SameSite=Strict; Path=" +
            path +
            "; Max-Age=600" +
            (new URL(baseURL).protocol === "https:" ? "; Secure" : ""),
        },
        json: { expires_at: new Date(expiresAt).toISOString() },
      });
    },
  );
  // WebKit exposes provisional intercepted headers without Cookie. Continue
  // native requests to an owned port so admission uses the real wire header.
  const target = new URL(baseURL);
  if (target.protocol !== "http:")
    throw new Error("The synthetic native content fixture requires HTTP.");
  const admissionCookie = (value: string | undefined) =>
    value?.match(/(?:^|;\s*)openslate_export_admission=([^;]+)/)?.[1];
  const contentServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", origin).pathname;
    const id = path.split("/").at(-2)!;
    const observation = state.contentRequests.find(
      (entry) =>
        entry.id === id &&
        entry.method === request.method &&
        entry.outcome === "pending",
    );
    if (
      !/^\/api\/backups\/exports\/[0-9a-f-]+\/content$/.test(path) ||
      !observation
    ) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const cookie = admissionCookie(request.headers.cookie);
    const admission = admissions.get(id);
    observation.serverCookiePresent = Boolean(cookie);
    observation.serverCookieMatchesAdmission =
      Boolean(cookie) && cookie === admission?.handle;
    const deny = (error: ExportError) => {
      observation.outcome = "denied";
      observation.responseStatus = error.status;
      observation.responseCode = error.code;
      response.writeHead(error.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}),
      });
      response.end(
        JSON.stringify({
          detail: { code: error.code, message: error.message },
        }),
      );
    };
    if (request.method !== "GET") {
      observation.outcome = "denied";
      observation.responseStatus = 405;
      response.writeHead(405, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (request.headers.range) {
      deny({
        status: 416,
        code: "export_range_unsupported",
        message: "Confirm again and restart the complete download.",
      });
      return;
    }
    const purpose =
      request.headers["sec-purpose"] ?? request.headers.purpose ?? "";
    if (/prefetch|prerender/i.test(String(purpose))) {
      deny({
        status: 403,
        code: "export_navigation_required",
        message: "Use the explicit download action.",
      });
      return;
    }
    if (
      state.role !== "admin" ||
      !admission ||
      admission.actorId !== state.actorId ||
      admission.expiresAt <= Date.now() ||
      cookie !== admission.handle
    ) {
      deny({
        status: 403,
        code: "export_admission_required",
        message: "Confirm your current password again.",
      });
      return;
    }
    if (state.contentError || state.operations.get(id)?.state !== "ready") {
      deny(
        state.contentError ?? {
          status: 410,
          code: "export_expired",
          message: "This export has expired.",
        },
      );
      return;
    }
    admissions.delete(id);
    state.attempts += 1;
    observation.outcome = "attempt";
    observation.responseStatus = 200;
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition":
        'attachment; filename="openslate-backup-export-' + id + '.tar"',
      "Content-Length": String(exportFixtureBytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "none",
    });
    response.end(exportFixtureBytes);
  });
  let disposed = false;
  const stopContentServer = () => {
    disposed = true;
    contentServer.closeAllConnections();
    if (contentServer.listening) contentServer.close();
    admissions.clear();
    replay.clear();
  };
  page.once("close", stopContentServer);
  page.context().once("close", stopContentServer);
  await new Promise<void>((resolve, reject) => {
    contentServer.once("error", reject);
    contentServer.listen(0, target.hostname, resolve);
  });
  if (disposed || page.isClosed()) {
    stopContentServer();
    throw new Error("The native content fixture was closed during setup.");
  }
  const address = contentServer.address();
  if (!address || typeof address === "string") {
    stopContentServer();
    throw new Error("The native content fixture has no owned loopback port.");
  }
  await page.route(
    /\/api\/backups\/exports\/[0-9a-f-]+\/content$/,
    async (route) => {
      const request = route.request();
      const original = new URL(request.url());
      if (original.origin !== origin)
        throw new Error(
          "Native content must start at the configured browser origin.",
        );
      const id = original.pathname.split("/").at(-2)!;
      const headers = request.headers();
      const allHeaders = await request.allHeaders();
      const forwarded = new URL(original);
      forwarded.port = String(address.port);
      state.contentRequests.push({
        id,
        method: request.method(),
        navigation: request.isNavigationRequest(),
        outcome: "pending",
        headersHasAdmission: Boolean(admissionCookie(headers.cookie)),
        allHeadersHasAdmission: Boolean(admissionCookie(allHeaders.cookie)),
        allHeadersMatchesAdmission:
          Boolean(admissionCookie(allHeaders.cookie)) &&
          admissionCookie(allHeaders.cookie) === admissions.get(id)?.handle,
        serverCookiePresent: false,
        serverCookieMatchesAdmission: false,
        responseStatus: null,
        responseCode: null,
        forwardedProtocolMatches: forwarded.protocol === original.protocol,
        forwardedHostnameMatches: forwarded.hostname === original.hostname,
        forwardedPathMatches: forwarded.pathname === original.pathname,
      });
      await route.continue({ url: forwarded.toString() });
    },
  );
  return state;
}
