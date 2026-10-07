import { createHash } from "node:crypto";
import { expect, test, type Page } from "./helpers/test";
import {
  backupRun,
  exportFixtureBytes,
  mockManageBackupExports,
  readyBackupExport,
  syntheticActingPassword,
  syntheticExportPassphrase,
} from "./helpers/manage-backups";
import { mockManageSecurity } from "./helpers/manage-security";
import { sendOpenViewEvent } from "./helpers/openview-event-source";

// These cases enter synthetic secrets. Keep incumbent files' artifact settings
// intact and retain only explicitly authored, secret-free observations here.
test.use({ trace: "off", screenshot: "off", video: "off" });

function heldReply() {
  let begun = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { begun, release, started, released };
}

async function fixtures(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error("The configured browser origin is required.");
  const security = await mockManageSecurity(page);
  const exports = await mockManageBackupExports(page, baseURL);
  return { security, exports };
}

const selectedBackup = (page: Page) =>
  page.getByRole("region", { name: "Selected backup", exact: true });
const exportPanel = (page: Page) =>
  page.getByRole("region", { name: "Encrypted export", exact: true });
const passphraseDialog = (page: Page) =>
  page.getByRole("dialog").filter({
    has: page.getByLabel("Export passphrase", { exact: true }),
  });
const passwordDialog = (page: Page) =>
  page.getByRole("dialog").filter({
    has: page.getByLabel("Current password", { exact: true }),
  });
const downloadAction = (page: Page) =>
  selectedBackup(page).getByRole("button", {
    name: /^Download(?: backup)?$/,
  });
const nativeLink = (page: Page) =>
  exportPanel(page).getByRole("link", {
    name: "Download encrypted backup",
    exact: true,
  });
const exportLocation = (id: string) =>
  "/manage?view=backup&export=" + encodeURIComponent(id);
const contentPath = (id: string) => "/api/backups/exports/" + id + "/content";

async function requestExport(
  page: Page,
  passphrase = syntheticExportPassphrase,
) {
  await downloadAction(page).click();
  const dialog = passphraseDialog(page);
  await dialog
    .getByLabel("Export passphrase", { exact: true })
    .fill(passphrase);
  await dialog
    .getByRole("button", { name: "Prepare export", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(exportPanel(page)).toContainText(/queued/i);
}

async function confirmDownload(page: Page) {
  await exportPanel(page)
    .getByRole("button", { name: "Confirm download", exact: true })
    .click();
  const dialog = passwordDialog(page);
  await dialog
    .getByLabel("Current password", { exact: true })
    .fill(syntheticActingPassword);
  await dialog
    .getByRole("button", { name: "Confirm password", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(nativeLink(page)).toBeVisible();
}

async function installNativeObservations(page: Page) {
  await page.addInitScript(() => {
    const observed = window as typeof window & {
      backupExportObservations: {
        contentFetches: number;
        objectURLs: number;
      };
    };
    observed.backupExportObservations = { contentFetches: 0, objectURLs: 0 };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const raw = input instanceof Request ? input.url : String(input);
      const path = new URL(raw, window.location.origin).pathname;
      if (/^\/api\/backups\/exports\/[0-9a-f-]+\/content$/.test(path))
        observed.backupExportObservations.contentFetches += 1;
      return originalFetch(input, init);
    };
    const originalObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (value) => {
      observed.backupExportObservations.objectURLs += 1;
      return originalObjectURL(value);
    };
  });
}

type MetadataStart = {
  view: "backup" | "organization" | "other";
  visible: boolean;
  backupMounted: boolean;
};

async function installMetadataObservations(page: Page) {
  await page.addInitScript(() => {
    const observed = window as typeof window & {
      backupExportMetadataStarts: MetadataStart[];
    };
    observed.backupExportMetadataStarts = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const raw = input instanceof Request ? input.url : String(input);
      const path = new URL(raw, window.location.origin).pathname;
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        method.toUpperCase() === "GET" &&
        /^\/api\/backups\/exports\/[0-9a-f-]+$/.test(path)
      ) {
        const view = new URLSearchParams(window.location.search).get("view");
        observed.backupExportMetadataStarts.push({
          view: view === "backup" || view === "organization" ? view : "other",
          visible: document.visibilityState === "visible",
          backupMounted:
            document.querySelector('[aria-label="Backup workspace"]') !== null,
        });
      }
      return originalFetch(input, init);
    };
  });
}

async function metadataStarts(page: Page): Promise<MetadataStart[]> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          backupExportMetadataStarts: MetadataStart[];
        }
      ).backupExportMetadataStarts,
  );
}

