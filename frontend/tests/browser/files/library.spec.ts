import { expect } from "@playwright/test";
import { test } from "./coverage";
test("a pending scan cannot be downloaded and an unavailable scanner preserves that state", async ({
  page,
}) => {
  const file = {
    id: "f",
    purpose: "library_document",
    record_id: null,
    creator_id: "u",
    filename: "report.pdf",
    media_type: "application/pdf",
    expected_size: 5,
    actual_size: 5,
    state: "pending_scan",
    failure_code: "scan_exhausted",
    is_deleted: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const list = (items: unknown[]) => ({
    items,
    pagination: {
      limit: 25,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  });
  await page.route("**/session/status", (r) =>
    r.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (r) =>
    r.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", (r) => {
    const path = new URL(r.request().url()).pathname.replace("/bff", "");
    if (path === "/workspace")
      return r.fulfill({
        json: {
          id: 1,
          display_name: "OpenSlate",
          legal_name: null,
          description: null,
          contact_email: null,
          contact_phone: null,
          postal_address: null,
          timezone: "UTC",
          locale: "en-US",
          revision: 1,
          logo_file_id: null,
        },
      });
    if (path === "/auth/me")
      return r.fulfill({ json: { id: "u", role: "admin", permissions: [] } });
    if (path === "/files") return r.fulfill({ json: list([file]) });
    if (path === "/files/f/scan")
      return r.fulfill({
        status: 503,
        json: { detail: { message: "Scanning is unavailable" } },
      });
    return r.fulfill({ json: list([]) });
  });
  await page.goto("/administration/files");
  await expect(
    page.getByText("Scanning in background", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download report.pdf" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Retry scanning report.pdf", exact: true })
    .click();
  await expect(
    page.getByText("Scanning is unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download report.pdf" }),
  ).toHaveCount(0);
});

test("non-administrators do not request the library list", async ({ page }) => {
  let libraryRequests = 0;
  await page.route("**/session/status", (r) =>
    r.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (r) =>
    r.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", (r) => {
    const path = new URL(r.request().url()).pathname.replace("/bff", "");
    if (path === "/workspace")
      return r.fulfill({
        json: {
          id: 1,
          display_name: "OpenSlate",
          legal_name: null,
          description: null,
          contact_email: null,
          contact_phone: null,
          postal_address: null,
          timezone: "UTC",
          locale: "en-US",
          revision: 1,
          logo_file_id: null,
        },
      });
    if (path === "/auth/me")
      return r.fulfill({
        json: {
          id: "u",
          role: "custom",
          permissions: ["records.read", "records.write"],
        },
      });
    if (path === "/files") libraryRequests++;
    return r.fulfill({
      json: {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    });
  });
  await page.goto("/administration/files");
  await expect(
    page.getByText("Only administrators can access the document library."),
  ).toBeVisible();
  expect(libraryRequests).toBe(0);
});

