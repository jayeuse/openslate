import { readFile } from "node:fs/promises";

import { expect, test, type Route } from "./helpers/test";
import { mockMfa } from "./helpers/mfa";

const ACTOR_ID = "00000000-0000-4000-8000-000000000201";
const NULL_LABEL_ACTOR_ID = "00000000-0000-4000-8000-000000000202";
const UNKNOWN_ACTOR_ID = "00000000-0000-4000-8000-000000000203";

type AuditLogFixture = {
  id: string;
  created_at: string;
  performed_by: string | null;
  action: "create" | "update" | "delete";
  entity_type: string;
  entity_id: string | null;
  department_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  request_method: string | null;
  request_path: string | null;
  actor_label: string | null;
  actor_name: string | null;
  note: string | null;
  target_label?: string;
};

const CSV_HEADER =
  '"Date","User","Entity","Action","Target","Before","After"\r\n';

function wireAuditLog(log: AuditLogFixture) {
  const snapshot = [
    log.after?.name,
    log.after?.title,
    log.before?.name,
    log.before?.title,
  ].find(
    (value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
  );
  return {
    ...log,
    target_label:
      log.target_label ??
      snapshot ??
      `${humanize(log.entity_type)} · name unavailable`,
  };
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function fixtureCsv(logs: AuditLogFixture[]): string {
  function quote(value: string) {
    const neutral = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${neutral.replaceAll('"', '""')}"`;
  }
  function values(
    value: Record<string, unknown> | null,
    empty: string,
  ): string {
    if (!value || !Object.keys(value).length) return empty;
    return Object.entries(value)
      .map(
        ([key, item]) =>
          `${humanize(key)}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`,
      )
      .join("\n");
  }
  const rows = logs.map((log) =>
    [
      log.created_at,
      log.actor_name?.trim() || "Unknown person",
      humanize(log.entity_type),
      humanize(log.action),
      wireAuditLog(log).target_label,
      values(log.before, "No previous values recorded."),
      values(log.after, "No updated values recorded."),
    ]
      .map(quote)
      .join(","),
  );
  return [CSV_HEADER.slice(0, -2), ...rows].join("\r\n");
}

function fixtureId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function makeAuditLogs(count = 12): AuditLogFixture[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const performer = number % 2 === 0 ? NULL_LABEL_ACTOR_ID : ACTOR_ID;
    return {
      id: fixtureId(1000 + number),
      created_at: `2026-09-${String(12 - (index % 12)).padStart(2, "0")}T12:30:00Z`,
      performed_by: number % 7 === 0 ? null : performer,
      action: (["create", "update", "delete"] as const)[number % 3],
      entity_type: number % 2 === 0 ? "user" : "record",
      entity_id: fixtureId(2000 + number),
      department_id: null,
      before: number % 3 === 0 ? { status: "assigned" } : null,
      after: { status: number % 3 === 0 ? "in progress" : "active" },
      request_id: null,
      request_method: "PATCH",
      request_path: `/api/records/${fixtureId(2000 + number)}`,
      actor_label: null,
      actor_name:
        number % 7 === 0
          ? null
          : number % 2 === 0
            ? "Tara Reyes"
            : "Mara Santos",
      note: null,
    };
  });
}

function matchesDate(value: string, bound: string | null): boolean {
  return !bound || Date.parse(value) >= Date.parse(bound);
}

