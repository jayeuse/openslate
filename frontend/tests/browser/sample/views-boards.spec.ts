import { expect, test, type Page } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: { detail: "Synthetic session" } }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route)))
      await route.fulfill({ json: { items: [], has_more: false } });
  });
});

async function openViewOptions(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    const button = page.getByRole("button", {
      name: "View options",
      exact: true,
    });
    if ((await button.getAttribute("aria-expanded")) !== "true")
      await button.click();
  }
}

test("sample views retain saved filters and provide honest export previews", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (/\/bff\/|\/session\//.test(request.url()) && request.method() !== "GET")
      mutations.push(request.url());
  });
  await page.goto("/openview");
  await page.getByLabel("Search requests").fill("pump");
  await expect(
    page.getByText("1 matching record", { exact: true }),
  ).toBeVisible();
  await openViewOptions(page);
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page.getByLabel("View name").fill("Pump work");
  await page.getByRole("button", { name: "Save current view" }).click();
  await page.reload();
  await openViewOptions(page);
  await page.getByLabel("Saved view").selectOption({ label: "Pump work" });
  await expect(page.getByLabel("Search requests")).toHaveValue("pump");
  await page.getByRole("button", { name: "Charts", exact: true }).click();
  await page.getByRole("button", { name: "Preview image export" }).click();
  await expect(
    page.getByText("Image export preview — no file was downloaded."),
  ).toBeVisible();
  expect(mutations).toEqual([]);
});

test("sample boards create and edit linked recurring events and embedded views", async ({
  page,
}) => {
  await page.goto("/boards");
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "New event" }).click();
  await page.getByLabel("Event title").fill("Pump inspection");
  await page.getByLabel("Event date").fill("2026-09-18");
  await page.getByLabel("Recurrence").selectOption("Weekly");
  await page.getByLabel("Linked record").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(
    page.getByRole("heading", { name: "Pump inspection" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remind Pump inspection" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Sample reminder recorded",
  );
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  await page.getByLabel("Widget type").selectOption("OpenView");
  await page.getByRole("button", { name: "Add to board" }).click();
  await expect(
    page.getByRole("heading", { name: "OpenView · Service requests" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "OpenView · Service requests" }),
  ).toBeVisible();
});

test("organization record pins stay off department boards", async ({
  page,
}) => {
  await page.goto("/platform");
  await page
    .getByRole("button", { name: "Record actions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add record to Board", exact: true })
    .click();
  await page.goto("/boards");
  const pins = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Records added to this board",
      exact: true,
    }),
  });
  await expect(pins).toContainText("Replace pump seal");
  await page
    .getByRole("button", { name: "Create department board", exact: true })
    .click();
  await page.getByLabel("Board name", { exact: true }).fill("Finance review");
  await page.getByRole("button", { name: "Create board", exact: true }).click();
  await expect(pins).toHaveCount(0);
  await page.reload();
  await expect(pins).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Current board", exact: true })
    .selectOption("sample-board-organization");
  await expect(pins).toContainText("Replace pump seal");
});

test("record links open the inspector from a persisted analytics tab", async ({
  page,
}) => {
  await page.goto("/openview");
  await page.getByRole("button", { name: "Charts", exact: true }).click();
  await page.goto("/openview?record=sample-sr-1004");
  await expect(
    page.getByRole("complementary", { name: "Request detail" }),
  ).toContainText("Replace pump seal");
});

