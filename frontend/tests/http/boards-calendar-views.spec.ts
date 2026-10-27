import { expect, test, type Locator, type Page } from "./helpers/test";
import {
  calendarBoardId,
  calendarHref,
  calendarName,
  installCalendarApi,
  wireEvent,
  wireOccurrence,
} from "./helpers/board-calendar-api";

test.use({ trace: "off", screenshot: "off", video: "off" });

/** Nothing in the chip is cut across or below. */
function wholeTitle(chip: Locator) {
  return chip.evaluate((node) =>
    [...node.querySelectorAll("span")].every(
      (span) =>
        span.scrollWidth <= span.clientWidth + 1 &&
        span.scrollHeight <= span.clientHeight + 1,
    ),
  );
}

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
    month.getByRole("button", { name: "Wed, Nov 18, show week", exact: true }),
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
  expect(await wholeTitle(roomy)).toBe(true);
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
  // Below 1440 the calendar list folds into the toolbar.
  await expect(
    page.getByRole("complementary", { name: "Calendars" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Calendars", exact: true }).click();
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
  // With the rail open the cells are narrowest, and a timed title still
  // reads whole in two lines: its time starts line 1 (BR55).
  expect(await wholeTitle(roomy)).toBe(true);
  // The rail's lists are sections of the page, not of a missing h2.
  const levels = await page.evaluate(() =>
    [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) =>
      Number(heading.tagName[1]),
    ),
  );
  expect(
    levels.filter((level, index) => index > 0 && level > levels[index - 1] + 1),
  ).toEqual([]);
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
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(calendarHref());
  await expect(
    page.getByRole("status").filter({ hasText: "No events in October" }),
  ).toBeVisible();
  // The empty month says so on its own grid, so the toolbar stays one row.
  const october = page.getByRole("region", { name: "October 2026 calendar" });
  await expect(october.getByText("No events in October")).toBeVisible();
  const toolbar = page.getByRole("group", { name: "Calendar", exact: true });
  expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(36);
  await october
    .getByRole("button", {
      name: "Next: Mon, Nov 2, go to the next event",
      exact: true,
    })
    .click();
  const november = page.getByRole("heading", {
    name: "November 2026",
    exact: true,
  });
  await expect(november).toBeVisible();
  // The button left with the empty month, so the new period takes focus.
  await expect(november).toBeFocused();
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
    page.getByRole("button", { name: /^Wed, Nov 18, 3 items$/ }),
  ).toHaveAttribute("aria-pressed", "true");
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
    page.getByRole("region", { name: "Archived events" }),
  ).toBeVisible();
  expect(
    api.eventListReads.some((query) => query.includes("archived=archived")),
  ).toBe(true);
});

test("at 1280×720 every Month target is at least 24px tall and shows whole, and a full day still counts +n more", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installCalendarApi(page);
  await page.goto(calendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  await expect(
    month.getByRole("button", { name: "Wed, Nov 18, show week", exact: true }),
  ).toBeVisible();
  await expect(
    month.getByRole("button", { name: /^\d+ more on Wed, Nov 18$/ }),
  ).toBeVisible();
  // Day numbers, chips, bars and "+n more": none is under the WCAG 2.5.8
  // floor, and none is cut by its week row.
  const small = await month.evaluate((region) =>
    [...region.querySelectorAll("button")].flatMap((button) => {
      const box = button.getBoundingClientRect();
      const week = button.parentElement!.parentElement!.getBoundingClientRect();
      return box.height < 24 || box.bottom > week.bottom + 0.5
        ? [`${button.getAttribute("aria-label")} ${box.height}`]
        : [];
    }),
  );
  expect(small).toEqual([]);
  expect(await documentScrolls(page)).toEqual({ down: false, across: false });
});