function createAuditRoute(logs: AuditLogFixture[]) {
  const requests: URL[] = [];
  const details: URL[] = [];
  const exports: URL[] = [];
  const exportBodies: string[] = [];
  let listDenied = false;
  let listUnavailable = false;
  let detailDenied = false;

  return {
    requests,
    details,
    exports,
    exportBodies,
    denyList() {
      listDenied = true;
    },
    allowList() {
      listDenied = false;
      listUnavailable = false;
    },
    failList() {
      listUnavailable = true;
    },
    denyDetails() {
      detailDenied = true;
    },
    allowDetails() {
      detailDenied = false;
    },
    async handle(route: Route) {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/audit-logs/options") {
        const latestEntityUse = new Map<string, string>();
        const latestActorUse = new Map<string, AuditLogFixture>();
        for (const log of logs) {
          const latestEntityDate = latestEntityUse.get(log.entity_type);
          if (!latestEntityDate || log.created_at > latestEntityDate)
            latestEntityUse.set(log.entity_type, log.created_at);
          if (!log.performed_by) continue;
          const latestActor = latestActorUse.get(log.performed_by);
          if (
            !latestActor ||
            log.created_at > latestActor.created_at ||
            (log.created_at === latestActor.created_at &&
              log.id > latestActor.id)
          )
            latestActorUse.set(log.performed_by, log);
        }
        const entityTypes = [...latestEntityUse.entries()]
          .sort(
            ([leftType, leftDate], [rightType, rightDate]) =>
              rightDate.localeCompare(leftDate) ||
              leftType.localeCompare(rightType),
          )
          .slice(0, 200)
          .map(([entityType]) => entityType);
        const actors = [...latestActorUse.entries()]
          .sort(
            ([leftId, leftLog], [rightId, rightLog]) =>
              rightLog.created_at.localeCompare(leftLog.created_at) ||
              leftId.localeCompare(rightId),
          )
          .slice(0, 200)
          .map(([performed_by, log]) => ({
            performed_by,
            actor_label: log.actor_label,
            actor_name: log.actor_name,
          }));
        await route.fulfill({
          json: { entity_types: entityTypes, actors },
        });
        return;
      }
      if (
        url.pathname !== "/api/audit-logs" &&
        url.pathname !== "/api/audit-logs/export"
      ) {
        details.push(url);
        if (detailDenied) {
          await route.fulfill({
            status: 403,
            json: { detail: "Forbidden" },
          });
          return;
        }
        const selected = logs.find(
          (log) => log.id === url.pathname.split("/").pop(),
        );
        await route.fulfill({
          status: selected ? 200 : 404,
          json: selected
            ? wireAuditLog(selected)
            : { detail: "Audit log not found" },
        });
        return;
      }

      const exporting = url.pathname === "/api/audit-logs/export";
      (exporting ? exports : requests).push(url);
      if (listDenied || listUnavailable) {
        await route.fulfill({
          status: listDenied ? 403 : 503,
          json: { detail: listDenied ? "Forbidden" : "Unavailable" },
        });
        return;
      }

      const params = url.searchParams;
      const search = (params.get("search") ?? "").trim().toLocaleLowerCase();
      const filtered = logs
        .filter(
          (log) =>
            !params.get("performed_by") ||
            log.performed_by === params.get("performed_by"),
        )
        .filter(
          (log) =>
            !params.get("entity_type") ||
            log.entity_type === params.get("entity_type"),
        )
        .filter(
          (log) => !params.get("action") || log.action === params.get("action"),
        )
        .filter((log) =>
          matchesDate(log.created_at, params.get("created_after")),
        )
        .filter(
          (log) =>
            !params.get("created_before") ||
            Date.parse(log.created_at) <=
              Date.parse(params.get("created_before")!),
        )
        .filter(
          (log) =>
            !search ||
            [
              log.action,
              log.actor_label,
              log.entity_type,
              log.entity_id,
              JSON.stringify(log.before),
              JSON.stringify(log.after),
            ].some((value) => value?.toLocaleLowerCase().includes(search)),
        );
      const sortOrder = params.get("sort_order") === "asc" ? 1 : -1;
      filtered.sort(
        (left, right) =>
          sortOrder * left.created_at.localeCompare(right.created_at),
      );

      if (exporting) {
        if (filtered.length > 10_000) {
          await route.fulfill({
            status: 409,
            json: {
              detail: {
                code: "audit_export_limit",
                message:
                  "Audit exports support up to 10,000 entries. Narrow your filters and try again.",
              },
            },
          });
          return;
        }
        const csv = fixtureCsv(filtered);
        exportBodies.push(csv);
        await route.fulfill({
          body: csv,
          headers: {
            "Content-Type": "text/csv;charset=utf-8",
            "Content-Disposition": 'attachment; filename="openslate-audit.csv"',
            "Cache-Control": "no-store",
            "X-Audit-Export-Count": String(filtered.length),
          },
        });
        return;
      }

      const limit = Number(params.get("limit") ?? 20);
      const offset = Number(params.get("offset") ?? 0);
      const items = filtered.slice(offset, offset + limit);
      await route.fulfill({
        json: {
          items: items.map(wireAuditLog),
          pagination: {
            limit,
            offset,
            count: items.length,
            total: filtered.length,
            has_more: offset + items.length < filtered.length,
          },
        },
      });
    },
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        id: fixtureId(77),
        display_name: "Harbor workspace",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        locale: "fr-FR",
        timezone: "Asia/Manila",
        logo_file_id: null,
        mark: "RS",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
        theme: "slate",
        revision: 4,
      },
    }),
  );
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
});

