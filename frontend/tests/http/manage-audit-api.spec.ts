import { readFile } from "node:fs/promises";

import { expect, test, type Route } from "./helpers/test";

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
};

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
  let listDenied = false;
  let detailDenied = false;

  return {
    requests,
    details,
    denyList() {
      listDenied = true;
    },
    allowList() {
      listDenied = false;
    },
    denyDetails() {
      detailDenied = true;
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
      if (url.pathname !== "/api/audit-logs") {
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
          json: selected ? selected : { detail: "Audit log not found" },
        });
        return;
      }

      requests.push(url);
      if (listDenied) {
        await route.fulfill({
          status: 403,
          json: { detail: "Forbidden" },
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

      const limit = Number(params.get("limit") ?? 20);
      const offset = Number(params.get("offset") ?? 0);
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
    },
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        id: fixtureId(77),
        display_name: "Harbor workspace",
        locale: "fr-FR",
        timezone: "Asia/Manila",
        mark: "RS",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
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

test("Audit export downloads every filtered server page and blocks a failed stale preparation until Retry succeeds", async ({
  page,
}, testInfo) => {
  await page.clock.install({ time: new Date("2026-10-01T09:00:00Z") });
  const logs = makeAuditLogs(123);
  const api = createAuditRoute(logs);
  let retryResponseGate = Promise.resolve();
  await page.route("**/api/audit-logs**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("limit") === "100")
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
  await expect
    .poll(
      () =>
        api.requests.filter((url) => url.searchParams.get("limit") === "100")
          .length,
    )
    .toBe(2);
  expect(
    api.requests
      .filter((url) => url.searchParams.get("limit") === "100")
      .map((url) => url.searchParams.get("offset")),
  ).toEqual(["0", "100"]);

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

  await expect(preview).not.toBeVisible();
  api.denyList();
  // Reopening the same export after its cache goes stale refetches while
  // retaining the successful preparation; no query internals are injected.
  await page.clock.setSystemTime(new Date("2026-10-01T09:01:00Z"));
  await page.getByRole("button", { name: "Export audit preview" }).click();
  const preparationError = preview.getByRole("alert");
  await expect(preparationError).toContainText(
    "Could not load every filtered audit entry. Try again.",
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
        url.searchParams.get("limit") === "100" &&
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
    expect(downloads).toBe(2);
  } finally {
    releaseRetry?.();
  }
});

test("Audit list and detail expose denied states and recover after access returns", async ({
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
  const details = page.getByRole("dialog");
  await expect(
    details.getByRole("alert").filter({
      hasText: "You do not have permission to view this audit entry.",
    }),
  ).toBeVisible();
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
            locale: "fr-FR",
            timezone: "Asia/Manila",
            mark: "RS",
            currency: "PHP",
            week_start: "monday",
            business_hours: "09:00–18:00",
            revision: 4,
          },
        })
      : route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  const logs = makeAuditLogs(3);
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
  const api = createAuditRoute(logs);
  await page.route("**/api/audit-logs**", async (route) => {
    if (
      new URL(route.request().url()).pathname ===
      `/api/audit-logs/${logs[0]!.id}`
    ) {
      await route.fulfill({
        json: {
          ...logs[0],
          actor_name: "Fresh detail name",
          created_at: "2026-09-12T13:45:00Z",
          after: { title: "Fresh detail title" },
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
    table.getByText("Record · name not recorded", { exact: true }),
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
      name: "View audit Record · name not recorded",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Audit entry detail · Record · name not recorded",
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
        locale: "en-US",
        timezone: "America/New_York",
        mark: "RS",
        currency: "PHP",
        week_start: "monday",
        business_hours: "09:00–18:00",
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
        .find((url) => url.searchParams.get("limit") === "100")
        ?.searchParams.get("search"),
    )
    .toBe("delete");
});

test("Audit export pins the opening horizon through retry and subsequent pages", async ({
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
    if (url.searchParams.get("limit") === "100") {
      exportRequests.push(url);
      if (failExport) {
        await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
        return;
      }
      if (url.searchParams.get("offset") === "100" && !addedConcurrentEntry) {
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
  expect(
    exportRequests.map((url) => url.searchParams.get("created_before")),
  ).toEqual([
    "2026-10-01T09:00:00.000Z",
    "2026-10-01T09:00:00.000Z",
    "2026-10-01T09:00:00.000Z",
  ]);
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
});

test("Audit export refuses more than 10000 rows with guidance to narrow filters", async ({
  page,
}) => {
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
    api.requests.filter((url) => url.searchParams.get("limit") === "100"),
  ).toHaveLength(1);
});
