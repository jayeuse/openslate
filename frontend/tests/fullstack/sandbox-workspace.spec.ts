import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page, Request, Response } from "@playwright/test";

type Fixture = Readonly<{
  runId: string;
  baseURL: string;
  admin: Readonly<{ email: string; password: string }>;
}>;

function fixture(): Fixture {
  const location = process.env.OPENSLATE_FULLSTACK_FIXTURE;
  const runId = process.env.OPENSLATE_FULLSTACK_RUN_ID;
  if (!location || !runId) throw new Error("full-stack fixture is unavailable");
  const value = JSON.parse(readFileSync(location, "utf8")) as Fixture;
  if (
    value.runId !== runId ||
    value.baseURL !== test.info().project.use.baseURL
  )
    throw new Error("full-stack fixture does not match this gateway run");
  return value;
}

async function applyTemplate(page: Page, name: string) {
  await page.getByRole("button", { name: "More Sandbox actions" }).click();
  await page.getByRole("menuitem", { name: "Start from a template" }).click();
  await page.getByRole("button", { name: `Select ${name}` }).click();
  await page.getByRole("button", { name: `Use ${name}` }).click();
  await expect(
    page.getByText(`${name} template applied to the shared Sandbox.`),
  ).toBeVisible();
}

/** Publish the draft and return the new version's sequence number. */
async function publishDraft(page: Page, password: string): Promise<number> {
  const preview = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/sandbox/publication-previews" &&
      response.request().method() === "POST" &&
      response.status() !== 401,
    { timeout: 45_000 },
  );
  // Opening the dialog starts the review; no second click is needed.
  await page.getByRole("button", { name: "Review & Publish" }).click();
  expect((await preview).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
  await page.getByLabel("Your password").fill(password);
  const published = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sandbox/publications" &&
      response.request().method() === "POST" &&
      response.status() !== 401,
    { timeout: 45_000 },
  );
  await page.getByRole("button", { name: "Publish changes" }).click();
  const response = await published;
  expect(response.status()).toBe(201);
  await expect(
    page.getByText("Your changes are now published to the live workspace."),
  ).toBeVisible();
  const body = (await response.json()) as { version: { sequence: number } };
  return body.version.sequence;
}

type SeededSupplier = Readonly<{
  recordId: string;
  moduleId: string;
  departmentId: string;
  legalNameFieldId: string;
  paymentTermsFieldId: string;
  paymentTermsOptionId: string;
  legalName: string;
}>;

async function seedPublishedSupplier(
  page: Page,
  runId: string,
): Promise<SeededSupplier> {
  const seeded = await page.evaluate(async (currentRunId) => {
    type CatalogPage = Readonly<{
      items: ReadonlyArray<
        Readonly<{
          id: string;
          name: string;
          type?: string;
          department_id?: string;
          config?: Readonly<{
            options?: ReadonlyArray<Readonly<{ id: string; label: string }>>;
          }>;
        }>
      >;
      pagination: Readonly<{ has_more: boolean }>;
    }>;
    async function readCatalog(path: string): Promise<CatalogPage> {
      const response = await fetch(path, { credentials: "same-origin" });
      if (response.status !== 200)
        throw new Error(
          `Published data-source catalog returned ${response.status}`,
        );
      return (await response.json()) as CatalogPage;
    }

    const modules = await readCatalog(
      "/api/views/data-sources?limit=100&offset=0",
    );
    if (modules.pagination.has_more)
      throw new Error("Published data-source catalog is incomplete");
    const suppliers = modules.items.filter((item) => item.name === "Suppliers");
    if (suppliers.length !== 1)
      throw new Error(
        "Published Suppliers data source is unavailable or ambiguous",
      );
    const moduleId = suppliers[0].id;
    const departmentId = suppliers[0].department_id;
    if (!departmentId)
      throw new Error("Published Suppliers department is unavailable");

    const fields = await readCatalog(
      `/api/views/data-sources/${encodeURIComponent(moduleId)}/fields?limit=100&offset=0`,
    );
    if (fields.pagination.has_more)
      throw new Error("Published Suppliers field catalog is incomplete");
    function field(name: string, type: string): CatalogPage["items"][number] {
      const matches = fields.items.filter(
        (item) => item.name === name && item.type === type,
      );
      if (matches.length !== 1)
        throw new Error(
          `Published Suppliers field ${name} is unavailable or ambiguous`,
        );
      return matches[0];
    }
    function optionId(name: string, label: string): string {
      const options = field(name, "select").config?.options;
      const matches = options?.filter((option) => option.label === label);
      if (matches?.length !== 1)
        throw new Error(
          `Published Suppliers ${name} option ${label} is unavailable or ambiguous`,
        );
      return matches[0].id;
    }
    const legalNameFieldId = field("Legal name", "text").id;
    const paymentTermsFieldId = field("Payment terms", "select").id;
    const supplierIdFieldId = field("Supplier ID", "text").id;
    const statusFieldId = field("Status", "select").id;
    const statusOptionId = optionId("Status", "Active");
    const paymentTermsOptionId = optionId("Payment terms", "Net 30");
    const legalName = `Full-stack Supplier ${currentRunId}`;

    // Keep the cookie value inside the browser context; only synthetic record
    // identifiers and the creation status return to the test process.
    const csrfCookie = document.cookie
      .split(";")
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("openslate_csrf="));
    if (!csrfCookie) throw new Error("CSRF cookie is unavailable");
    const csrfToken = decodeURIComponent(
      csrfCookie.slice("openslate_csrf=".length),
    );
    const response = await fetch("/api/records", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        module_id: moduleId,
        data: {
          [supplierIdFieldId]: `SUP-${currentRunId}`,
          [statusFieldId]: statusOptionId,
          [legalNameFieldId]: legalName,
          [paymentTermsFieldId]: paymentTermsOptionId,
        },
      }),
    });
    const created = response.status === 201 ? await response.json() : null;
    return {
      status: response.status,
      recordId: (created as { id?: string } | null)?.id ?? "",
      moduleId,
      departmentId,
      legalNameFieldId,
      paymentTermsFieldId,
      paymentTermsOptionId,
      legalName,
    };
  }, runId);

  expect(seeded.status).toBe(201);
  for (const id of [
    seeded.recordId,
    seeded.moduleId,
    seeded.departmentId,
    seeded.legalNameFieldId,
    seeded.paymentTermsFieldId,
    seeded.paymentTermsOptionId,
  ]) {
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  }
  return seeded;
}