test("14 export validates the passphrase before a request and cancels with empty secrets and restored phone focus", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { exports } = await fixtures(page, baseURL);
  await page.goto("/manage?view=backup");
  await expect(selectedBackup(page)).toBeVisible();
  await expect(downloadAction(page)).toBeVisible();
  await downloadAction(page).click();
  const dialog = passphraseDialog(page);
  const passphrase = dialog.getByLabel("Export passphrase", { exact: true });
  for (const invalid of [
    "too-short",
    " " + syntheticExportPassphrase,
    syntheticExportPassphrase + " ",
    "Harbor-\u0001-export-passphrase",
    "Harbor-\u2028-export-passphrase",
    "x".repeat(129),
  ]) {
    await passphrase.fill(invalid);
    await dialog
      .getByRole("button", { name: "Prepare export", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(exports.createSubmissions).toBe(0);
  }
  await passphrase.fill(syntheticExportPassphrase);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(downloadAction(page)).toBeFocused();
  await downloadAction(page).click();
  await expect(passphrase).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(exports.createSubmissions).toBe(0);
});

test("14 export accepts the 128-character Unicode boundary and leaves the existing Backup policy draft untouched", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const policy = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  await policy
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("weekly");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  // 128 printable Unicode characters, exactly 512 UTF-8 bytes.
  await requestExport(page, "🗝".repeat(128));
  expect(exports.createRequests).toHaveLength(1);
  expect(exports.createRequests[0]?.passphraseValid).toBe(true);
  expect(exports.createRequests[0]?.csrfPresent).toBe(true);
  expect(exports.backups.patches).toEqual([]);
  expect(exports.backups.policy.schedule).toBe("disabled");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await expect(
    policy.getByLabel("Backup schedule", { exact: true }),
  ).toHaveValue("weekly");
});