test("a default view is restored on entry and a new request opens its detail", async ({
  page,
}) => {
  await page.goto("/openview");
  await openViewOptions(page);
  await page.getByRole("button", { name: "Kanban", exact: true }).click();
  await openViewOptions(page);
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page.getByLabel("View name").fill("Dispatch default");
  await page.getByRole("button", { name: "Save current view" }).click();
  await page.getByRole("button", { name: "Set as module default" }).click();
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Gallery", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openViewOptions(page);
  await expect(
    page.getByRole("button", { name: "Kanban", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "New record", exact: true }).click();
  await page.getByLabel("Request title").fill("Service generator");
  await page.getByLabel("Request customer").fill("Riverbank Factory");
  await page.getByLabel("Request due date").fill("2026-10-01");
  await page.getByRole("button", { name: "Create sample record" }).click();
  await expect(
    page.getByRole("complementary", { name: "Request detail" }),
  ).toContainText("Service generator");
});

test("all six views show the same requests and mobile opens with a usable list", async ({
  page,
}) => {
  await page.goto("/openview");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  const mobile = (page.viewportSize()?.width ?? 1440) < 768;
  if (mobile) {
    const first = page.getByRole("button", { name: /Calibrate flow sensor/ });
    await expect(first).toBeVisible();
    const bounds = await first.boundingBox();
    expect(bounds?.y).toBeLessThan(500);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await openViewOptions(page);
  for (const type of [
    "Grid",
    "Calendar",
    "Kanban",
    "Timeline",
    "Gallery",
    "Table",
  ]) {
    await page.getByRole("button", { name: type, exact: true }).click();
    await expect(
      page.getByRole("button", { name: type, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: /Replace pump seal/ }).first(),
    ).toBeVisible();
  }
  await page.getByLabel("Status filter").selectOption("Open");
  await expect(
    page.getByText("3 matching records", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove filters", exact: true })
    .click();
  await expect(
    page.getByText("8 matching records", { exact: true }),
  ).toBeVisible();
});

test("dashboard layout changes persist and report previews validate their fields", async ({
  page,
}) => {
  await page.goto("/openview");
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await page
    .getByRole("button", { name: "Create dashboard", exact: true })
    .click();
  await page.getByLabel("Dashboard name").fill("Dispatch room");
  await page
    .getByRole("button", { name: "Save dashboard", exact: true })
    .click();
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  await page.getByLabel("Widget type").selectOption("Summary");
  await page
    .getByRole("button", { name: "Add to dashboard", exact: true })
    .click();
  const summary = page.getByRole("region", { name: "Summary widget" });
  await summary.getByText("Layout & access", { exact: true }).click();
  await page.getByLabel("Summary width").selectOption("Full");
  await page.getByLabel("Dashboard refresh").selectOption("Every 5 minutes");
  await page.reload();
  await summary.getByText("Layout & access", { exact: true }).click();
  await expect(page.getByLabel("Summary width")).toHaveValue("Full");
  await expect(page.getByLabel("Dashboard refresh")).toHaveValue(
    "Every 5 minutes",
  );
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  for (const field of ["Request", "Status", "Assignee"])
    await page.getByRole("checkbox", { name: field, exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Save report template", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "select at least one field",
  );
  await page.getByRole("checkbox", { name: "Request", exact: true }).check();
  await page
    .getByLabel("Generation schedule")
    .selectOption("Weekly on Monday at 09:00");
  await page
    .getByRole("button", { name: "Save report template", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "No report delivery is scheduled",
  );
  await page.getByLabel("Export format").selectOption("CSV");
  await page
    .getByRole("button", { name: "Preview export", exact: true })
    .click();
  await expect(
    page.getByText("CSV export preview — no file was downloaded.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("charts reject reversed dates and announcements support edit pin and delete", async ({
  page,
}) => {
  await page.goto("/openview");
  await page.getByRole("button", { name: "Charts", exact: true }).click();
  await page.getByLabel("From date").fill("2026-10-01");
  await page.getByLabel("To date").fill("2026-09-01");
  await expect(
    page.getByRole("alert").filter({ hasText: "End date must be" }),
  ).toContainText("End date must be on or after start date");
  await expect(
    page.getByRole("button", { name: "Preview image export" }),
  ).toBeDisabled();
  await page.getByLabel("From date").fill("");
  await page.getByLabel("To date").fill("");
  await page.getByLabel("Aggregation", { exact: true }).selectOption("Sum");
  await expect(
    page.getByRole("heading", { name: "Sum by status" }),
  ).toBeVisible();
  await page.getByLabel("Chart type").selectOption("Pie");
  await expect(
    page.getByRole("img", { name: "Pie chart of estimated hours by status" }),
  ).toBeVisible();
  await page.goto("/boards");
  await page
    .getByRole("button", { name: "Announcements", exact: true })
    .click();
  await page
    .getByRole("button", { name: "New announcement", exact: true })
    .click();
  await page.getByLabel("Announcement title").fill("Service window");
  await page
    .getByLabel("Announcement message")
    .fill("Brief planned maintenance at 09:00.");
  await page.getByLabel("Expiration date").fill("2026-10-01");
  await page
    .getByRole("button", { name: "Save announcement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit Service window", exact: true })
    .click();
  await page.getByLabel("Announcement title").fill("Service window moved");
  await page
    .getByRole("button", { name: "Save announcement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Pin Service window moved", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Unpin Service window moved",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete Service window moved", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm delete announcement", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Service window moved", exact: true }),
  ).toHaveCount(0);
});

test("incompatible saved entries and empty dashboard storage recover without a crash", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "views-saved": [null],
        "views-dashboards": [],
        "views-report-templates": [null],
        "boards-list": [],
      }),
    );
  });
  await page.goto("/openview");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dashboards", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create dashboard", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save report template", exact: true }),
  ).toBeVisible();
  await page.goto("/boards");
  await expect(
    page.getByRole("heading", { name: "Organization board", exact: true }),
  ).toBeVisible();
});