async function retireSeededSupplier(page: Page, recordId: string) {
  const status = await page.evaluate(async (id) => {
    const csrfCookie = document.cookie
      .split(";")
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("openslate_csrf="));
    if (!csrfCookie) throw new Error("CSRF cookie is unavailable");
    const csrfToken = decodeURIComponent(
      csrfCookie.slice("openslate_csrf=".length),
    );
    const response = await fetch(`/api/records/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrfToken },
    });
    return response.status;
  }, recordId);
  expect(status).toBe(204);
}

async function exerciseOpenView(
  page: Page,
  runId: string,
  supplier: SeededSupplier,
) {
  const viewName = `Full-stack OpenView ${runId.slice(0, 8)}`;
  await page.goto("/openview?section=views");
  const dataSource = page.getByLabel("Data source");
  await expect(dataSource).toBeVisible();
  await dataSource.selectOption({ label: "Suppliers" });
  await expect(
    page.getByRole("searchbox", { name: "Search Suppliers", exact: true }),
  ).toBeVisible();
  const moduleId = await dataSource.inputValue();
  expect(moduleId).toBe(supplier.moduleId);
  expect(moduleId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const recordResults = page.getByRole("region", { name: "Record results" });
  await expect(
    recordResults.getByText(supplier.legalName, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save view as" }).click();
  const saveDialog = page.getByRole("dialog", { name: "Save view" });
  await saveDialog.getByLabel("View name").fill(viewName);
  await saveDialog.getByRole("button", { name: "Save view" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `“${viewName}” was saved.` }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/openview\\?section=views&module=${moduleId}&view=`),
  );
  const viewId = new URL(page.url()).searchParams.get("view");
  expect(viewId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  if (!viewId) throw new Error("saved view URL did not include its ID");

  await page.reload();
  await expect(page.getByLabel("Saved view")).toHaveValue(viewId);
  await expect(
    recordResults.getByText(supplier.legalName, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Make default view" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "default view of this module" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "View actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Clear default view" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const concurrentPage = await page.context().newPage();
  let overloadedScripts = 0;
  concurrentPage.on("response", (response) => {
    if (
      response.request().resourceType() === "script" &&
      response.status() === 503
    )
      overloadedScripts += 1;
  });
  await concurrentPage.goto(
    `/openview?section=views&module=${moduleId}&view=${viewId}`,
  );
  await expect(concurrentPage.getByLabel("Saved view")).toHaveValue(viewId, {
    timeout: 20_000,
  });
  expect(overloadedScripts).toBe(0);

  const currentSearch = `first revision ${runId.slice(0, 6)}`;
  await page
    .getByRole("searchbox", { name: "Search Suppliers", exact: true })
    .fill(currentSearch);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `“${viewName}” was saved.` }),
  ).toBeVisible();

  await concurrentPage
    .getByRole("searchbox", { name: "Search Suppliers", exact: true })
    .fill(`stale revision ${runId.slice(0, 6)}`);
  await concurrentPage.getByRole("button", { name: "Save changes" }).click();
  const conflictDialog = concurrentPage.getByRole("dialog", {
    name: "Update saved view",
  });
  await expect(
    conflictDialog.getByText(/Query, filters, or sort/),
  ).toBeVisible();
  await conflictDialog.getByRole("button", { name: "Reload latest" }).click();
  await expect(
    concurrentPage.getByRole("searchbox", {
      name: "Search Suppliers",
      exact: true,
    }),
  ).toHaveValue(currentSearch);
  await concurrentPage.close();

  await page.getByRole("button", { name: "View actions" }).click();
  await page.getByRole("menuitem", { name: "Archive view" }).click();
  const archiveDialog = page.getByRole("alertdialog", {
    name: "Archive saved view?",
  });
  await archiveDialog.getByRole("button", { name: "Archive view" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "archived" }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Archived views/ }).click();
  const archivedDialog = page.getByRole("dialog", { name: "Archived views" });
  await expect(
    archivedDialog.getByText(viewName, { exact: true }),
  ).toBeVisible();
  await archivedDialog
    .getByRole("button", { name: `Restore ${viewName}` })
    .click();
  await expect(
    archivedDialog.getByRole("status").filter({ hasText: "restored" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]view=${viewId}(?:&|$)`));
  await expect(page.getByLabel("Saved view")).toHaveValue(viewId, {
    timeout: 20_000,
  });
}

async function exerciseLiveCharts(page: Page, supplier: SeededSupplier) {
  await page.goto("/openview?section=charts");
  await expect(
    page.getByRole("heading", { name: "Charts", level: 1, exact: true }),
  ).toBeVisible();

  const dataSource = page.getByLabel("Data source");
  await expect(dataSource).toBeVisible();
  await dataSource.selectOption({ label: "Suppliers" });
  await expect(dataSource).toHaveValue(supplier.moduleId);
  await page
    .getByRole("combobox", { name: "Group by", exact: true })
    .selectOption({ label: "Payment terms" });
  await expect(
    page.getByRole("combobox", { name: "Group by", exact: true }),
  ).toHaveValue(supplier.paymentTermsFieldId);
  await page.getByRole("button", { name: "Apply chart" }).click();

  const table = page.getByRole("table", { name: "Complete aggregate data" });
  await expect(table).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Group" }),
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Records" }),
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Record count" }),
  ).toBeVisible();

  const net30Row = table.getByRole("row").filter({ hasText: "Net 30" });
  await expect(net30Row.getByRole("cell")).toHaveText(["Net 30", "1", "1"]);
  await expect(
    page.getByText(/1 aggregate groups · one complete snapshot/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download complete CSV" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Print complete table" }),
  ).toBeEnabled();
}

async function permanentlyDeleteReport(page: Page, reportId: string) {
  const status = await page.evaluate(async (id) => {
    const csrfCookie = document.cookie
      .split(";")
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("openslate_csrf="));
    if (!csrfCookie) throw new Error("CSRF cookie is unavailable");
    const csrfToken = decodeURIComponent(
      csrfCookie.slice("openslate_csrf=".length),
    );
    const path = `/api/reports/${encodeURIComponent(id)}`;
    const current = await fetch(path, { credentials: "same-origin" });
    if (current.status === 404) return 204;
    if (current.status !== 200)
      throw new Error(`Report cleanup read returned ${current.status}`);
    const report = (await current.json()) as {
      revision: number;
      is_deleted: boolean;
    };
    if (!report.is_deleted) {
      const archived = await fetch(`${path}?revision=${report.revision}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken },
      });
      if (archived.status !== 204)
        throw new Error(`Report cleanup archive returned ${archived.status}`);
      report.revision += 1;
    }
    const deleted = await fetch(
      `${path}/permanent?revision=${report.revision}`,
      {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken },
      },
    );
    return deleted.status;
  }, reportId);
  expect(status).toBe(204);
}