test("Audit uses server filters, sort and page requests, with server-named actor options", async ({
  page,
}) => {
  const api = createAuditRoute(makeAuditLogs());
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");

  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await expect(
    table.getByText("Mara Santos", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator(`#audit-user option[value="${NULL_LABEL_ACTOR_ID}"]`),
  ).toHaveText("Tara Reyes");
  await expect(
    table.getByText("Unknown person", { exact: true }).first(),
  ).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Source" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("note", { name: "Organization data", exact: true }),
  ).toHaveText("Organization Audit entries are loaded from your organization.");

  expect(api.requests[0]?.searchParams.get("limit")).toBe("10");
  expect(api.requests[0]?.searchParams.get("offset")).toBe("0");
  expect(api.requests[0]?.searchParams.get("sort_by")).toBe("created_at");
  expect(api.requests[0]?.searchParams.get("sort_order")).toBe("desc");

  await page
    .getByRole("combobox", { name: "Sort activity" })
    .selectOption("oldest");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("sort_order"))
    .toBe("asc");

  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("delete");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("delete");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.getByText("Delete", { exact: true })).toHaveCount(4);

  await page.getByRole("button", { name: "More filters" }).click();
  await page
    .getByLabel("Person", { exact: true })
    .selectOption(NULL_LABEL_ACTOR_ID);
  await expect(
    page.getByText("Person: Tara Reyes", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("performed_by"))
    .toBe(NULL_LABEL_ACTOR_ID);
  await page.getByLabel("Entity", { exact: true }).selectOption("user");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("entity_type"))
    .toBe("user");
  await page.getByLabel("Action", { exact: true }).selectOption("update");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("action"))
    .toBe("update");
  await page.getByLabel("From", { exact: true }).fill("2026-09-04");
  await page.getByLabel("To", { exact: true }).fill("2026-09-10");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_after"))
    .toBe("2026-09-03T16:00:00.000Z");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
    .toBe("2026-09-10T15:59:59.999Z");

  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("assigned");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("assigned");

  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(page.getByLabel("Person", { exact: true })).toHaveValue(
    "All users",
  );
  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("active");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("active");
  expect(api.requests.at(-1)?.searchParams.get("performed_by")).toBeNull();

  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("no matching activity");
  await expect(
    page.getByText("No audit entries match these filters", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing 0–0 of 0", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(
    page
      .getByRole("table", { name: "Activity history table", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(10);
});

test("Audit paging is server-backed and detail reads the selected audit ID", async ({
  page,
}) => {
  const logs = makeAuditLogs();
  logs[5]!.after = { title: "Paged detail target", status: "in progress" };
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");

  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await expect(
    page.getByText("Showing 1–10 of 12", { exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Rows per page" }).selectOption("5");
  await expect(
    page.getByText("Showing 1–5 of 12", { exact: true }),
  ).toBeVisible();
  expect(api.requests.at(-1)?.searchParams.get("limit")).toBe("5");

  const pages = page.getByRole("navigation", { name: "Activity pages" });
  await pages.getByRole("button", { name: "Go to next page" }).click();
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("offset"))
    .toBe("5");
  await expect(
    page.getByText("Showing 6–10 of 12", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", {
      name: "View audit Paged detail target",
      exact: true,
    })
    .click();
  const details = page.getByRole("dialog");
  await expect(details).toBeVisible();
  await expect(details).toContainText("Status: in progress");
  expect(
    api.details.some(
      (url) => url.pathname === `/api/audit-logs/${logs[5]!.id}`,
    ),
  ).toBe(true);
  await details.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Entity", { exact: true }).selectOption("record");
  await expect
    .poll(() => ({
      entity: api.requests.at(-1)?.searchParams.get("entity_type"),
      offset: api.requests.at(-1)?.searchParams.get("offset"),
    }))
    .toEqual({ entity: "record", offset: "0" });
  await expect(
    page.getByText("Showing 1–5 of 6", { exact: true }),
  ).toBeVisible();
});

test("Audit export downloads server CSV beyond one page and blocks a failed stale preview until Retry succeeds", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const logs = makeAuditLogs(123);
  logs[0]!.target_label = "  =SUM(1,2)";
  logs[0]!.actor_name = 'Export person, "quoted"';
  const api = createAuditRoute(logs);
  let retryResponseGate = Promise.resolve();
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === "/api/audit-logs" &&
      url.searchParams.has("created_before")
    )
      await retryResponseGate;
    await api.handle(route);
  });
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByText("Showing 1–10 of 123", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("From", { exact: true }).fill("2026-09-01");
  await page.getByLabel("To", { exact: true }).fill("2026-09-12");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_after"))
    .toBe("2026-08-31T16:00:00.000Z");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
    .toBe("2026-09-12T15:59:59.999Z");

  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview).toContainText("123 filtered entries");
  await expect(preview.getByLabel("CSV preview")).toContainText("Mara Santos");
  await expect(preview.getByLabel("CSV preview")).not.toContainText("Source");
  await expect(preview).toContainText("Showing the first 10 of 123 entries");
  await expect(preview.getByLabel("CSV preview")).not.toContainText(
    logs[122]!.entity_id!,
  );
  expect(
    api.requests.every((url) => Number(url.searchParams.get("limit")) <= 10),
  ).toBe(true);
  expect(api.exports).toHaveLength(0);

  const downloadStarted = page.waitForEvent("download");
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("openslate-audit.csv");
  const csvPath = testInfo.outputPath("audit-filtered.csv");
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  expect(csv.trimEnd().split(/\r?\n/)).toHaveLength(124);
  expect(csv).toBe(api.exportBodies[0]);
  expect(csv).toContain('"Export person, ""quoted"""');
  expect(csv).toContain('"\'  =SUM(1,2)"');
  expect(api.exports).toHaveLength(1);
  const exported = api.exports[0]!.searchParams;
  expect(exported.get("created_after")).toBe("2026-08-31T16:00:00.000Z");
  expect(exported.get("created_before")).toBe("2026-09-12T15:59:59.999Z");
  expect(exported.get("sort_order")).toBe("desc");
  expect(exported.has("limit")).toBe(false);
  expect(exported.has("offset")).toBe(false);

  await expect(preview).not.toBeVisible();
  api.failList();
  // Reopening the same export after its cache goes stale refetches while
  // retaining the successful preparation; no query internals are injected.
  await page.clock.setSystemTime(new Date("2026-10-01T09:01:00Z"));
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preparationError = preview.getByRole("alert");
  await expect(preparationError).toContainText(
    "Audit export preview could not be loaded. Try again.",
  );
  const downloadCsv = preview.getByRole("button", {
    name: "Download CSV",
    exact: true,
  });
  await expect(downloadCsv).toBeDisabled();
  expect(downloads).toBe(1);

  api.allowList();
  logs[0]!.after = { status: "retry succeeded" };
  let releaseRetry: (() => void) | undefined;
  retryResponseGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  try {
    const retryStarted = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/audit-logs" &&
        url.searchParams.get("limit") === "10" &&
        url.searchParams.get("offset") === "0"
      );
    });
    await preparationError.getByRole("button", { name: "Retry" }).click();
    await retryStarted;
    await expect(downloadCsv).toBeDisabled();
    expect(downloads).toBe(1);
    releaseRetry?.();
    await expect(preparationError).not.toBeVisible();
    await expect(preview.getByLabel("CSV preview")).toContainText(
      "retry succeeded",
    );
    await expect(downloadCsv).toBeEnabled();

    const recoveredDownloadStarted = page.waitForEvent("download");
    await downloadCsv.click();
    const recoveredDownload = await recoveredDownloadStarted;
    const recoveredCsvPath = testInfo.outputPath("audit-recovered.csv");
    await recoveredDownload.saveAs(recoveredCsvPath);
    const recoveredCsv = await readFile(recoveredCsvPath, "utf8");
    expect(recoveredCsv.trimEnd().split(/\r?\n/)).toHaveLength(124);
    expect(recoveredCsv).toContain("retry succeeded");
    expect(recoveredCsv).toBe(api.exportBodies[1]);
    expect(downloads).toBe(2);
  } finally {
    releaseRetry?.();
  }
});