test("upload queues in background and polling makes clean content downloadable", async ({
  page,
}) => {
  const { file, requests } = await mockFiles(page);
  await page.clock.install();
  await page.goto("/administration/files");
  await page.getByLabel("Choose document").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("hello"),
  });
  await page.getByRole("button", { name: "Upload and scan" }).click();
  await expect(
    page.getByText("Upload complete. Scanning continues in the background."),
  ).toBeVisible();
  expect(requests.scan).toBe(0);
  await expect(
    page.getByRole("button", { name: "Download report.pdf" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry scanning report.pdf" }),
  ).toHaveCount(0);
  file.state = "ready";
  await page.clock.runFor(5_000);
  await expect(
    page.getByRole("button", { name: "Download report.pdf" }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report.pdf" }).click();
  expect((await downloaded).suggestedFilename()).toBe("report.pdf");
});

test("pending polling stops after two minutes and manual refresh resumes it", async ({
  page,
}) => {
  const { requests } = await mockFiles(page);
  await page.clock.install();
  await page.goto("/administration/files");
  await expect(
    page.getByText("Scanning in background", { exact: true }),
  ).toBeVisible();
  await page.clock.runFor(120_000);
  await expect(
    page.getByText(
      "Automatic status checks paused. Refresh file status to check again.",
    ),
  ).toBeVisible();
  const stopped = requests.list;
  await page.clock.runFor(15_000);
  expect(requests.list).toBe(stopped);
  await page.getByRole("button", { name: "Refresh file status" }).click();
  await expect(
    page.getByText(
      "Automatic status checks paused. Refresh file status to check again.",
    ),
  ).toHaveCount(0);
  await expect.poll(() => requests.list).toBeGreaterThan(stopped);
});

test("logo candidates survive reload and require explicit ready selection", async ({
  page,
}) => {
  const { file, requests } = await mockFiles(page, true);
  await page.goto("/settings/workspace");
  await expect(
    page.getByText("report.pdf · Scanning in background"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.getByText("report.pdf · Scanning in background"),
  ).toBeVisible();
  file.state = "ready";
  await page.getByRole("button", { name: "Refresh logo status" }).click();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeEnabled();
  expect(requests.patch).toBe(0);
  await page.getByRole("button", { name: "Use this logo" }).click();
  await expect(page.getByText("Workspace logo updated.")).toBeVisible();
  expect(requests.patch).toBe(1);
});

test("an unresolved logo upload survives reload, polls for recovery, and requires explicit activation", async ({
  page,
}) => {
  const { file, profile, requests } = await mockFiles(page, true);
  file.state = "uploading";
  file.failure_code = "upload_unresolved";
  await page.clock.install();
  await page.goto("/settings/workspace");
  await expect(
    page.getByText("report.pdf · Upload outcome pending"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The upload outcome is unresolved. An administrator can reconcile this upload.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeDisabled();
  expect(requests.reconcile).toBe(0);
  const initialLists = requests.list;
  await page.clock.runFor(5_000);
  await expect.poll(() => requests.list).toBeGreaterThan(initialLists);
  await page.reload();
  await expect(
    page.getByText("report.pdf · Upload outcome pending"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Reconcile upload" }).click();
  await expect(
    page.getByText("report.pdf · Scanning in background"),
  ).toBeVisible();
  expect(requests.reconcile).toBe(1);
  expect(requests.patch).toBe(0);
  expect(profile.logo_file_id).toBe("old-logo");
  file.state = "ready";
  file.failure_code = null;
  await page.clock.runFor(5_000);
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeEnabled();
  expect(requests.patch).toBe(0);
  expect(profile.logo_file_id).toBe("old-logo");
  await page.getByRole("button", { name: "Use this logo" }).click();
  await expect(page.getByText("Workspace logo updated.")).toBeVisible();
  expect(requests.patch).toBe(1);
  expect(profile.logo_file_id).toBe("f");
});

test("an uploading logo without a failure code remains available for manual reconciliation", async ({
  page,
}) => {
  const { file, profile, requests } = await mockFiles(page, true);
  file.state = "uploading";
  await page.goto("/settings/workspace");
  await expect(
    page.getByText("report.pdf · Upload outcome pending"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reconcile upload" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeDisabled();
  expect(requests.reconcile).toBe(0);
  expect(requests.patch).toBe(0);
  expect(profile.logo_file_id).toBe("old-logo");
});

for (const status of [409, 503]) {
  test(`a ${status} logo upload reconciliation keeps the candidate and current logo`, async ({
    page,
  }) => {
    const { file, profile, requests } = await mockFiles(page, true);
    file.state = "uploading";
    file.failure_code = "upload_unresolved";
    let reconciliationRequests = 0;
    await page.route("**/bff/files/f/reconcile", (route) => {
      reconciliationRequests++;
      return route.fulfill({
        status,
        json: { detail: { message: "Upload outcome remains unresolved" } },
      });
    });
    await page.goto("/settings/workspace");
    await page.getByRole("button", { name: "Reconcile upload" }).click();
    await expect(
      page.getByText("Upload outcome remains unresolved", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("report.pdf · Upload outcome pending"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Use this logo" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Reconcile upload" }),
    ).toBeEnabled();
    expect(reconciliationRequests).toBe(1);
    expect(requests.reconcile).toBe(0);
    expect(requests.patch).toBe(0);
    expect(profile.logo_file_id).toBe("old-logo");
  });
}

async function mockFiles(page: import("@playwright/test").Page, logo = false) {
  const file = {
    id: "f",
    purpose: logo ? "workspace_logo" : "library_document",
    record_id: null,
    creator_id: "u",
    filename: "report.pdf",
    media_type: "application/pdf",
    expected_size: 5,
    actual_size: 5,
    state: "pending_scan",
    failure_code: null as string | null,
    is_deleted: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const files = [file];
  const requests = { list: 0, scan: 0, reconcile: 0, patch: 0 };
  const profile = {
    id: 1,
    display_name: "OpenSlate",
    legal_name: null,
    description: null,
    contact_email: null,
    contact_phone: null,
    postal_address: null,
    timezone: "UTC",
    locale: "en-US",
    revision: 1,
    logo_file_id: logo ? "old-logo" : null,
  };
  const list = (items: unknown[]) => ({
    items,
    pagination: {
      limit: 25,
      offset: 0,
      count: items.length,
      total: items.length,
      has_more: false,
    },
  });
  await page.route("**/session/status", (r) =>
    r.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (r) =>
    r.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", (r) => {
    const path = new URL(r.request().url()).pathname.replace("/bff", "");
    if (path === "/auth/me")
      return r.fulfill({ json: { id: "u", role: "admin", permissions: [] } });
    if (path === "/workspace") {
      if (r.request().method() === "PATCH") {
        requests.patch++;
        profile.logo_file_id = "f";
        profile.revision++;
      }
      return r.fulfill({ json: profile });
    }
    if (path === "/files") {
      if (r.request().method() === "POST")
        return r.fulfill({ json: { ...file, state: "awaiting_upload" } });
      requests.list++;
      return r.fulfill({ json: list(files) });
    }
    if (path === "/files/f/content") return r.fulfill({ json: file });
    if (path === "/files/f/scan") {
      requests.scan++;
      return r.fulfill({ status: 202, json: file });
    }
    if (path === "/files/f/reconcile") {
      requests.reconcile++;
      file.state = "pending_scan";
      file.failure_code = null;
      return r.fulfill({ status: 200, json: file });
    }
    return r.fulfill({ json: list([]) });
  });
  return { file, files, profile, requests };
}

test("hidden panels stop polling and focus refreshes pending status", async ({
  page,
}) => {
  const { file, requests } = await mockFiles(page);
  await page.clock.install();
  await page.goto("/administration/files");
  await expect(
    page.getByText("Scanning in background", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(5_000);
  const hidden = requests.list;
  await page.clock.runFor(15_000);
  expect(requests.list).toBe(hidden);
  file.state = "ready";
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(
    page.getByRole("button", { name: "Download report.pdf" }),
  ).toBeVisible();
});

test("a failed logo candidate preserves the current logo and cannot be selected", async ({
  page,
}) => {
  const { file, requests } = await mockFiles(page, true);
  await page.goto("/settings/workspace");
  await expect(
    page.getByText("report.pdf · Scanning in background"),
  ).toBeVisible();
  file.state = "rejected";
  file.failure_code = "scan_infected";
  await page.getByRole("button", { name: "Refresh logo status" }).click();
  await expect(
    page.getByText(
      "Malware was detected. This file cannot be used or downloaded.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Retry scanning logo" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText(
      "Malware was detected. This file cannot be used or downloaded.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Retry scanning logo" }),
  ).toHaveCount(0);
  expect(requests.patch).toBe(0);
});

test("write-only attachment upload confirms success without file reads or downloads", async ({
  page,
}) => {
  const { requests } = await mockFiles(page);
  await page.route("**/bff/auth/me", (r) =>
    r.fulfill({
      json: { id: "u", role: "custom", permissions: ["records.write"] },
    }),
  );
  await page.route("**/bff/modules/m", (r) =>
    r.fulfill({
      json: {
        id: "m",
        department_id: "d",
        module_name: "Assets",
        is_deleted: false,
        is_schema_accepted: true,
      },
    }),
  );
  await page.route("**/bff/departments/d", (r) =>
    r.fulfill({
      json: { id: "d", department_name: "Operations", is_deleted: false },
    }),
  );
  await page.route("**/bff/records/r", (r) =>
    r.fulfill({
      json: { id: "r", module_id: "m", data: {}, is_deleted: false },
    }),
  );
  await page.clock.install();
  await page.goto("/modules/m/records/r/edit");
  await page.getByLabel("Choose document").setInputFiles({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("hello"),
  });
  await page.getByRole("button", { name: "Upload and scan" }).click();
  await expect(
    page.getByText("Upload complete. Scanning continues in the background."),
  ).toBeVisible();
  await page.clock.runFor(15_000);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("openslate:invalidation")),
  );
  expect(requests.list).toBe(0);
  expect(requests.scan).toBe(0);
  await expect(
    page.getByRole("button", { name: "Download report.pdf" }),
  ).toHaveCount(0);
});

test("multiple recovered logos require choosing a candidate and exclude the current logo", async ({
  page,
}) => {
  const { file, files, requests } = await mockFiles(page, true);
  files.push({ ...file, id: "second", filename: "second.png", state: "ready" });
  files.push({
    ...file,
    id: "old-logo",
    filename: "current.png",
    state: "ready",
  });
  await page.goto("/settings/workspace");
  const select = page.getByLabel("Choose a logo candidate");
  await expect(select).toHaveValue("");
  await expect(select.getByRole("option")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Use this logo" })).toHaveCount(
    0,
  );
  await select.selectOption("second");
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeEnabled();
  expect(requests.patch).toBe(0);
});

test("an exhausted logo scan can be requeued and becomes ready on refresh", async ({
  page,
}) => {
  const { file, requests } = await mockFiles(page, true);
  file.failure_code = "scan_exhausted";
  await page.goto("/settings/workspace");
  await expect(
    page.getByText(
      "Automatic scan retries are exhausted. Retry scanning when the service is available.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry scanning logo" }).click();
  await expect.poll(() => requests.scan).toBe(1);
  file.state = "ready";
  file.failure_code = null;
  await page.getByRole("button", { name: "Refresh logo status" }).click();
  await expect(
    page.getByRole("button", { name: "Use this logo" }),
  ).toBeEnabled();
});