async function exerciseConnectedReports(
  page: Page,
  runId: string,
  supplier: SeededSupplier,
) {
  const reportName = `Full-stack Supplier Report ${runId.slice(0, 8)}`;
  let reportId: string | null = null;
  await page.goto("/openview?section=reports");
  await expect(
    page.getByRole("heading", { name: "Reports", exact: true }),
  ).toBeVisible();
  try {
    await page.getByRole("button", { name: "New Report" }).click();
    await page.getByLabel("Data source").selectOption({ label: "Suppliers" });
    await page.getByLabel("Report name").fill(reportName);
    await page
      .getByRole("dialog", { name: "New report", exact: true })
      .getByRole("tab", { name: "Columns", exact: true })
      .click();
    await page.getByRole("checkbox", { name: "Legal name" }).check();
    await page.getByRole("checkbox", { name: "Payment terms" }).check();
    const [created] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/reports" &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Create Report" }).click(),
    ]);
    expect(created.status()).toBe(201);
    const createdReport = (await created.json()) as {
      id: string;
      module_id: string;
      revision: number;
      recipe: { fields: { field_id: string }[] };
    };
    reportId = createdReport.id;
    expect(reportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createdReport.module_id).toBe(supplier.moduleId);
    expect(createdReport.revision).toBe(1);
    expect(createdReport.recipe.fields.map((field) => field.field_id)).toEqual([
      supplier.legalNameFieldId,
      supplier.paymentTermsFieldId,
    ]);
    await expect(
      page.getByRole("dialog", { name: "Edit report" }).getByRole("status"),
    ).toHaveText("Report created.");

    await page.reload();
    // The card also names the department of the Report module.
    await page.getByRole("button", { name: reportName }).click();
    await page
      .getByRole("button", { name: "Edit report", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "Edit report" });
    await expect(editor).toBeVisible();
    await expect(page.getByLabel("Data source")).toHaveValue(supplier.moduleId);
    await expect(page.getByLabel("Report name")).toHaveValue(reportName);
    await editor.getByRole("tab", { name: "Columns", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Legal name" }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Payment terms" }),
    ).toBeChecked();

    await editor.getByRole("button", { name: "Close editor" }).click();
    await expect(editor).toBeHidden();
    const [runResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/reports/${reportId}/runs` &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Run now" }).click(),
    ]);
    expect(runResponse.status()).toBe(201);
    const run = (await runResponse.json()) as {
      id: string;
      row_count: number;
      headings: string[];
    };
    expect(run.row_count).toBe(1);
    expect(run.headings).toEqual(["Legal name", "Payment terms"]);
    await expect(page.getByText("Report run saved with 1 row.")).toBeVisible();
    await page.getByRole("button", { name: "Available outputs" }).click();
    const availableRuns = page.getByRole("dialog", {
      name: "Available outputs",
    });
    await expect(
      availableRuns.getByRole("cell", { name: reportName, exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(availableRuns).toBeHidden();
    const savedRuns = page.getByRole("table", {
      name: "Saved outputs",
      exact: true,
    });
    await expect(
      savedRuns.getByRole("cell", { name: "Recipe version 1", exact: true }),
    ).toBeVisible();
    await expect(
      savedRuns.getByRole("cell", { name: "1", exact: true }),
    ).toBeVisible();

    const [csvResponse, download] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/reports/${reportId}/runs/${run.id}/csv` &&
          response.request().method() === "GET",
      ),
      page.waitForEvent("download"),
      savedRuns.getByRole("button", { name: /^Download CSV for / }).click(),
    ]);
    expect(csvResponse.status()).toBe(200);
    expect(csvResponse.headers()["cache-control"]).toBe("private, no-store");
    expect(download.suggestedFilename()).toBe(`report-${run.id}.csv`);
    expect(readFileSync(await download.path(), "utf8")).toBe(
      `Legal name,Payment terms\r\n${supplier.legalName},Net 30\r\n`,
    );

    await page.getByRole("tab", { name: "Schedule", exact: true }).click();
    await page.getByRole("checkbox", { name: "Enable scheduled runs" }).check();
    await page.getByRole("textbox", { name: "Timezone" }).fill("UTC");
    const [scheduleResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/api/reports/${reportId}/schedule` &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Create schedule" }).click(),
    ]);
    expect(scheduleResponse.status()).toBe(201);
    await expect(page.getByText("Schedule saved and enabled.")).toBeVisible();
    await expect(page.getByText(/^Next run:/)).toBeVisible();

    await page.getByRole("button", { name: "Report options" }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    const [archived] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/reports/${reportId}` &&
          response.request().method() === "DELETE",
      ),
      page.getByRole("menuitem", { name: "Archive Report" }).click(),
    ]);
    expect(archived.status()).toBe(204);
    await expect(page.getByText("Report archived.")).toBeVisible();
  } finally {
    if (reportId) await permanentlyDeleteReport(page, reportId);
  }
}