test("Audit unscoped reads and export hide cached data on refusal until explicit fresh Retry", async ({
  page,
}) => {
  const logs = makeAuditLogs();
  logs[0]!.after = { title: "Denied detail target", status: "active" };
  const api = createAuditRoute(logs);
  api.denyList();
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");

  const listDenied = page.getByRole("alert").filter({
    hasText: "Only administrators can view audit history.",
  });
  await expect(listDenied).toBeVisible();
  api.allowList();
  await listDenied.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("table", { name: "Activity history table", exact: true }),
  ).toBeVisible();

  api.denyDetails();
  await page
    .getByRole("button", {
      name: "View audit Denied detail target",
      exact: true,
    })
    .click();
  await expect(listDenied).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).not.toBeVisible();
  api.allowDetails();
  await listDenied.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  api.denyList();
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  await expect(listDenied).toBeVisible();
  await expect(preview).not.toBeVisible();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).not.toBeVisible();
  await page
    .getByRole("combobox", { name: "Sort activity" })
    .selectOption("oldest");
  await expect(listDenied).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).not.toBeVisible();
  expect(downloads).toBe(0);
  api.allowList();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(page).toHaveURL(/view=organization/);
  await expect(
    page.getByRole("heading", { name: "Organization", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/view=audit/);
  await expect(listDenied).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).not.toBeVisible();
  await page
    .getByRole("combobox", { name: "Sort activity" })
    .selectOption("oldest");
  await listDenied.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeVisible();
  expect(api.requests.at(-1)?.searchParams.get("sort_order")).toBe("asc");
});