test("14 export validates non-ASCII separators locally and keeps printable Unicode with internal ASCII spaces", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  await page.goto("/manage?view=backup");
  await downloadAction(page).click();
  const dialog = passphraseDialog(page);
  const passphrase = dialog.getByLabel("Export passphrase", { exact: true });
  await passphrase.fill("A\u00a0printable export passphrase");
  await dialog
    .getByRole("button", { name: "Prepare export", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(exports.createSubmissions).toBe(0);
  await passphrase.fill("A printable é export passphrase");
  await dialog
    .getByRole("button", { name: "Prepare export", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(exports.createRequests).toHaveLength(1);
  expect(exports.createRequests[0]?.passphraseValid).toBe(true);
  await expect(exportPanel(page)).toContainText(/queued/i);
});

for (const source of [
  {
    name: "previous installation",
    values: { installation: "previous" as const },
  },
  { name: "unverified source", values: { verified_at: null } },
  { name: "unreconciled source", values: { reconciled_at: null } },
  {
    name: "expired source",
    values: { expired_at: "2026-10-01T00:00:00Z" },
  },
]) {
  test(
    "14 export refuses the " + source.name + " while keeping Restore secondary",
    async ({ page, baseURL }) => {
      const { exports } = await fixtures(page, baseURL);
      exports.backups.runs = [backupRun(1, source.values)];
      await page.goto("/manage?view=backup");
      await expect(selectedBackup(page)).toBeVisible();
      await expect(downloadAction(page)).toBeDisabled();
      await expect(
        selectedBackup(page).getByRole("link", {
          name: "Restore procedure",
          exact: true,
        }),
      ).toHaveAttribute(
        "href",
        "https://github.com/jayeuse/openslate/blob/main/infra/supabase/RESTORE.md",
      );
      expect(exports.createSubmissions).toBe(0);
    },
  );
}

test("14 export permits a verified reconciled retention-failed recovery point and queues only the selected source", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  const source = backupRun(1, {
    state: "failed",
    failure_code: "retention_failed",
  });
  exports.backups.runs = [source];
  await page.goto("/manage?view=backup");
  await expect(downloadAction(page)).toBeEnabled();
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  const backupDialog = page.getByRole("dialog", {
    name: "Back up now",
    exact: true,
  });
  await expect(backupDialog).toContainText(
    "The installation goes offline while this backup runs.",
  );
  await backupDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await downloadAction(page).click();
  const exportDialog = passphraseDialog(page);
  await expect(exportDialog).toContainText(
    "Export preparation leaves the installation online.",
  );
  await exportDialog
    .getByLabel("Export passphrase", { exact: true })
    .fill(syntheticExportPassphrase);
  await exportDialog
    .getByRole("button", { name: "Prepare export", exact: true })
    .click();
  await expect(exportDialog).toBeHidden();
  await expect(exportPanel(page)).toContainText(/queued/i);
  expect(exports.createRequests[0]?.sourceId).toBe(source.id);
  expect(exports.backups.queueRequests).toEqual([]);
  await expect(page).toHaveURL(/view=backup.*export=[0-9a-f-]+/);
  await expect(exportPanel(page)).not.toContainText(
    /saved to disk|download completed/i,
  );
});

test("14 export keeps pending submission exclusive and blocks route leave until acceptance", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  const held = heldReply();
  exports.holdCreate = held;
  await page.goto("/manage?view=backup");
  await downloadAction(page).click();
  const dialog = passphraseDialog(page);
  await dialog
    .getByLabel("Export passphrase", { exact: true })
    .fill(syntheticExportPassphrase);
  try {
    await dialog
      .getByRole("button", { name: "Prepare export", exact: true })
      .click();
    await held.started;
    await expect(
      dialog.getByRole("button", { name: /preparing|requesting|queueing/i }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.evaluate(() => {
      document
        .querySelector<HTMLAnchorElement>('a[href="/manage?view=organization"]')
        ?.click();
    });
    await expect(page).toHaveURL(/view=backup/);
    expect(exports.createSubmissions).toBe(1);
    held.release();
    await expect(dialog).toBeHidden();
    await expect(exportPanel(page)).toContainText(/queued/i);
    expect(exports.operations.size).toBe(1);
  } finally {
    held.release();
  }
});

test("14 export retries an uncertain create with the same payload and key instead of duplicating the accepted operation", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  exports.createFailureAfterCommit = true;
  await page.goto("/manage?view=backup");
  await downloadAction(page).click();
  const dialog = passphraseDialog(page);
  await dialog
    .getByLabel("Export passphrase", { exact: true })
    .fill(syntheticExportPassphrase);
  await dialog
    .getByRole("button", { name: "Prepare export", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(exports.operations.size).toBe(1);
  expect(exports.createRequests).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Prepare export", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect(exports.createRequests).toHaveLength(2);
  expect(exports.createRequests[1]?.key).toBe(exports.createRequests[0]?.key);
  expect(exports.operations.size).toBe(1);
  await expect(exportPanel(page)).toContainText(/queued/i);
});

test("14 export polls queued and preparing state only in visible Backup and stops when ready", async ({
  page,
  baseURL,
}, testInfo) => {
  await page.clock.install();
  await installMetadataObservations(page);
  const { exports } = await fixtures(page, baseURL);
  await page.goto("/manage?view=backup");
  await requestExport(page);
  const operation = [...exports.operations.values()][0]!;
  exports.operations.set(operation.id, { ...operation, state: "preparing" });
  await page.clock.fastForward(5_100);
  await expect(exportPanel(page)).toContainText(/preparing/i);
  const preparingReads = exports.metadataReads.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await page.clock.fastForward(10_100);
  expect(exports.metadataReads).toHaveLength(preparingReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(page).toHaveURL(/view=organization/);
  await expect(
    page.getByRole("heading", { name: "Organization", exact: true }),
  ).toBeVisible();
  await expect(exportPanel(page)).toHaveCount(0);
  const awayStarts = await metadataStarts(page);
  await page.clock.fastForward(10_100);
  const afterAwayStarts = await metadataStarts(page);
  await testInfo.attach("metadata-away-scheduling", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({ before: awayStarts, after: afterAwayStarts }),
    ),
  });
  expect(afterAwayStarts).toHaveLength(awayStarts.length);
  await page.goBack();
  await expect(page).toHaveURL(
    new RegExp("view=backup.*export=" + operation.id),
  );
  await expect(exportPanel(page)).toBeVisible();
  exports.operations.set(
    operation.id,
    readyBackupExport(operation.backup_run_id, { id: operation.id }),
  );
  await page.clock.fastForward(5_100);
  await expect(exportPanel(page)).toContainText(/ready/i);
  const readyReads = exports.metadataReads.length;
  await page.clock.fastForward(10_100);
  expect(exports.metadataReads).toHaveLength(readyReads);
  expect(exports.contentRequests).toEqual([]);
});

test("14 export keeps a later history Inspect selection independent from the routed export source", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  const source = exports.backups.runs[5]!;
  const inspected = exports.backups.runs[0]!;
  const operation = readyBackupExport(source.id);
  exports.operations.set(operation.id, operation);
  await page.goto(exportLocation(operation.id));
  await expect(exportPanel(page)).toContainText(source.name);
  await expect(
    selectedBackup(page).getByRole("heading", {
      name: source.name,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect " + inspected.name, exact: true })
    .click();
  await expect(
    selectedBackup(page).getByRole("heading", {
      name: inspected.name,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp("export=" + operation.id));
  await expect(exportPanel(page)).toContainText(source.name);
  await expect(exportPanel(page)).toContainText(operation.sha256!);
  expect(exports.createSubmissions).toBe(0);
  expect(exports.contentRequests).toEqual([]);
});

for (const failure of [
  "source_unavailable",
  "source_unproven",
  "export_interrupted",
] as const) {
  test(
    "14 export renders terminal " +
      failure +
      " and stops polling rather than pretending the request is still queued",
    async ({ page, baseURL }) => {
      await page.clock.install();
      const { exports } = await fixtures(page, baseURL);
      await page.goto("/manage?view=backup");
      await requestExport(page);
      const operation = [...exports.operations.values()][0]!;
      exports.operations.set(operation.id, {
        ...operation,
        state: failure === "export_interrupted" ? "interrupted" : "failed",
        failure_code: failure,
      });
      await page.clock.fastForward(5_100);
      await expect(exportPanel(page)).toContainText(/failed|interrupted/i);
      await expect(
        exportPanel(page).getByRole("button", {
          name: "Confirm download",
          exact: true,
        }),
      ).toHaveCount(0);
      const terminalReads = exports.metadataReads.length;
      await page.clock.fastForward(10_100);
      expect(exports.metadataReads).toHaveLength(terminalReads);
      expect(exports.admissionSubmissions).toBe(0);
    },
  );
}

test("14 export reloads the UUID for an off-page source and preserves it through unrelated history filters", async ({
  page,
  baseURL,
}, testInfo) => {
  const { exports } = await fixtures(page, baseURL);
  const source = exports.backups.runs[5]!;
  const operation = readyBackupExport(source.id, {
    id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
  });
  const routedId = operation.id.toUpperCase();
  exports.operations.set(operation.id, operation);
  await page.goto(exportLocation(routedId));
  await expect
    .poll(() => exports.metadataReads.some((read) => read.id === operation.id))
    .toBe(true);
  await expect(exportPanel(page)).toContainText(source.name);
  await expect(exportPanel(page)).toContainText(operation.sha256!);
  await expect(
    exportPanel(page).getByRole("button", {
      name: "Confirm download",
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole("searchbox", { name: "Search backups" })
    .fill("Backup 1");
  await expect(
    page.getByText("Showing 1–1 of 1", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp("export=" + routedId));
  await expect(exportPanel(page)).toContainText(source.name);
  await page.reload();
  await expect(exportPanel(page)).toContainText(source.name);
  await expect(page).toHaveURL(new RegExp("export=" + routedId));
  await confirmDownload(page).finally(async () => {
    await testInfo.attach("canonical-route-admission-context", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          routedId,
          exportId: operation.id,
          metadataReads: exports.metadataReads,
          admissionRequests: exports.admissionRequests.length,
          contentRequests: exports.contentRequests.length,
        }),
      ),
    });
  });
  await expect(nativeLink(page)).toHaveAttribute(
    "href",
    contentPath(operation.id),
  );
  expect(exports.admissionRequests).toHaveLength(1);
  expect(exports.createSubmissions).toBe(0);
  expect(exports.contentRequests).toEqual([]);
});

test("14 export reports an invalid route UUID without requesting another operation", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  await page.goto("/manage?view=backup&export=not-a-uuid");
  await expect(exportPanel(page).getByRole("alert")).toBeVisible();
  await expect(
    exportPanel(page).getByRole("button", {
      name: "Confirm download",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(exports.metadataReads).toEqual([]);
  expect(exports.contentRequests).toEqual([]);
});

test("14 export honors an expired API state and never offers password admission or delivery", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  const operation = readyBackupExport(exports.backups.runs[0]!.id, {
    state: "expired",
    requested_at: "2026-09-01T00:00:00Z",
    ready_at: "2026-09-01T01:00:00Z",
    expires_at: "2026-09-02T01:00:00Z",
  });
  exports.operations.set(operation.id, operation);
  await page.goto(exportLocation(operation.id));
  await expect(exportPanel(page)).toContainText(/expired/i);
  await expect(
    exportPanel(page).getByRole("button", {
      name: "Confirm download",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(exports.admissionSubmissions).toBe(0);
  expect(exports.contentRequests).toEqual([]);
});

test("14 export never accepts stale privileged metadata after refusal and requires fresh Retry after malformed or unavailable reads", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  const operation = readyBackupExport(exports.backups.runs[0]!.id);
  exports.operations.set(operation.id, operation);
  await page.goto(exportLocation(operation.id));
  await expect(exportPanel(page)).toContainText(operation.sha256!);
  exports.readRefused = true;
  await sendOpenViewEvent(page, "invalidate", {
    entity: "backup_export_operations",
  });
  await expect(exportPanel(page).getByRole("alert")).toBeVisible();
  await expect(exportPanel(page)).not.toContainText(operation.sha256!);
  await expect(
    exportPanel(page).getByRole("button", {
      name: "Confirm download",
      exact: true,
    }),
  ).toHaveCount(0);
  exports.readRefused = false;
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(page).toHaveURL(/view=organization/);
  await expect(
    page.getByRole("heading", { name: "Organization", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(
    new RegExp("view=backup.*export=" + operation.id),
  );
  await expect(exportPanel(page)).toBeVisible();
  await expect(exportPanel(page).getByRole("alert")).toBeVisible();
  await expect(exportPanel(page)).not.toContainText(operation.sha256!);
  exports.malformedMetadata = true;
  await exportPanel(page)
    .getByRole("button", { name: "Retry export", exact: true })
    .click();
  await expect(exportPanel(page).getByRole("alert")).toBeVisible();
  await expect(exportPanel(page)).not.toContainText(operation.sha256!);
  exports.malformedMetadata = false;
  exports.readError = {
    status: 503,
    code: "export_unavailable",
    message: "Export metadata is unavailable.",
  };
  await exportPanel(page)
    .getByRole("button", { name: "Retry export", exact: true })
    .click();
  await expect(exportPanel(page).getByRole("alert")).toBeVisible();
  exports.readError = null;
  await exportPanel(page)
    .getByRole("button", { name: "Retry export", exact: true })
    .click();
  await expect(exportPanel(page)).toContainText(operation.sha256!);
  expect(exports.contentRequests).toEqual([]);
});

for (const failure of [
  { status: 403 as const, code: "export_password_invalid" as const },
  { status: 429 as const, code: "export_password_rate_limited" as const },
  { status: 503 as const, code: "export_unavailable" as const },
]) {
  test(
    "14 export handles password admission " +
      failure.status +
      " without native delivery or a login redirect",
    async ({ page, baseURL }, testInfo) => {
      if (failure.status === 503) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.clock.install();
      }
      const { exports } = await fixtures(page, baseURL);
      const nearExpiry = Date.now() + 20_000;
      const operation =
        failure.status === 503
          ? readyBackupExport(exports.backups.runs[5]!.id, {
              requested_at: new Date(
                nearExpiry - 86_400_000 - 60_000,
              ).toISOString(),
              ready_at: new Date(nearExpiry - 86_400_000).toISOString(),
              expires_at: new Date(nearExpiry).toISOString(),
            })
          : readyBackupExport(exports.backups.runs[0]!.id);
      exports.operations.set(operation.id, operation);
      exports.admissionError = {
        ...failure,
        message: "The current password could not be verified.",
        ...(failure.status === 429 ? { retryAfter: "10" } : {}),
      };
      await page.goto(exportLocation(operation.id));
      if (failure.status === 503) {
        await expect(exportPanel(page)).toContainText(
          /downloads stop when the export expires\./i,
        );
        await expect(exportPanel(page)).toContainText(
          "The server copy is cleaned up at the next successful host runner check.",
        );
        await expect(
          exportPanel(page).getByText("Available until", { exact: true }),
        ).toBeVisible();
        const layout = await exportPanel(page).evaluate((panel) => ({
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          panelWidth: panel.clientWidth,
          panelContentWidth: panel.scrollWidth,
        }));
        await testInfo.attach("export-availability-phone-layout", {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify(layout)),
        });
        expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
        expect(layout.panelContentWidth).toBeLessThanOrEqual(layout.panelWidth);
      }
      await exportPanel(page)
        .getByRole("button", { name: "Confirm download", exact: true })
        .click();
      const dialog = passwordDialog(page);
      await dialog
        .getByLabel("Current password", { exact: true })
        .fill(syntheticActingPassword);
      await dialog
        .getByRole("button", { name: "Confirm password", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(page).toHaveURL(/\/manage\?view=backup/);
      await expect(nativeLink(page)).toHaveCount(0);
      expect(exports.contentRequests).toEqual([]);
      exports.admissionError = null;
      await dialog
        .getByRole("button", { name: "Confirm password", exact: true })
        .click();
      await expect(dialog).toBeHidden();
      await expect(nativeLink(page)).toBeVisible();
      expect(exports.admissionRequests).toHaveLength(2);
      expect(
        exports.admissionRequests.every((request) => request.csrfPresent),
      ).toBe(true);
      expect(exports.contentRequests).toEqual([]);
      if (failure.status === 503) {
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(
            new Event("visibilitychange", { bubbles: true }),
          );
        });
        // Change wall time without firing timers: foreground restoration must
        // conceal expired admission even when a background timer was delayed.
        await page.clock.setSystemTime(nearExpiry + 1);
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
          });
          document.dispatchEvent(
            new Event("visibilitychange", { bubbles: true }),
          );
        });
        await expect(nativeLink(page)).toHaveCount(0);
        await expect(exportPanel(page)).toContainText(/ready/i);
        await expect(
          exportPanel(page).getByRole("button", {
            name: "Confirm download",
            exact: true,
          }),
        ).toBeEnabled();
      }
      await exportPanel(page)
        .getByRole("button", { name: "Confirm download", exact: true })
        .click();
      await expect(
        passwordDialog(page).getByLabel("Current password", { exact: true }),
      ).toHaveValue("");
      if (failure.status === 503) {
        await passwordDialog(page)
          .getByLabel("Current password", { exact: true })
          .fill(syntheticActingPassword);
        await passwordDialog(page)
          .getByRole("button", { name: "Confirm password", exact: true })
          .click();
        await expect(passwordDialog(page)).toBeVisible();
        await expect(passwordDialog(page).getByRole("alert")).toContainText(
          /expired/i,
        );
        await expect(nativeLink(page)).toHaveCount(0);
        expect(exports.admissionRequests).toHaveLength(3);
        expect(exports.contentRequests).toEqual([]);
      }
    },
  );
}

test("14 native export: the explicit anchor hands an attachment to the browser without app buffering or a saved-file claim", async ({
  page,
  baseURL,
}, testInfo) => {
  await installNativeObservations(page);
  const { exports } = await fixtures(page, baseURL);
  const operation = readyBackupExport(exports.backups.runs[0]!.id);
  exports.operations.set(operation.id, operation);
  // Source retention does not shorten an independently ready export's TTL.
  exports.backups.runs[0]!.expired_at = "2026-10-01T00:00:00Z";
  await page.goto(exportLocation(operation.id));
  await expect(exportPanel(page)).toContainText(
    "Confirm your password before downloading.",
  );
  await confirmDownload(page);
  await expect(exportPanel(page)).toContainText(/password is confirmed/i);
  await expect(exportPanel(page)).not.toContainText(
    "Confirm your password before downloading.",
  );
  await expect(nativeLink(page)).toHaveAttribute(
    "href",
    contentPath(operation.id),
  );
  expect(exports.contentRequests).toEqual([]);
  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === "openslate_export_admission",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(cookie?.path).toBe(contentPath(operation.id));
  const cookieExposed = await page.evaluate(() =>
    document.cookie
      .split(";")
      .some((part) => part.trim().startsWith("openslate_export_admission=")),
  );
  expect(cookieExposed).toBe(false);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 5_000 }),
    nativeLink(page).click(),
  ]).finally(async () => {
    await testInfo.attach("native-export-wire-context", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          project: testInfo.project.name,
          contentObservations: exports.contentRequests,
          admittedAttempts: exports.attempts,
        }),
      ),
    });
  });
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe(
    "openslate-backup-export-" + operation.id + ".tar",
  );
  const stream = await download.createReadStream();
  if (!stream) throw new Error("The owned fixture download is unavailable.");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  expect(bytes).toBe(exportFixtureBytes.byteLength);
  expect(hash.digest("hex")).toBe(operation.sha256);
  expect(exports.attempts).toBe(1);
  expect(exports.contentRequests).toHaveLength(1);
  expect(exports.contentRequests[0]).toMatchObject({
    method: "GET",
    navigation: true,
    serverCookiePresent: true,
    serverCookieMatchesAdmission: true,
    responseStatus: 200,
    responseCode: null,
    forwardedProtocolMatches: true,
    forwardedHostnameMatches: true,
    forwardedPathMatches: true,
  });
  const observations = await page.evaluate(
    () =>
      (
        window as typeof window & {
          backupExportObservations: {
            contentFetches: number;
            objectURLs: number;
          };
        }
      ).backupExportObservations,
  );
  expect(observations).toEqual({ contentFetches: 0, objectURLs: 0 });
  await expect(nativeLink(page)).toHaveCount(0);
  await expect(
    exportPanel(page).getByRole("button", {
      name: "Confirm download",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(exportPanel(page)).not.toContainText(
    /download completed|download saved|saved to disk|successfully downloaded/i,
  );
});

for (const failure of [
  { status: 403 as const, code: "export_admission_required" as const },
  { status: 410 as const, code: "export_expired" as const },
  { status: 503 as const, code: "export_transfer_busy" as const },
  { status: 504 as const, code: "export_preparation_timeout" as const },
]) {
  test(
    "14 native export: pre-byte " +
      failure.status +
      " requires fresh confirmation and a complete restart",
    async ({ page, baseURL }, testInfo) => {
      const { exports } = await fixtures(page, baseURL);
      const operation = readyBackupExport(exports.backups.runs[0]!.id);
      exports.operations.set(operation.id, operation);
      exports.contentError = {
        ...failure,
        message: "Export delivery is unavailable. Confirm again to restart.",
        ...(failure.status === 503 ? { retryAfter: "5" } : {}),
      };
      await page.goto(exportLocation(operation.id));
      await confirmDownload(page);
      const nativeResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === contentPath(operation.id) &&
          response.request().method() === "GET",
        { timeout: 5_000 },
      );
      const presentation = Promise.race([
        page
          .waitForEvent("download", { timeout: 10_000 })
          .then(async (download) => ({
            kind: "browser download" as const,
            failed: (await download.failure()) !== null,
          })),
        page
          .waitForURL((url) => url.pathname === contentPath(operation.id), {
            timeout: 10_000,
          })
          .then(() => ({
            kind: "native error document" as const,
            failed: true,
          })),
      ]);
      await nativeLink(page).click();
      const observed = await presentation;
      const response = await nativeResponse;
      const responseBody: unknown = await response.json();
      const responseCode =
        responseBody !== null &&
        typeof responseBody === "object" &&
        "detail" in responseBody &&
        responseBody.detail !== null &&
        typeof responseBody.detail === "object" &&
        "code" in responseBody.detail
          ? responseBody.detail.code
          : null;
      expect(observed.failed).toBe(true);
      expect(exports.contentRequests).toHaveLength(1);
      expect(exports.contentRequests[0]?.outcome).toBe("denied");
      expect(exports.attempts).toBe(0);
      await testInfo.attach("native-export-error-context", {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({
            project: testInfo.project.name,
            status: response.status(),
            code: responseCode,
            configuredScenarioStatus: failure.status,
            presentation: observed.kind,
            admittedAttempts: exports.attempts,
            contentObservations: exports.contentRequests,
          }),
        ),
      });
      expect(response.status()).toBe(failure.status);
      expect(responseCode).toBe(failure.code);
      if (new URL(page.url()).pathname === contentPath(operation.id))
        await page.goBack();
      await expect(page).toHaveURL(new RegExp("export=" + operation.id));
      await expect(nativeLink(page)).toHaveCount(0);
      exports.contentError = null;
      let deliveryOperation = operation;
      if (failure.status === 410) {
        exports.operations.set(operation.id, {
          ...operation,
          state: "expired",
        });
        await page.reload();
        await expect(exportPanel(page)).toContainText(/expired/i);
        await expect(
          exportPanel(page).getByRole("button", {
            name: "Confirm download",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(nativeLink(page)).toHaveCount(0);
        await requestExport(page);
        const replacement = [...exports.operations.values()].find(
          (entry) => entry.id !== operation.id,
        );
        expect(replacement).toBeDefined();
        deliveryOperation = readyBackupExport(replacement!.backup_run_id, {
          id: replacement!.id,
        });
        exports.operations.set(deliveryOperation.id, deliveryOperation);
        await sendOpenViewEvent(page, "invalidate", {
          entity: "backup_export_operations",
        });
        await expect(exportPanel(page)).toContainText(/ready/i);
      }
      await confirmDownload(page);
      expect(exports.admissionRequests).toHaveLength(2);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        nativeLink(page).click(),
      ]);
      expect(await download.failure()).toBeNull();
      expect(download.suggestedFilename()).toContain(deliveryOperation.id);
      expect(exports.attempts).toBe(1);
      expect(exports.contentRequests).toHaveLength(2);
      await expect(exportPanel(page)).not.toContainText(
        /saved to disk|download completed/i,
      );
    },
  );
}

test("14 export keeps local input through a same-account privacy curtain and preserves the incumbent policy draft", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  const policy = page.getByRole("dialog", {
    name: "Backup schedule",
    exact: true,
  });
  await policy
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("weekly");
  await policy.getByRole("button", { name: "Close", exact: true }).click();
  await downloadAction(page).click();
  const dialog = passphraseDialog(page);
  await dialog
    .getByLabel("Export passphrase", { exact: true })
    .fill(syntheticExportPassphrase);
  const held = heldReply();
  exports.holdSession = held;
  try {
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await held.started;
    const curtain = page.getByRole("dialog", {
      name: "Session verification",
      exact: true,
    });
    await expect(curtain).toBeVisible();
    await expect(dialog).toBeHidden();
    held.release();
    await expect(curtain).toBeHidden();
    await expect(
      dialog.getByLabel("Export passphrase", { exact: true }),
    ).toHaveValue(syntheticExportPassphrase);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Edit schedule", exact: true })
      .click();
    await expect(
      policy.getByLabel("Backup schedule", { exact: true }),
    ).toHaveValue("weekly");
    expect(exports.createSubmissions).toBe(0);
    expect(exports.backups.patches).toEqual([]);
  } finally {
    held.release();
  }
});

