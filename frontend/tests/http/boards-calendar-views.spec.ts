import { expect, test, type Page } from "./helpers/test";
import {
  calendarHref,
  calendarName,
  installCalendarApi,
} from "./helpers/board-calendar-api";

test.use({ trace: "off", screenshot: "off", video: "off" });

function documentScrolls(page: Page) {
  return page.evaluate(() => ({
    down: document.documentElement.scrollHeight > window.innerHeight + 1,
    across: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
}

test("Month draws bars, ruled chips named with their calendar, week numbers, and stays still at 1280×720 and 1440×900", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installCalendarApi(page);
  await page.goto(calendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  await expect(month).toBeVisible();
  const review = month.getByRole("button", {
    name: `Customer account review, ${calendarName}, Mon, Nov 16, 9am`,
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute(
    "title",
    `Customer account review · ${calendarName}`,
  );
  await expect(
    month.getByRole("button", {
      name: `Logistics expo, ${calendarName}, Wed, Nov 18, all day`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(month.getByText("W47", { exact: true })).toBeVisible();
  await expect(
    month.getByRole("button", { name: "Wed, Nov 18", exact: true }),
  ).toHaveAttribute("aria-current", "date");
  // The time is never cut, and a title takes two lines while its day has
  // room (Nov 23 has no all-day bar above it).
  const roomy = month.getByRole("button", {
    name: `Customer account review, ${calendarName}, Mon, Nov 23, 9am`,
    exact: true,
  });
  const chip = await roomy.boundingBox();
  const time = await roomy.getByText("9am", { exact: true }).boundingBox();
  expect(chip).not.toBeNull();
  expect(time).not.toBeNull();
  expect(time!.x + time!.width).toBeLessThanOrEqual(
    chip!.x + chip!.width + 0.5,
  );
  expect(chip!.height).toBeGreaterThan(30);
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
  // Below 1440 the calendar list folds into the toolbar.
  await expect(
    page.getByRole("complementary", { name: "Calendars" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Calendars and record sources" })
    .click();
  await expect(
    page.getByRole("checkbox", { name: calendarName }),
  ).toBeChecked();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1440, height: 900 });
  const rail = page.getByRole("complementary", { name: "Calendars" });
  await expect(rail).toBeVisible();
  await expect(
    rail.getByRole("checkbox", { name: "Cards · Due" }),
  ).toBeChecked();
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
});

test("Week sizes blocks by duration, sets overlaps side by side, keeps all-day items above, and opens at 7 AM", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const api = await installCalendarApi(page);
  await page.goto(calendarHref("&view=week"));
  await expect(
    page.getByRole("heading", { name: "Nov 16 – Nov 22, 2026", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => api.windowReads.at(-1))
    .toEqual({ start: "2026-11-16", end: "2026-11-22" });
  const wednesday = page.getByRole("group", { name: "Wed, Nov 18" });
  const pricing = await wednesday
    .getByRole("button", { name: /^Pricing review,/ })
    .boundingBox();
  const quotes = await wednesday
    .getByRole("button", { name: /^Quote approvals,/ })
    .boundingBox();
  expect(pricing).not.toBeNull();
  expect(quotes).not.toBeNull();
  // Side by side: separate columns, overlapping rows; 90 minutes is taller.
  expect(quotes!.x).toBeGreaterThanOrEqual(pricing!.x + pricing!.width - 1);
  expect(quotes!.y).toBeLessThan(pricing!.y + pricing!.height);
  expect(pricing!.height).toBeGreaterThan(quotes!.height);
  await expect(
    page.getByRole("button", { name: /^Logistics expo,.*all day$/ }),
  ).toBeVisible();
  await expect(
    wednesday.getByRole("button", { name: /^Pricing review,/ }),
  ).toContainText("10am–11:30am · Room 1");
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
});

test("Upcoming lists from today by day, names a series' repeat in its row, and Show later reads the next 42 days", async ({
  page,
}) => {
  const api = await installCalendarApi(page);
  await page.goto(calendarHref("&view=upcoming"));
  const today = page.getByRole("region", { name: "Wed, Nov 18" });
  await expect(today.getByText("Wed, Nov 18 · Today")).toBeVisible();
  await expect(
    today.getByRole("button", { name: /^Logistics expo,/ }),
  ).toContainText("All day · to Nov 20");
  const monday = page.getByRole("region", { name: "Mon, Nov 23" });
  await expect(
    monday.getByRole("button", { name: /^Customer account review,/ }),
  ).toContainText("Weekly");
  await expect(page.getByRole("region", { name: "Mon, Nov 16" })).toHaveCount(
    0,
  );
  expect(api.windowReads).toContainEqual({
    start: "2026-11-18",
    end: "2026-12-29",
  });
  await page.getByRole("button", { name: "Show later" }).click();
  await expect
    .poll(() => api.windowReads)
    .toContainEqual({ start: "2026-12-30", end: "2027-02-09" });
});

test("an empty month points to the next event and goes there, or says there is none", async ({
  page,
}) => {
  const api = await installCalendarApi(page, {
    today: "2026-10-26",
    occurrences: () => [],
    nextOccurrence: (window) =>
      window.start === "2026-10-01" ? { date: "2026-11-02" } : null,
  });
  await page.goto(calendarHref());
  await expect(
    page.getByRole("status").filter({ hasText: "No events in October" }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Go to the next event, Mon, Nov 2",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "November 2026", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => api.windowReads.at(-1))
    .toEqual({ start: "2026-11-01", end: "2026-11-30" });
  // December has no event, record, or due card, and nothing comes later.
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "No upcoming events" }),
  ).toBeVisible();
});

test("a phone opens on today's day list, Month shows dots and the day's rows, and nothing scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installCalendarApi(page);
  await page.goto(calendarHref());
  await expect(
    page.getByRole("button", { name: "Week", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Nov 16 – Nov 22", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /^Wed, Nov 18, 3 items$/ }),
  ).toHaveAttribute("aria-selected", "true");
  const day = page.getByRole("region", { name: "Selected day" });
  await expect(
    day.getByRole("button", { name: /^Pricing review,/ }),
  ).toContainText(calendarName);
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Nov 2026", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Mon, Nov 23, 1 item", exact: true })
    .click();
  await expect(
    day.getByRole("button", { name: /^Customer account review,/ }),
  ).toBeVisible();
  for (const name of ["Previous month", "Next month", "Today", "Month"]) {
    const box = await page
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect((await documentScrolls(page)).across).toBe(false);
});

test("Created by me filters events in the browser, and Archived lists archived events for managers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installCalendarApi(page);
  await page.goto(calendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  await expect(
    month.getByRole("button", { name: /^Pricing review,/ }),
  ).toBeVisible();
  const reads = api.windowReads.length;
  await page.getByRole("button", { name: "Show: All" }).click();
  await page
    .getByRole("menuitemradio", { name: "Created by me", exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("show") === "mine",
  );
  await expect(
    month.getByRole("button", { name: /^Pricing review,/ }),
  ).toHaveCount(0);
  await expect(
    month.getByRole("button", { name: /^Customer account review,/ }).first(),
  ).toBeVisible();
  expect(api.windowReads.length).toBe(reads);
  await page.getByRole("button", { name: "Show: Created by me" }).click();
  await page
    .getByRole("menuitemradio", { name: "Archived", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Archived Board events" }),
  ).toBeVisible();
  expect(
    api.eventListReads.some((query) => query.includes("archived=archived")),
  ).toBe(true);
});