for (const code of ["mfa_required", "ip_not_allowed"] as const) {
  test(`Audit coded export refusal ${code} delegates to the existing session gate and resumes without an admin latch`, async ({
    page,
  }) => {
    const state = await mockMfa(page, { verified: true, aal2: true });
    const api = createAuditRoute(makeAuditLogs());
    let blocked = true;
    let sessionChecks = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/auth/session")
        sessionChecks += 1;
    });
    await page.route("**/api/audit-logs**", async (route) => {
      if (
        new URL(route.request().url()).pathname === "/api/audit-logs/export" &&
        blocked
      ) {
        await route.fulfill({
          status: 403,
          json: {
            detail: {
              code,
              message:
                code === "mfa_required"
                  ? "Complete multi-factor authentication to continue"
                  : "Access from this address is not allowed",
            },
          },
        });
        return;
      }
      await api.handle(route);
    });
    await page.goto("/manage?view=audit");
    const table = page.getByRole("table", { name: "Activity history table" });
    await expect(table).toBeVisible();
    await page.getByRole("button", { name: "Export audit preview" }).click();
    const preview = page.getByRole("dialog", {
      name: "Audit export preview",
      exact: true,
    });
    await expect(
      preview.getByRole("button", { name: "Download CSV", exact: true }),
    ).toBeEnabled();
    const before = sessionChecks;
    if (code === "mfa_required")
      state.actors.get(state.userId)!.assurance = "aal1";
    else state.networkDenied = true;
    await preview
      .getByRole("button", { name: "Download CSV", exact: true })
      .click();
    const curtain = page.getByRole("dialog", {
      name: "Session verification",
      exact: true,
    });
    await expect(curtain).toBeVisible();
    if (code === "mfa_required")
      await expect(
        curtain.getByRole("heading", {
          name: "Complete multi-factor authentication",
          exact: true,
        }),
      ).toBeVisible();
    else
      await expect(
        curtain
          .getByRole("alert")
          .filter({ hasText: "address is not allowed" }),
      ).toBeVisible();
    await expect(table).not.toBeVisible();
    await expect(preview).not.toBeVisible();
    expect(sessionChecks).toBeGreaterThan(before);
    blocked = false;
    state.actors.get(state.userId)!.assurance = "aal2";
    state.networkDenied = false;
    await curtain
      .getByRole("button", {
        name: code === "mfa_required" ? "Retry session check" : "Retry",
        exact: true,
      })
      .click();
    await expect(curtain).not.toBeVisible();
    await expect(table).toBeVisible();
    await expect(
      page.getByText("Only administrators can view audit history.", {
        exact: true,
      }),
    ).not.toBeVisible();
    expect(state.calls.filter((call) => call.method === "POST")).toHaveLength(
      0,
    );
    await page.getByRole("button", { name: "Export audit preview" }).click();
    await expect(
      preview.getByRole("button", { name: "Download CSV", exact: true }),
    ).toBeEnabled();
    const downloaded = page.waitForEvent("download");
    await preview
      .getByRole("button", { name: "Download CSV", exact: true })
      .click();
    expect((await downloaded).suggestedFilename()).toBe("openslate-audit.csv");
  });
}

test("Audit CSV failure retains its pinned preview and Retry refuses malformed or oversized responses", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const api = createAuditRoute(makeAuditLogs(12));
  let failure: "unavailable" | "media" | "count" | "cap" | null = "unavailable";
  const downloads: string[] = [];
  const requests: URL[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/audit-logs/export") {
      requests.push(url);
      if (failure === "unavailable")
        return route.fulfill({
          status: 503,
          json: { detail: "Private upstream diagnostic" },
        });
      if (failure === "cap")
        return route.fulfill({
          status: 409,
          json: {
            detail: {
              code: "audit_export_limit",
              message:
                "Audit exports support up to 10,000 entries. Narrow your filters and try again.",
            },
          },
        });
      if (failure)
        return route.fulfill({
          body: CSV_HEADER,
          headers: {
            "Content-Type":
              failure === "media" ? "text/html" : "text/csv;charset=utf-8",
            "Content-Disposition": 'attachment; filename="openslate-audit.csv"',
            "Cache-Control": "no-store",
            "X-Audit-Export-Count": "10001",
          },
        });
    }
    await api.handle(route);
  });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByRole("table", { name: "Activity history table" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const alert = preview.getByRole("alert");
  await expect(alert).toContainText(
    "Audit CSV could not be downloaded. Try again.",
  );
  await expect(preview.getByLabel("CSV preview")).toContainText("Mara Santos");
  await expect(preview).not.toContainText("Private upstream diagnostic");
  const cutoff = requests[0]!.searchParams.get("created_before");
  await page.clock.setSystemTime(new Date("2026-10-01T09:05:00Z"));
  for (const next of ["media", "count", "cap"] as const) {
    failure = next;
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(alert).toContainText(
      next === "cap"
        ? "Audit exports support up to 10,000 entries. Narrow your filters and try again."
        : "Audit CSV could not be downloaded. Try again.",
    );
    expect(downloads).toHaveLength(0);
  }
  failure = null;
  const downloaded = page.waitForEvent("download");
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  const download = await downloaded;
  const path = testInfo.outputPath("audit-retried.csv");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(api.exportBodies[0]);
  expect(downloads).toEqual(["openslate-audit.csv"]);
  expect(requests).toHaveLength(5);
  expect(
    requests.every((url) => url.searchParams.get("created_before") === cutoff),
  ).toBe(true);
  await expect(preview).not.toBeVisible();
});