test("14 export ignores a delayed prior-account admission without clearing the new account's pending confirmation", async ({
  page,
  baseURL,
}) => {
  const { exports } = await fixtures(page, baseURL);
  const operation = readyBackupExport(exports.backups.runs[0]!.id);
  exports.operations.set(operation.id, operation);
  const oldReply = heldReply();
  const newReply = heldReply();
  exports.holdAdmission = oldReply;
  await page.goto(exportLocation(operation.id));
  await exportPanel(page)
    .getByRole("button", { name: "Confirm download", exact: true })
    .click();
  await passwordDialog(page)
    .getByLabel("Current password", { exact: true })
    .fill(syntheticActingPassword);
  try {
    await passwordDialog(page)
      .getByRole("button", { name: "Confirm password", exact: true })
      .click();
    await oldReply.started;
    exports.actorId = "00000000-0000-4000-8000-000000000002";
    await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
    await expect
      .poll(() =>
        exports.metadataReads.some((read) => read.actorId === exports.actorId),
      )
      .toBe(true);
    await expect(
      page.getByRole("dialog", { name: "Session verification", exact: true }),
    ).toBeHidden();
    await expect(nativeLink(page)).toHaveCount(0);
    exports.holdAdmission = newReply;
    await exportPanel(page)
      .getByRole("button", { name: "Confirm download", exact: true })
      .click();
    await passwordDialog(page)
      .getByLabel("Current password", { exact: true })
      .fill(syntheticActingPassword);
    await passwordDialog(page)
      .getByRole("button", { name: "Confirm password", exact: true })
      .click();
    await newReply.started;
    oldReply.release();
    await expect(
      passwordDialog(page).getByRole("button", {
        name: /confirming|verifying/i,
      }),
    ).toBeDisabled();
    await expect(nativeLink(page)).toHaveCount(0);
    newReply.release();
    await expect(passwordDialog(page)).toBeHidden();
    await expect(nativeLink(page)).toBeVisible();
    expect(exports.admissionRequests.map((request) => request.actorId)).toEqual(
      [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
    );
    expect(exports.contentRequests).toEqual([]);
  } finally {
    oldReply.release();
    newReply.release();
  }
});

for (const role of ["member", "guest"] as const) {
  test(
    "14 export offers no protected action to a " + role,
    async ({ page, baseURL }) => {
      const { exports } = await fixtures(page, baseURL);
      exports.role = role;
      exports.backups.statusReadStatus = 403;
      exports.backups.historyReadStatus = 403;
      const operation = readyBackupExport(exports.backups.runs[0]!.id);
      exports.operations.set(operation.id, operation);
      await page.goto(exportLocation(operation.id));
      await expect(downloadAction(page)).toHaveCount(0);
      await expect(nativeLink(page)).toHaveCount(0);
      await expect(
        page.getByLabel("Export passphrase", { exact: true }),
      ).toHaveCount(0);
      expect(exports.createSubmissions).toBe(0);
      expect(exports.admissionSubmissions).toBe(0);
      expect(exports.contentRequests).toEqual([]);
    },
  );
}
