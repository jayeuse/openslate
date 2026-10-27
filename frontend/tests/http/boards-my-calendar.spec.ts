import { expect, test, type Page } from "./helpers/test";
import { installOpenViewEventSource } from "./helpers/openview-event-source";
import {
  fleetBoardId,
  forkliftEventId,
  installMyCalendarApi,
  inventoryBoardId,
  myCalendarHref,
  ordersModuleId,
  ordersSourceId,
  reviewEventId,
  salesBoardId,
  salesDepartmentId,
  townHallEventId,
} from "./helpers/my-calendar-api";

// docs/specs/boards-relayout.md P3b: My calendar across every board the
// person reads (BR22, BR35, BR52, BR53, BR57, BR58).

test.use({ trace: "off", screenshot: "off", video: "off" });

const sidebar = (page: Page) =>
  page.getByRole("navigation", { name: "Main navigation" });
const crumbs = (page: Page) =>
  page.getByRole("navigation", { name: "breadcrumb" });

function documentScrolls(page: Page) {
  return page.evaluate(() => ({
    down: document.documentElement.scrollHeight > window.innerHeight + 1,
    across: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
}

test("My calendar opens first in the Boards group and shows every board's events in one read", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installOpenViewEventSource(page);
  const api = await installMyCalendarApi(page);
  await page.goto("/boards?section=all");
  const rows = sidebar(page).getByRole("list", { name: "Boards" });
  await expect(rows.getByRole("link").first()).toHaveText("My calendar");
  await rows.getByRole("link", { name: "My calendar" }).click();
  await expect(page).toHaveURL(/\/boards\?section=my-calendar$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "My calendar" }),
  ).toBeVisible();
  await expect(crumbs(page)).toHaveText(/^Boards\s*My calendar$/);
  await expect(page.getByText("4 boards", { exact: true })).toBeVisible();
  await expect(rows.getByRole("link", { name: "My calendar" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // No board level and no board tabs: My calendar is no board.
  await expect(page.getByRole("navigation", { name: /views$/ })).toHaveCount(0);
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  for (const name of [
    "Q4 town hall, Company, Fri, Nov 13, 4pm",
    "Customer account review, Sales, Mon, Nov 16, 9am",
    "Forklift breakdown review, Fleet Reliability, Wed, Nov 18, 11am",
  ])
    await expect(
      month.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  // One read covers every board for the window, not one read per board.
  expect(api.occurrenceReads).toEqual([
    "?window_start=2026-11-01&window_end=2026-11-30&limit=100&offset=0",
  ]);
  const rail = page.getByRole("complementary", { name: "Calendars" });
  for (const name of [
    "Company",
    "Sales",
    "Inventory",
    "Fleet Reliability",
    "My cards · Due",
    "Sales Orders · Promised delivery",
  ])
    await expect(
      rail.getByRole("checkbox", { name, exact: true }),
    ).toBeChecked();
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });

  // A board's event change refreshes My calendar from the same stream.
  await page.evaluate(
    (boardId) =>
      (
        window as unknown as {
          __sendOpenViewEvent: (type: string, data: string) => void;
        }
      ).__sendOpenViewEvent(
        "invalidate",
        JSON.stringify({ entity: "board_events", board_id: boardId }),
      ),
    salesBoardId,
  );
  await expect.poll(() => api.occurrenceReads.length).toBe(2);

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(rail).toHaveCount(0);
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
  // Phones open on P3a's day list for today; nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Nov 16 – Nov 22", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Selected day" })
      .getByRole("button", { name: /^Forklift breakdown review,/ }),
  ).toContainText("Fleet Reliability");
  expect((await documentScrolls(page)).across).toBe(false);
});

test("a board whose events cannot be read shows not loaded in its row while the others show", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installMyCalendarApi(page, {
    statuses: {
      [inventoryBoardId]: "unavailable",
      [fleetBoardId]: "occurrence_limit",
    },
    statusReads: 1,
  });
  await page.goto(myCalendarHref());
  const rail = page.getByRole("complementary", { name: "Calendars" });
  const inventory = rail.getByRole("listitem").filter({ hasText: "Inventory" });
  await expect(inventory.getByRole("alert")).toContainText("not loaded ·");
  await expect(
    rail.getByRole("listitem").filter({ hasText: "Fleet Reliability" }),
  ).toContainText("Too many events to show");
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  await expect(
    month.getByRole("button", {
      name: "Customer account review, Sales, Mon, Nov 16, 9am",
      exact: true,
    }),
  ).toBeVisible();
  await expect(month.getByText("Quarterly cycle count")).toHaveCount(0);
  // Below 1440 the Calendars button carries the failure.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(
    page.getByRole("button", { name: "Calendars, 1 not loaded" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await inventory.getByRole("button", { name: "Retry Inventory" }).click();
  await expect(
    month.getByRole("button", {
      name: "Quarterly cycle count, Inventory, Thu, Nov 19, 8am",
      exact: true,
    }),
  ).toBeVisible();
  await expect(inventory.getByRole("alert")).toHaveCount(0);
  expect(api.occurrenceReads).toHaveLength(2);
});

test("My calendar shows only the record sources the server returns, and removes one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installMyCalendarApi(page);
  await page.goto(myCalendarHref());
  const rail = page.getByRole("complementary", { name: "Calendars" });
  const sources = rail.getByRole("list", { name: "My record sources" });
  await expect(sources.getByRole("checkbox")).toHaveCount(1);
  await expect(
    sources.getByRole("checkbox", { name: "Sales Orders · Promised delivery" }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", {
      name: "SO-31057 Cebu Coldchain, Sales Orders · Promised delivery, Tue, Nov 24, all day",
      exact: true,
    }),
  ).toBeVisible();
  // Only the returned source's module is read; nothing else is asked.
  expect(api.recordReads.map((body) => body.module_id)).toEqual([
    ordersModuleId,
  ]);
  await rail
    .getByRole("button", {
      name: "Record source actions, Sales Orders · Promised delivery",
    })
    .click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Hide",
    "Open records without a date",
    "Remove",
  ]);
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove source" })
    .click();
  await expect
    .poll(() => api.sourceDeletes)
    .toEqual([`/api/me/calendar-sources/${ordersSourceId}`]);
  await expect(sources.getByRole("checkbox")).toHaveCount(0);
  await expect(
    rail.getByRole("button", { name: "Add record source" }),
  ).toBeVisible();
});