test("Audit Close, Escape, route leave and session concealment suppress pending CSV downloads", async ({
  page,
}) => {
  const api = createAuditRoute(makeAuditLogs());
  let hold: {
    response: Promise<void>;
    release: () => void;
    handled: Promise<void>;
    finish: () => void;
  } | null = null;
  let started = 0;
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.route("**/api/audit-logs**", async (route) => {
    if (
      new URL(route.request().url()).pathname === "/api/audit-logs/export" &&
      hold
    ) {
      const captured = hold;
      started += 1;
      await captured.response;
      try {
        await api.handle(route);
      } finally {
        captured.finish();
      }
      return;
    }
    await api.handle(route);
  });
  for (const method of ["Close", "Escape", "leave", "blur"] as const) {
    await page.goto("/manage?view=organization");
    await expect(
      page.getByRole("heading", { name: "Organization", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Audit", exact: true }).click();
    await expect(page).toHaveURL(/view=audit/);
    await expect(
      page.getByRole("table", { name: "Activity history table" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Export audit preview" }).click();
    const preview = page.getByRole("dialog", {
      name: "Audit export preview",
      exact: true,
    });
    await expect(
      preview.getByRole("button", { name: "Download CSV", exact: true }),
    ).toBeEnabled();
    let release!: () => void;
    let finish!: () => void;
    hold = {
      response: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
      handled: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    const barrier = hold;
    const before = started;
    try {
      await preview
        .getByRole("button", { name: "Download CSV", exact: true })
        .click();
      await expect.poll(() => started).toBe(before + 1);
      await expect(
        preview.getByRole("button", { name: "Download CSV", exact: true }),
      ).toBeDisabled();
      if (method === "Close")
        await preview
          .getByRole("button", { name: "Close preview", exact: true })
          .click();
      if (method === "Escape") await page.keyboard.press("Escape");
      if (method === "blur") {
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await expect(
          page.getByRole("dialog", {
            name: "Session verification",
            exact: true,
          }),
        ).toBeVisible();
      }
      if (method === "leave") {
        await page.goBack();
        await expect(page).toHaveURL(/view=organization/);
        await expect(
          page.getByRole("heading", { name: "Organization", exact: true }),
        ).toBeVisible();
      }
      await expect(preview).not.toBeVisible();
      barrier.release();
      await barrier.handled;
      if (method === "blur") {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(
          page.getByRole("dialog", {
            name: "Session verification",
            exact: true,
          }),
        ).not.toBeVisible();
        await expect(preview).toBeVisible();
        await expect(
          preview.getByRole("button", { name: "Download CSV", exact: true }),
        ).toBeEnabled();
        await preview
          .getByRole("button", { name: "Close preview", exact: true })
          .click();
      }
      expect(downloads).toBe(0);
      await expect(
        page.getByText(/Downloaded \d+ filtered audit/),
      ).not.toBeVisible();
    } finally {
      barrier.release();
      hold = null;
    }
  }
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/view=audit/);
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  const downloaded = page.waitForEvent("download");
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  await downloaded;
  await expect(preview).not.toBeVisible();
  expect(downloads).toBe(1);
});

test("Audit shows server actor names, meaningful targets and workspace-local date and time", async ({
  page,
}) => {
  let allowDateSettings = false;
  await page.route("**/api/workspace", (route) =>
    allowDateSettings
      ? route.fulfill({
          json: {
            id: fixtureId(77),
            display_name: "Harbor workspace",
            legal_name: null,
            description: null,
            contact_email: null,
            contact_phone: null,
            postal_address: null,
            locale: "fr-FR",
            timezone: "Asia/Manila",
            logo_file_id: null,
            mark: "RS",
            currency: "PHP",
            week_start: "monday",
            business_hours: "09:00–18:00",
            theme: "slate",
            revision: 4,
          },
        })
      : route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  const logs = makeAuditLogs(4);
  logs[1]!.actor_label = "Historical person label";
  logs[1]!.actor_name = null;
  logs[2]!.performed_by = UNKNOWN_ACTOR_ID;
  logs[2]!.actor_label = null;
  logs[2]!.actor_name = null;
  logs[0]!.actor_label = "historical import metadata";
  logs[0]!.actor_name = "Server display name";
  logs[0]!.before = { title: "Old record title" };
  logs[0]!.after = { title: "New record title" };
  logs[1]!.actor_label = "Historical person label";
  logs[1]!.before = { name: "Closed team" };
  logs[1]!.after = null;
  logs[2]!.after = { data: { title_field: "[REDACTED]" } };
  logs[2]!.target_label = "Record · name unavailable";
  logs[3]!.target_label = "Authorized current person";
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", async (route) => {
    if (
      new URL(route.request().url()).pathname ===
      `/api/audit-logs/${logs[0]!.id}`
    ) {
      await route.fulfill({
        json: {
          ...wireAuditLog(logs[0]!),
          actor_name: "Fresh detail name",
          created_at: "2026-09-12T13:45:00Z",
          after: { title: "Fresh detail title" },
          target_label: "Fresh detail title",
        },
      });
      return;
    }
    await api.handle(route);
  });
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  const namedRow = table
    .getByRole("row")
    .filter({ hasText: "New record title" });
  await expect(namedRow).toContainText("Server display name");
  await expect(namedRow.getByRole("cell").first()).toHaveText(
    "Date format unavailable",
  );
  allowDateSettings = true;
  await page
    .getByRole("button", { name: "Retry date settings", exact: true })
    .click();
  await expect(namedRow.getByRole("cell").first()).toHaveText(
    "12 sept. 2026, 20:30",
  );
  await expect(
    table.getByText("Unknown person", { exact: true }).first(),
  ).toBeVisible();
  await expect(table.getByText("Closed team", { exact: true })).toBeVisible();
  await expect(
    table.getByText("Record · name unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    table.getByText("Authorized current person", { exact: true }),
  ).toBeVisible();
  await expect(table).not.toContainText(logs[2]!.entity_id!);
  await page.getByRole("button", { name: "More filters" }).click();
  await expect(
    page.locator(`#audit-user option[value="${ACTOR_ID}"]`),
  ).toHaveText("Server display name");
  await expect(
    page.locator(`#audit-user option[value="${NULL_LABEL_ACTOR_ID}"]`),
  ).toHaveText("Historical person label");
  await expect(
    page.locator(`#audit-user option[value="${UNKNOWN_ACTOR_ID}"]`),
  ).toHaveText("Unknown person");
  await page.getByRole("button", { name: "More filters" }).click();
  await namedRow
    .getByRole("button", { name: "View audit New record title", exact: true })
    .click();
  const detail = page.getByRole("dialog", {
    name: /Audit entry detail/,
  });
  await expect(
    detail.getByText("Fresh detail name · 12 sept. 2026, 21:45", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    detail.getByText("Update · Record", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("Fresh detail title", { exact: true }),
  ).toBeVisible();
  await expect(detail).not.toContainText("2026-09-12T13:45:00Z");

  await detail.getByRole("button", { name: "Close detail" }).click();
  await page
    .getByRole("button", {
      name: "View audit Record · name unavailable",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Audit entry detail · Record · name unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: /Audit entry detail/ }),
  ).not.toContainText(logs[2]!.entity_id!);
});

test("Audit search waits for typing to settle before sending its server query", async ({
  page,
}) => {
  const api = createAuditRoute(makeAuditLogs());
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  await expect(
    page.getByRole("table", { name: "Activity history table", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .pressSequentially("delete", { delay: 20 });
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("delete");
  expect(
    api.requests.map((url) => url.searchParams.get("search")).filter(Boolean),
  ).toEqual(["delete"]);
});

test("Audit date filters use workspace-local day bounds across a daylight-saving change", async ({
  page,
}) => {
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        id: fixtureId(77),
        display_name: "Harbor workspace",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        locale: "en-US",
        timezone: "America/New_York",
        logo_file_id: null,
        mark: "RS",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
        theme: "slate",
        revision: 4,
      },
    }),
  );
  const logs = makeAuditLogs(5);
  const localDayRows = [
    ["2026-03-08T04:59:59.999Z", "Before local day"],
    ["2026-03-08T05:00:00.000Z", "At local day start"],
    ["2026-03-08T07:00:00.000Z", "After clock change"],
    ["2026-03-09T03:59:59.999Z", "At local day end"],
    ["2026-03-09T04:00:00.000Z", "After local day"],
  ] as const;
  logs.forEach((log, index) => {
    log.created_at = localDayRows[index]![0];
    log.after = { name: localDayRows[index]![1] };
  });
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table).toBeVisible();
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("From", { exact: true }).fill("2026-03-08");
  await page.getByLabel("To", { exact: true }).fill("2026-03-08");

  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_after"))
    .toBe("2026-03-08T05:00:00.000Z");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
    .toBe("2026-03-09T03:59:59.999Z");
  await expect(
    page.getByText("Showing 1–3 of 3", { exact: true }),
  ).toBeVisible();
  await expect(table).toContainText("At local day start");
  await expect(table).toContainText("After clock change");
  await expect(table).toContainText("At local day end");
  await expect(table).not.toContainText("Before local day");
  await expect(table).not.toContainText("After local day");
});

test("Audit export uses the last settled search while a newer search is debouncing", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const api = createAuditRoute(makeAuditLogs());
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  const table = page.getByRole("table", {
    name: "Activity history table",
    exact: true,
  });
  await expect(table).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "Search activity",
    exact: true,
  });
  await search.fill("delete");
  await page.clock.runFor(300);
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("search"))
    .toBe("delete");
  await search.fill("assigned");
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      api.requests
        .find((url) => url.searchParams.get("created_before"))
        ?.searchParams.get("search"),
    )
    .toBe("delete");
});