async function exerciseConnectedBoard(
  page: Page,
  runId: string,
  supplier: SeededSupplier,
) {
  const boardName = `Full-stack Board ${runId.slice(0, 8)}`;
  const eventTitle = `Supplier review ${runId.slice(0, 8)}`;
  const postTitle = `Supplier update ${runId.slice(0, 8)}`;
  const recordLinkTitle = `Record ${supplier.recordId.slice(0, 8)}`;
  const recordLinkTarget = `/openview?module=${supplier.moduleId}&record=${supplier.recordId}`;
  const imagePath = join(process.cwd(), "../references/image.png");
  const imageBytes = readFileSync(imagePath);

  await page.goto("/boards");
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New project Board", exact: true })
    .click();
  await page.getByLabel("Board name").fill(boardName);
  const [createdBoard] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/boards" &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Create Board" }).click(),
  ]);
  expect(createdBoard.status()).toBe(201);
  const boardId = ((await createdBoard.json()) as { id: string }).id;
  await expect(page.getByRole("heading", { name: boardName })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`board=${boardId}`));

  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "New event" }).click();
  await page.getByLabel("Event title").fill(eventTitle);
  await page.getByRole("checkbox", { name: "1 day before" }).click();
  const [createdEvent] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/boards/${boardId}/events` &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Create event" }).click(),
  ]);
  expect(createdEvent.status()).toBe(201);
  const eventId = ((await createdEvent.json()) as { id: string }).id;
  await expect(page.getByText("Event created.")).toBeVisible();
  await page.getByRole("button", { name: "Event lists" }).click();
  await page.getByRole("menuitem", { name: "My events", exact: true }).click();
  const createdEventList = page.getByRole("region", { name: "My events" });
  await createdEventList
    .getByRole("button", { name: `Edit ${eventTitle}` })
    .click();
  const eventEditor = page.getByRole("form", { name: "Edit Board event" });
  await expect(
    eventEditor.getByRole("checkbox", { name: "1 day before" }),
  ).toBeChecked();
  await eventEditor.getByLabel("Add an attachment").setInputFiles(imagePath);
  await expect(eventEditor.getByText("image.png attached.")).toBeVisible({
    timeout: 70_000,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    eventEditor.getByRole("button", { name: "Download image.png" }).click(),
  ]);
  expect(readFileSync(await download.path())).toEqual(imageBytes);
  await eventEditor
    .getByLabel("Record data source")
    .selectOption({ label: "Suppliers" });
  await eventEditor
    .getByLabel("Record to link")
    .selectOption(supplier.recordId);
  const [eventLink] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/boards/${boardId}/events/${eventId}/record-links` &&
        response.request().method() === "POST",
    ),
    eventEditor.getByRole("button", { name: "Link Record" }).click(),
  ]);
  expect(eventLink.status()).toBe(201);
  const eventRecordLink = eventEditor.getByRole("link", {
    name: recordLinkTitle,
    exact: true,
  });
  await expect(eventRecordLink).toBeVisible();
  await expect(eventRecordLink).toHaveAttribute("href", recordLinkTarget);
  await eventEditor
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  const secondTitle = `Supplier follow-up ${runId.slice(0, 8)}`;
  await page.getByRole("button", { name: "New event" }).click();
  const secondEditor = page.getByRole("form", {
    name: "Create Board event",
  });
  await secondEditor.getByLabel("Event title").fill(secondTitle);
  const [secondCreated] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/boards/${boardId}/events` &&
        response.request().method() === "POST",
    ),
    secondEditor.getByRole("button", { name: "Create event" }).click(),
  ]);
  expect(secondCreated.status()).toBe(201);
  await page.getByRole("button", { name: "Event lists" }).click();
  await page.getByRole("menuitem", { name: "My events", exact: true }).click();
  const myEvents = page.getByRole("region", { name: "My events" });
  await myEvents.getByRole("button", { name: `Edit ${secondTitle}` }).click();
  const updatedSecondTitle = `${secondTitle} updated`;
  const secondUpdateEditor = page.getByRole("form", {
    name: "Edit Board event",
  });
  await secondUpdateEditor.getByLabel("Event title").fill(updatedSecondTitle);
  const [secondUpdated] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith(
          `/api/boards/${boardId}/events/`,
        ) && response.request().method() === "PATCH",
    ),
    secondUpdateEditor.getByRole("button", { name: "Save event" }).click(),
  ]);
  expect(secondUpdated.status()).toBe(200);
  await expect(
    myEvents.getByRole("button", { name: `Edit ${updatedSecondTitle}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Event lists" }).click();
  await page.getByRole("menuitem", { name: "My events", exact: true }).click();
  await expect(
    myEvents.getByRole("button", { name: `Edit ${updatedSecondTitle}` }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Event lists" }).click();
  await page.getByRole("menuitem", { name: "My events", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "My events" })
      .getByRole("button", { name: `Edit ${updatedSecondTitle}` }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Posts", exact: true }).click();
  await page.getByRole("button", { name: "New post" }).click();
  await page.getByLabel("Title", { exact: true }).fill(postTitle);
  await page.getByLabel("Message").fill("Supplier review is complete.");
  const [createdPost] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/boards/${boardId}/posts` &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Save draft" }).click(),
  ]);
  expect(createdPost.status()).toBe(201);
  const postId = ((await createdPost.json()) as { id: string }).id;
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await page.getByLabel("Add an attachment").setInputFiles({
    name: "post.png",
    mimeType: "image/png",
    buffer: imageBytes,
  });
  await expect(page.getByText("post.png attached.")).toBeVisible({
    timeout: 70_000,
  });
  await page
    .getByLabel("Record data source")
    .selectOption({ label: "Suppliers" });
  await page.getByLabel("Record to link").selectOption(supplier.recordId);
  const [postLink] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/boards/${boardId}/posts/${postId}/record-links` &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Link Record" }).click(),
  ]);
  expect(postLink.status()).toBe(201);
  const [published] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/boards/${boardId}/posts/${postId}/publish` &&
        response.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Publish now" }).click(),
  ]);
  expect(published.status()).toBe(200);
  await expect(page.getByText("Published successfully.")).toBeVisible();
  await page.getByRole("button", { name: "Close post editor" }).click();
  await expect(page.getByRole("dialog", { name: "Post editor" })).toBeHidden();
  const publishedPost = page
    .getByRole("region", { name: "Published posts" })
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: postTitle,
        exact: true,
      }),
    });
  await publishedPost.getByRole("button", { name: "Open post" }).click();
  const postReader = page.getByRole("dialog", {
    name: postTitle,
  });
  await expect(postReader).toBeVisible();
  const postRecordLink = postReader.getByRole("link", {
    name: recordLinkTitle,
    exact: true,
  });
  await expect(postRecordLink).toBeVisible();
  await expect(postRecordLink).toHaveAttribute("href", recordLinkTarget);
  await postReader.getByRole("button", { name: "Close post" }).click();

  const secondPostTitle = `Supplier notice ${runId.slice(0, 8)}`;
  const postManager = page.getByRole("region", {
    name: "Manage posts",
  });
  await page.getByRole("button", { name: "New post", exact: true }).click();
  await postManager.getByLabel("Title", { exact: true }).fill(secondPostTitle);
  await postManager.getByLabel("Message").fill("Supplier terms changed.");
  const [secondPostCreated] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/boards/${boardId}/posts` &&
        response.request().method() === "POST",
    ),
    postManager.getByRole("button", { name: "Save draft" }).click(),
  ]);
  expect(secondPostCreated.status()).toBe(201);
  const secondPostId = ((await secondPostCreated.json()) as { id: string }).id;
  const [secondPostPublished] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/boards/${boardId}/posts/${secondPostId}/publish` &&
        response.request().method() === "POST",
    ),
    postManager.getByRole("button", { name: "Publish now" }).click(),
  ]);
  expect(secondPostPublished.status()).toBe(200);
  await page.reload();
  await page.getByRole("link", { name: "Posts", exact: true }).click();
  await page.getByRole("button", { name: "More post actions" }).click();
  await page
    .getByRole("menuitem", { name: "Edit drafts", exact: true })
    .click();
  const reloadedPostManager = page.getByRole("region", {
    name: "Manage posts",
  });
  await reloadedPostManager
    .getByRole("button", { name: `${secondPostTitle} · Published` })
    .click();
  await expect(
    reloadedPostManager.getByRole("heading", { name: "Edit post" }),
  ).toBeVisible();
  await reloadedPostManager
    .getByLabel("Title", { exact: true })
    .fill(`${secondPostTitle} revised`);
  const [secondPostUpdated] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/boards/${boardId}/posts/${secondPostId}` &&
        response.request().method() === "PATCH",
    ),
    reloadedPostManager.getByRole("button", { name: "Save draft" }).click(),
  ]);
  expect(secondPostUpdated.status()).toBe(200);
  await expect(
    reloadedPostManager.getByLabel("Title", { exact: true }),
  ).toHaveValue(`${secondPostTitle} revised`);

  await page.goto("/platform#notifications");
  await expect(
    page.getByRole("heading", { name: "Connected notifications" }),
  ).toBeVisible();
  const notices = page.getByRole("list", {
    name: "Connected delivery notices",
  });
  await expect(notices.getByText("Board post", { exact: true })).toBeVisible();
}