test("closing an event returns focus to its chip, and a day number's week takes focus at its title", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installCalendarApi(page);
  await page.goto(calendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  const chip = month.getByRole("button", {
    name: `Customer account review, ${calendarName}, Mon, Nov 16, 9am`,
    exact: true,
  });
  await chip.click();
  const sheet = page.getByRole("dialog", { name: "Customer account review" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(chip).toBeFocused();

  await month
    .getByRole("button", { name: "Wed, Nov 18, show week", exact: true })
    .click();
  const week = page.getByRole("heading", {
    name: "Nov 16 – Nov 22, 2026",
    exact: true,
  });
  await expect(week).toBeVisible();
  await expect(week).toBeFocused();
});

test("a search or a hidden calendar that empties the month says so, with the step that undoes it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installCalendarApi(page);
  await page.goto(calendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  await expect(
    month.getByRole("button", { name: /^Pricing review,/ }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Search events" }).fill("zzz");
  await expect(month.getByText('No events match "zzz"')).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: 'No events match "zzz"' }),
  ).toBeAttached();
  await month
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search events" }),
  ).toHaveValue("");
  await expect(
    month.getByRole("button", { name: /^Pricing review,/ }),
  ).toBeVisible();

  const rail = page.getByRole("complementary", { name: "Calendars" });
  for (const name of [calendarName, "Cards · Due", "Quotes · Valid until"])
    await rail.getByRole("checkbox", { name }).uncheck();
  await expect(month.getByText("3 calendars hidden")).toBeVisible();
  await month.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(
    rail.getByRole("checkbox", { name: calendarName }),
  ).toBeChecked();
  await expect(
    month.getByRole("button", { name: /^Pricing review,/ }),
  ).toBeVisible();
});

test("the month's day numbers and the mini month are one Tab stop each, moved with arrow keys", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installCalendarApi(page);
  await page.goto(calendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  const today = month.getByRole("button", {
    name: "Wed, Nov 18, show week",
    exact: true,
  });
  await expect(today).toHaveAttribute("tabindex", "0");
  await expect(
    month.locator('button[aria-label$=", show week"][tabindex="0"]'),
  ).toHaveCount(1);
  await today.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    month.getByRole("button", { name: "Thu, Nov 19, show week", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    month.getByRole("button", { name: "Thu, Nov 26, show week", exact: true }),
  ).toBeFocused();

  const rail = page.getByRole("complementary", { name: "Calendars" });
  await expect(
    rail.locator('button[aria-label^="Go to "][tabindex="0"]'),
  ).toHaveCount(1);
  const mini = rail.getByRole("button", { name: "Go to Wed, Nov 18" });
  await mini.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    rail.getByRole("button", { name: "Go to Tue, Nov 17" }),
  ).toBeFocused();
});

test("an alert above the month keeps its bars at 1280×720, and the page still does not scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installCalendarApi(page);
  await page.route(`**/api/boards/${calendarBoardId}/my-access`, (route) =>
    route.fulfill({ status: 500, json: { detail: "unavailable" } }),
  );
  await page.goto(calendarHref());
  await expect(
    page.getByText("Could not check edit access.", { exact: false }),
  ).toBeVisible();
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  // A week row keeps a lane for its bars, so the expo is not "+1 more".
  await expect(
    month.getByRole("button", {
      name: `Logistics expo, ${calendarName}, Wed, Nov 18, all day`,
      exact: true,
    }),
  ).toBeVisible();
  expect((await documentScrolls(page)).down).toBe(false);
});

test("at 1280 a one-day all-day block in Week wraps its title to two lines, as Month does", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const renewal = wireEvent({
    id: "00000000-0000-4000-8000-000000000e91",
    title: "Customer account renewal review",
    author: "00000000-0000-4000-8000-000000000e92",
    allDay: true,
    start: "2026-11-17",
    end: "2026-11-17",
  });
  await installCalendarApi(page, {
    occurrences: () => [
      wireOccurrence(renewal, "2026-11-17", "2026-11-17", "2026-11-17"),
    ],
  });
  await page.goto(calendarHref("&view=week"));
  const block = page.getByRole("button", {
    name: /^Customer account renewal review,.*all day$/,
  });
  await expect(block).toBeVisible();
  // The whole title shows: nothing is cut across or below.
  expect(
    await block.evaluate((node) =>
      [...node.querySelectorAll("span")].every(
        (span) =>
          span.scrollWidth <= span.clientWidth + 1 &&
          span.scrollHeight <= span.clientHeight + 1,
      ),
    ),
  ).toBe(true);
  expect((await block.boundingBox())!.height).toBeGreaterThan(30);
});