test("Audit export pins the opening horizon through preview retry and server CSV download", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const logs = makeAuditLogs(102);
  logs[0]!.actor_label = "import metadata";
  logs[0]!.actor_name = "Export person";
  const api = createAuditRoute(logs);
  let failExport = true;
  let addedConcurrentEntry = false;
  const exportRequests: URL[] = [];
  await page.route("**/api/audit-logs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("created_before") === "2026-10-01T09:00:00.000Z") {
      exportRequests.push(url);
      if (failExport) {
        await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
        return;
      }
      if (url.pathname === "/api/audit-logs/export" && !addedConcurrentEntry) {
        addedConcurrentEntry = true;
        logs.push({
          ...logs[0]!,
          id: fixtureId(9999),
          created_at: "2026-10-01T09:00:01Z",
          after: { title: "Concurrent future entry" },
        });
      }
    }
    await api.handle(route);
  });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByText("Showing 1–10 of 102", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("To", { exact: true }).fill("2026-10-02");
  await expect
    .poll(() => api.requests.at(-1)?.searchParams.get("created_before"))
    .toBe("2026-10-02T15:59:59.999Z");
  // Freeze the user's opening instant, independent of browser/test duration.
  await page.clock.setFixedTime(new Date("2026-10-01T09:00:00Z"));
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview.getByRole("alert")).toBeVisible();
  expect(exportRequests[0]?.searchParams.get("created_before")).toBe(
    "2026-10-01T09:00:00.000Z",
  );
  failExport = false;
  await page.clock.setFixedTime(new Date("2026-10-01T09:05:00Z"));
  await preview.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  await expect(preview).toContainText("102 filtered entries");
  const downloaded = page.waitForEvent("download");
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const download = await downloaded;
  const csvPath = testInfo.outputPath("audit-pinned.csv");
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  expect(csv.trimEnd().split(/\r?\n/)).toHaveLength(103);
  expect(csv).toContain("Export person");
  expect(csv).not.toContain("Concurrent future entry");
  expect(
    exportRequests.filter((url) => url.pathname === "/api/audit-logs/export"),
  ).toHaveLength(1);
  expect(
    exportRequests.every(
      (url) =>
        url.searchParams.get("created_before") === "2026-10-01T09:00:00.000Z",
    ),
  ).toBe(true);
  expect(
    api.requests.every((url) => Number(url.searchParams.get("limit")) <= 10),
  ).toBe(true);
});