type DashboardSnapshotBody = Readonly<{
  module_id?: string;
  mode?: string;
  dimension?: Readonly<{ field_id?: string; expected_type?: string }>;
}>;

function waitForDashboardSnapshot(page: Page) {
  const seenRequests: string[] = [];
  const seenResponses: number[] = [];
  const isSnapshotRequest = (request: Request) =>
    new URL(request.url()).pathname === "/api/records/aggregate-snapshot" &&
    request.method() === "POST";
  const onRequest = (request: Request) => {
    if (!isSnapshotRequest(request)) return;
    try {
      const body = request.postDataJSON() as DashboardSnapshotBody;
      seenRequests.push(
        `${body.mode ?? "unknown"}:${body.module_id ?? "missing"}`,
      );
    } catch {
      seenRequests.push("invalid-json");
    }
  };
  let onResponse: ((response: Response) => void) | undefined;
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  const observedResponse = new Promise<Response>((resolve, reject) => {
    onResponse = (response) => {
      if (!isSnapshotRequest(response.request())) return;
      seenResponses.push(response.status());
      resolve(response);
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    diagnosticTimer = setTimeout(
      () =>
        reject(
          new Error(
            `Dashboard snapshot not observed: requests=${JSON.stringify(seenRequests)}, responses=${JSON.stringify(seenResponses)}`,
          ),
        ),
      15_000,
    );
  });
  return observedResponse.finally(() => {
    if (diagnosticTimer) clearTimeout(diagnosticTimer);
    page.off("request", onRequest);
    if (onResponse) page.off("response", onResponse);
  });
}

async function expectPopulatedDashboardSnapshot(
  response: Response,
  moduleId: string,
  dimensionId: string,
  optionId: string,
) {
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON() as DashboardSnapshotBody;
  expect(body).toMatchObject({
    module_id: moduleId,
    mode: "groups",
    dimension: { field_id: dimensionId, expected_type: "select" },
  });
  const result = (await response.json()) as {
    items: ReadonlyArray<
      Readonly<{
        key: string | null;
        label: string;
        value: number | string;
        record_count: number;
      }>
    >;
    pagination: Readonly<{
      count: number;
      total: number;
      offset: number;
      has_more: boolean;
    }>;
  };
  expect(result.items).toEqual([
    { key: optionId, label: "Net 30", value: 1, record_count: 1 },
  ]);
  expect(result.pagination).toMatchObject({
    count: 1,
    total: 1,
    offset: 0,
    has_more: false,
  });
}

async function exercisePrivateDashboard(
  page: Page,
  runId: string,
  supplier: SeededSupplier,
) {
  const dashboardName = `Full-stack Dashboard ${runId.slice(0, 8)}`;
  await page.goto("/openview?section=dashboards");
  await expect(
    page.getByRole("heading", { level: 1, name: "Dashboards" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Each Dashboard belongs to a department/),
  ).toBeVisible();

  await page.getByRole("button", { name: "New Dashboard" }).click();
  const newDashboard = page.getByRole("dialog", { name: "New Dashboard" });
  const dashboardDepartment = newDashboard.getByLabel("Department", {
    exact: true,
  });
  await dashboardDepartment.selectOption(supplier.departmentId);
  await expect(dashboardDepartment).toHaveValue(supplier.departmentId);
  await newDashboard.getByLabel("Dashboard name").fill(dashboardName);
  await newDashboard.getByRole("button", { name: "Continue" }).click();
  await expect(newDashboard).toBeHidden();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  const addWidget = page.getByRole("dialog", { name: "Add widget" });
  const moduleSelect = addWidget.getByLabel("Data source");
  await moduleSelect.selectOption({ label: "Suppliers" });
  const moduleId = await moduleSelect.inputValue();
  expect(moduleId).toBe(supplier.moduleId);
  const dimension = addWidget.getByLabel("Group records by");
  await dimension.selectOption({ label: "Payment terms" });
  const dimensionId = await dimension.inputValue();
  expect(dimensionId).toBe(supplier.paymentTermsFieldId);
  await addWidget
    .getByRole("button", { name: "Add widget", exact: true })
    .click();
  await expect(addWidget).toBeHidden();
  await expect(
    page.getByRole("button", { name: /^View chart 1:/i }),
  ).toBeVisible();

  const snapshotPromise = waitForDashboardSnapshot(page);
  await page.getByRole("button", { name: "Save Dashboard" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Dashboard saved." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^View chart 1:/i }),
  ).toBeVisible();
  await expectPopulatedDashboardSnapshot(
    await snapshotPromise,
    moduleId,
    dimensionId,
    supplier.paymentTermsOptionId,
  );

  await expect(page).toHaveURL(
    new RegExp(
      `/openview\\?section=dashboards&dashboard=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`,
      "i",
    ),
  );
  const dashboardUrl = new URL(page.url());
  expect(dashboardUrl.pathname).toBe("/openview");
  expect(dashboardUrl.searchParams.get("section")).toBe("dashboards");
  const dashboardId = dashboardUrl.searchParams.get("dashboard");
  expect(dashboardId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  if (!dashboardId)
    throw new Error("saved Dashboard URL did not include its ID");
  await expect(
    page.getByRole("combobox", { name: "Dashboard", exact: true }),
  ).toHaveValue(dashboardId);
  await expect(
    page.getByRole("heading", { name: dashboardName, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^View chart 1:/i }),
  ).toBeVisible();
  const table = page.getByRole("table", { name: /^Complete data for / });
  await expect(table).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Group" }),
  ).toBeVisible();
  const net30Row = table.getByRole("row").filter({ hasText: "Net 30" });
  await expect(net30Row.getByRole("cell")).toHaveText(["Net 30", "1", "1"]);
  await expect(table.getByRole("caption")).toContainText(
    "Complete results for the current Dashboard widget.",
  );

  const reloadSnapshotPromise = waitForDashboardSnapshot(page);
  await page.reload();
  await expect(page).toHaveURL(
    new RegExp(`[?&]dashboard=${dashboardId}(?:&|$)`),
  );
  await expect(
    page.getByRole("combobox", { name: "Dashboard", exact: true }),
  ).toHaveValue(dashboardId);
  await expect(
    page.getByRole("heading", { name: dashboardName, exact: true }),
  ).toBeVisible();
  await expectPopulatedDashboardSnapshot(
    await reloadSnapshotPromise,
    moduleId,
    dimensionId,
    supplier.paymentTermsOptionId,
  );
  await expect(net30Row.getByRole("cell")).toHaveText(["Net 30", "1", "1"]);

  await page.getByRole("button", { name: "Dashboard options" }).click();
  await page.getByRole("menuitem", { name: "Archive Dashboard" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Dashboard archived." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show archived" }).click();
  await page.getByRole("button", { name: `Restore ${dashboardName}` }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Dashboard restored." }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`[?&]dashboard=${dashboardId}(?:&|$)`),
  );
  await expect(
    page.getByRole("combobox", { name: "Dashboard", exact: true }),
  ).toHaveValue(dashboardId);
  await expect(
    page.getByRole("heading", { name: dashboardName, exact: true }),
  ).toBeVisible();
}

type WindowQueryBody = Readonly<{
  module_id: string;
  mode: "calendar" | "timeline";
  scope: string;
  from_date: string;
  to_date: string;
  date_field?: Readonly<{ field_id: string; expected_type: string }>;
  start_field?: Readonly<{ field_id: string; expected_type: string }>;
  end_field?: Readonly<{ field_id: string; expected_type: string }>;
}>;

function waitForWindowQuery(
  page: Page,
  mode: WindowQueryBody["mode"],
  window: Readonly<{ fromDate: string; toDate: string }>,
) {
  const seenRequests: string[] = [];
  const isWindowRequest = (request: Request) =>
    new URL(request.url()).pathname === "/api/records/window-query" &&
    request.method() === "POST";
  const onRequest = (request: Request) => {
    if (!isWindowRequest(request) || seenRequests.length >= 10) return;
    try {
      const body = request.postDataJSON() as Partial<WindowQueryBody>;
      seenRequests.push(
        `${body.mode ?? "unknown"}:${body.scope ?? "missing"}:${body.module_id ?? "missing"}:${body.from_date ?? "missing"}:${body.to_date ?? "missing"}`,
      );
    } catch {
      seenRequests.push("invalid-json");
    }
  };
  let onResponse: ((response: Response) => void) | undefined;
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  const observedResponse = new Promise<Response>((resolve, reject) => {
    onResponse = (response) => {
      if (!isWindowRequest(response.request())) return;
      let body: Partial<WindowQueryBody>;
      try {
        body = response.request().postDataJSON() as Partial<WindowQueryBody>;
      } catch {
        return;
      }
      if (
        body.mode === mode &&
        body.scope === "window" &&
        body.from_date === window.fromDate &&
        body.to_date === window.toDate
      )
        resolve(response);
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    diagnosticTimer = setTimeout(
      () =>
        reject(
          new Error(
            `Window response not observed: requests=${JSON.stringify(seenRequests)}`,
          ),
        ),
      15_000,
    );
  });
  return observedResponse.finally(() => {
    if (diagnosticTimer) clearTimeout(diagnosticTimer);
    page.off("request", onRequest);
    if (onResponse) page.off("response", onResponse);
  });
}

function nextWindowDates(start: string, end: string) {
  const dayMilliseconds = 24 * 60 * 60 * 1000;
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  const days = (endTime - startTime) / dayMilliseconds + 1;
  return {
    fromDate: new Date(startTime + days * dayMilliseconds)
      .toISOString()
      .slice(0, 10),
    toDate: new Date(endTime + days * dayMilliseconds)
      .toISOString()
      .slice(0, 10),
  };
}

function expectBoundedWindow(body: WindowQueryBody) {
  expect(body.from_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(body.to_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const dayMilliseconds = 24 * 60 * 60 * 1000;
  const days =
    (Date.parse(`${body.to_date}T00:00:00.000Z`) -
      Date.parse(`${body.from_date}T00:00:00.000Z`)) /
      dayMilliseconds +
    1;
  expect(days).toBeGreaterThanOrEqual(1);
  expect(days).toBeLessThanOrEqual(366);
}

async function expectEmptyWindowResponse(response: Response) {
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.items).toEqual([]);
  expect(result.pagination).toMatchObject({
    count: 0,
    total: 0,
    offset: 0,
    has_more: false,
  });
}

async function exerciseLiveCalendarAndTimeline(page: Page) {
  await page.goto("/openview?section=views");
  const dataSource = page.getByLabel("Data source");
  await expect(dataSource).toBeVisible();
  await expect(page).toHaveURL(/[?&]module=[0-9a-f-]{36}(?:&|$)/i);
  const [moduleId] = await dataSource.selectOption({
    label: "Purchase orders",
  });
  if (!moduleId) throw new Error("Purchase orders has no module ID");
  await expect(
    page.getByRole("searchbox", {
      name: "Search Purchase orders",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]module=${moduleId}(?:&|$)`));
  await expect(dataSource).toHaveValue(moduleId);

  await page.getByRole("button", { name: "Layout settings" }).click();
  const layoutSettings = page.getByRole("dialog", { name: "Layout settings" });
  await layoutSettings
    .getByLabel("Presentation layout")
    .selectOption("calendar");
  const calendarField = layoutSettings.getByLabel("Calendar date field");
  await expect(calendarField).toBeVisible();
  const calendarFieldId = await calendarField
    .locator("option", { hasText: "Order date · date" })
    .getAttribute("value");
  if (!calendarFieldId) throw new Error("Calendar date option has no field ID");
  await calendarField.selectOption(calendarFieldId);
  await layoutSettings
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(layoutSettings).toBeHidden();
  const calendar = page.getByRole("region", {
    name: "Calendar",
    exact: true,
  });
  await expect(
    calendar.getByRole("heading", { name: "Calendar · Order date" }),
  ).toBeVisible();
  await expect(
    calendar
      .getByRole("status")
      .filter({ hasText: "No scheduled records in this date window." }),
  ).toBeVisible();
  const calendarWindow = nextWindowDates(
    await calendar.getByLabel("Window starts").inputValue(),
    await calendar.getByLabel("Window ends").inputValue(),
  );
  await expect(dataSource).toHaveValue(moduleId);
  const calendarResponsePromise = waitForWindowQuery(
    page,
    "calendar",
    calendarWindow,
  );
  await calendar
    .getByRole("button", { name: "Next window", exact: true })
    .click();
  const calendarResponse = await calendarResponsePromise;
  const calendarBody = calendarResponse
    .request()
    .postDataJSON() as WindowQueryBody;
  expect(calendarBody).toMatchObject({
    module_id: moduleId,
    mode: "calendar",
    scope: "window",
    from_date: calendarWindow.fromDate,
    to_date: calendarWindow.toDate,
    date_field: {
      field_id: calendarFieldId,
      expected_type: "date",
    },
  });
  expectBoundedWindow(calendarBody);
  await expectEmptyWindowResponse(calendarResponse);

  await expect(calendar.getByLabel("Window starts")).toHaveValue(
    calendarBody.from_date,
  );
  await expect(calendar.getByLabel("Window ends")).toHaveValue(
    calendarBody.to_date,
  );
  await expect(
    calendar
      .getByRole("status")
      .filter({ hasText: "No scheduled records in this date window." }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Layout settings" }).click();
  await layoutSettings
    .getByLabel("Presentation layout")
    .selectOption("timeline");
  const timelineStart = layoutSettings.getByLabel("Timeline start field");
  const timelineEnd = layoutSettings.getByLabel("Timeline end field");
  await expect(timelineStart).toBeVisible();
  const timelineStartFieldId = await timelineStart
    .locator("option", { hasText: "Order date · date" })
    .getAttribute("value");
  if (!timelineStartFieldId)
    throw new Error("Timeline start option has no field ID");
  await timelineStart.selectOption(timelineStartFieldId);
  await expect(timelineEnd).toBeVisible();
  const timelineEndFieldId = await timelineEnd
    .locator("option", { hasText: "Expected delivery · date" })
    .getAttribute("value");
  if (!timelineEndFieldId)
    throw new Error("Timeline end option has no field ID");
  await timelineEnd.selectOption(timelineEndFieldId);
  await layoutSettings
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(layoutSettings).toBeHidden();
  const timeline = page.getByRole("region", { name: "Timeline records" });
  await expect(
    timeline.getByRole("heading", {
      name: "Timeline · Order date through Expected delivery",
    }),
  ).toBeVisible();
  await expect(
    timeline.getByText("No scheduled intervals in this window"),
  ).toBeVisible();
  const timelineWindow = nextWindowDates(
    await timeline.getByLabel("Window starts").inputValue(),
    await timeline.getByLabel("Window ends").inputValue(),
  );
  await expect(dataSource).toHaveValue(moduleId);
  const timelineResponsePromise = waitForWindowQuery(
    page,
    "timeline",
    timelineWindow,
  );
  await timeline
    .getByRole("button", { name: "Next window", exact: true })
    .click();
  const timelineResponse = await timelineResponsePromise;
  const timelineBody = timelineResponse
    .request()
    .postDataJSON() as WindowQueryBody;
  expect(timelineBody).toMatchObject({
    module_id: moduleId,
    mode: "timeline",
    scope: "window",
    from_date: timelineWindow.fromDate,
    to_date: timelineWindow.toDate,
    start_field: {
      field_id: timelineStartFieldId,
      expected_type: "date",
    },
    end_field: {
      field_id: timelineEndFieldId,
      expected_type: "date",
    },
  });
  expectBoundedWindow(timelineBody);
  await expectEmptyWindowResponse(timelineResponse);

  await expect(timeline.getByLabel("Window starts")).toHaveValue(
    timelineBody.from_date,
  );
  await expect(timeline.getByLabel("Window ends")).toHaveValue(
    timelineBody.to_date,
  );
  await expect(
    timeline.getByText("No scheduled intervals in this window"),
  ).toBeVisible();
}

test("Sandbox exposes the simplified Build, Triggers, Test, and History journey", async ({
  page,
}) => {
  test.setTimeout(360_000);
  page.setDefaultTimeout(30_000);
  const runFixture = fixture();
  const credentials = runFixture.admin;
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(openview|sandbox)$/);
  await page.goto("/sandbox?section=designer");

  await expect(
    page.getByRole("heading", { name: "Sandbox", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review & Publish" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Build", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Triggers", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Test", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "History", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Create release snapshot")).toHaveCount(0);
  await expect(page.getByText("Simulation", { exact: true })).toHaveCount(0);

  await applyTemplate(page, "Inventory & procurement");
  const publishedSequence = await publishDraft(page, credentials.password);
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  const supplier = await seedPublishedSupplier(page, runFixture.runId);
  await exercisePrivateDashboard(page, runFixture.runId, supplier);
  await exerciseOpenView(page, runFixture.runId, supplier);
  await exerciseLiveCalendarAndTimeline(page);
  await exerciseLiveCharts(page, supplier);
  await exerciseConnectedReports(page, runFixture.runId, supplier);
  await exerciseConnectedBoard(page, runFixture.runId, supplier);
  await retireSeededSupplier(page, supplier.recordId);
  await page.goto("/sandbox?section=designer");

  await page.getByRole("link", { name: "Triggers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Recent activity" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Recent activity", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Recent activity details" })
      .getByText("No published trigger activity yet."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Test", exact: true }).click();
  const testSetup = page.getByRole("region", {
    name: "Test setup",
    exact: true,
  });
  await expect(
    testSetup.getByRole("heading", { name: "Test setup" }),
  ).toBeVisible();
  await testSetup
    .getByLabel("Module", { exact: true })
    .selectOption({ label: "Suppliers" });
  await testSetup
    .getByRole("button", { name: "All input fields", exact: true })
    .click();
  await testSetup.getByLabel("Supplier ID", { exact: true }).fill("SUP-001");
  await testSetup
    .getByLabel("Status", { exact: true })
    .selectOption({ label: "Active" });
  await testSetup
    .getByLabel("Legal name", { exact: true })
    .fill("Acceptance Supplier");
  await testSetup
    .getByLabel("When", { exact: true })
    .selectOption("field-changed");
  await testSetup
    .getByLabel("Changed field", { exact: true })
    .selectOption({ label: "Status" });
  const recordsUrl = "/api/records?limit=100&offset=0";
  const beforeRecords = await page.request.get(recordsUrl);
  expect(beforeRecords.status()).toBe(200);
  const beforeRecordState: unknown = await beforeRecords.json();
  expect(beforeRecordState).toMatchObject({ pagination: { has_more: false } });
  const [testResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sandbox/tests" &&
        response.request().method() === "POST",
    ),
    testSetup.getByRole("button", { name: "Run test" }).click(),
  ]);
  expect(testResponse.status()).toBe(201);
  await expect(
    page.getByRole("heading", { name: "Test result" }),
  ).toBeVisible();
  const afterRecords = await page.request.get(recordsUrl);
  expect(afterRecords.status()).toBe(200);
  expect(await afterRecords.json()).toEqual(beforeRecordState);

  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  // Other specs in the same run also publish; History then adds the version number
  // to every "Published structure" label, so select this test's own version.
  await page
    .getByRole("button", {
      name: new RegExp(
        `^View Published structure(, version ${publishedSequence})?$`,
      ),
    })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Selected version", exact: true })
      .getByRole("heading", { name: "Published structure", exact: true }),
  ).toBeVisible();

  for (const name of [
    "Finance, accounting & sales",
    "Retail & commerce",
    "Professional services",
    "Field service & maintenance",
    "Light manufacturing",
  ]) {
    await page.getByRole("link", { name: "Build", exact: true }).click();
    await applyTemplate(page, name);
    await publishDraft(page, credentials.password);
  }
});