test("My cards · Due shows the person's cards in their boards' names and opens a card's summary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installMyCalendarApi(page);
  await page.goto(myCalendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  await expect(
    month.getByRole("button", {
      name: "Due: No access to this record, Fleet Reliability, Fri, Nov 20, due",
      exact: true,
    }),
  ).toBeVisible();
  await month
    .getByRole("button", {
      name: "Due: Update the Q4 price list, Sales, Fri, Nov 20, due",
      exact: true,
    })
    .click();
  const summary = page.getByRole("dialog", {
    name: "Update the Q4 price list",
  });
  await expect(summary.getByText("Sales")).toBeVisible();
  await expect(summary.getByText("Doing")).toBeVisible();
  expect(api.dueReads).toEqual([
    "?from=2026-11-01&to=2026-11-30&limit=100&offset=0",
  ]);
});

test("New event from My calendar starts with the Board field and names who sees the event", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installMyCalendarApi(page, {
    levels: { sales: "write", fleet: "manage" },
  });
  await page.goto(myCalendarHref());
  await page.getByRole("button", { name: "New event" }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  const board = editor.getByLabel("Board", { exact: true });
  await expect(board).toBeFocused();
  // Only the boards the person posts on.
  await expect(board.getByRole("option")).toHaveText([
    "Sales",
    "Fleet Reliability",
  ]);
  await expect(
    editor.getByText("Everyone who reads Sales sees this event."),
  ).toBeVisible();
  await board.selectOption({ label: "Fleet Reliability" });
  await expect(
    editor.getByText("Everyone who reads Fleet Reliability sees this event."),
  ).toBeVisible();
  await editor.getByLabel("Event title").fill("Reach truck maintenance");
  await editor.getByRole("button", { name: "Create event" }).click();
  await expect
    .poll(() => api.eventWrites.map((write) => write.path))
    .toEqual([`/api/boards/${fleetBoardId}/events`]);
  expect(api.eventWrites[0].body).toMatchObject({
    board_revision: 7,
    title: "Reach truck maintenance",
  });
  // The saved event's sheet opens with its board.
  const sheet = page.getByRole("dialog", { name: "Reach truck maintenance" });
  await expect(sheet.getByText("Fleet Reliability")).toBeVisible();
});

test("a person who posts nowhere has no New event, and a read-only board's event sheet has no Edit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMyCalendarApi(page, {
    levels: { sales: "read", fleet: "read" },
  });
  await page.goto(myCalendarHref(`&event=${forkliftEventId}`));
  const sheet = page.getByRole("dialog", { name: "Forklift breakdown review" });
  await expect(sheet.getByText("Fleet Reliability")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Edit event" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "New event" })).toHaveCount(0);
});

test("?event= on My calendar opens the event's sheet with its board and a link to open it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMyCalendarApi(page);
  await page.goto(myCalendarHref(`&event=${reviewEventId}`));
  const sheet = page.getByRole("dialog", { name: "Customer account review" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Sales")).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Open board" })).toHaveAttribute(
    "href",
    `/boards?department=${salesDepartmentId}&section=calendar&event=${reviewEventId}`,
  );
  // The person wrote this Sales event and posts on Sales: Edit and Archive.
  await expect(sheet.getByRole("button", { name: "Edit event" })).toBeVisible();
  await sheet.getByRole("button", { name: "More event actions" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Copy link",
    "Archive event",
  ]);
  await page.keyboard.press("Escape");
  await sheet.getByRole("button", { name: "Close event" }).click();
  await expect(page).toHaveURL(/\/boards\?section=my-calendar$/);
  // A Company event opens its sheet too; Company is read-only here.
  await page
    .getByRole("button", {
      name: "Q4 town hall, Company, Fri, Nov 13, 4pm",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`section=my-calendar&event=${townHallEventId}$`),
  );
  const company = page.getByRole("dialog", { name: "Q4 town hall" });
  await expect(
    company.getByRole("link", { name: "Open board" }),
  ).toHaveAttribute(
    "href",
    `/boards?section=calendar&event=${townHallEventId}`,
  );
  await expect(company.getByRole("button", { name: "Edit event" })).toHaveCount(
    0,
  );
  await company.getByRole("button", { name: "More event actions" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Copy link"]);
});

test("the toolbar keeps one row at 1280 in Week while a board is not loaded", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installMyCalendarApi(page, {
    statuses: { [inventoryBoardId]: "unavailable" },
  });
  await page.goto(myCalendarHref());
  await expect(
    page.getByRole("button", { name: "Calendars, 1 not loaded" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  const toolbar = page.getByRole("group", { name: "Calendar", exact: true });
  await expect(toolbar).toContainText("Nov");
  // One row (BR16): the 32px controls with no second line.
  expect((await toolbar.boundingBox())?.height ?? 0).toBeLessThanOrEqual(40);
});