test("Audit export refuses more than 10000 rows and exports the header after filters narrow to zero", async ({
  page,
}, testInfo) => {
  const api = createAuditRoute(makeAuditLogs(10001));
  await page.route("**/api/audit-logs**", (route) => api.handle(route));
  await page.goto("/manage?view=audit");
  await expect(
    page.getByText("Showing 1–10 of 10001", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preview = page.getByRole("dialog", {
    name: "Audit export preview",
    exact: true,
  });
  await expect(preview.getByRole("alert")).toContainText(
    "Audit exports support up to 10,000 entries. Narrow your filters and try again.",
  );
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeDisabled();
  expect(
    api.requests.every((url) => Number(url.searchParams.get("limit")) <= 10),
  ).toBe(true);
  expect(api.exports).toHaveLength(0);
  await preview
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search activity", exact: true })
    .fill("no matching activity");
  await expect(
    page.getByText("No audit entries match these filters", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Export audit preview" }).click();
  await expect(preview).toContainText("0 filtered entries");
  await expect(
    preview.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeEnabled();
  const downloaded = page.waitForEvent("download", { timeout: 5000 });
  await preview
    .getByRole("button", { name: "Download CSV", exact: true })
    .click();
  const download = await downloaded;
  const path = testInfo.outputPath("audit-empty.csv");
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(
    '"Date","User","Entity","Action","Target","Before","After"',
  );
  expect(api.exports).toHaveLength(1);
  expect(api.exports[0]!.searchParams.get("search")).toBe(
    "no matching activity",
  );
  await expect(preview).not.toBeVisible();
  await expect(
    page.getByText("Downloaded 0 filtered audit entries.", { exact: true }),
  ).toBeVisible();
});
