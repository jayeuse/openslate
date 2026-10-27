import { expect, test } from "./helpers/test";
import {
  calendarHref,
  installCalendarApi,
  quotesModuleId,
  quotesSourceId,
  validUntilFieldId,
} from "./helpers/board-calendar-api";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("record sources and due cards show on their dates, a hidden calendar stays hidden after a reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installCalendarApi(page);
  await page.goto(calendarHref());
  const month = page.getByRole("region", { name: "November 2026 calendar" });
  const quote = month.getByRole("button", {
    name: "Q-24112 Pacific Rim, Quotes · Valid until, Thu, Nov 19, all day",
    exact: true,
  });
  await expect(quote).toBeVisible();
  await expect(quote).toHaveAttribute("data-calendar-item", "source");
  // One window read per visible source for the month.
  expect(
    api.recordReads.filter(
      (body) =>
        (body as { from_date: string }).from_date === "2026-11-01" &&
        (body as { to_date: string }).to_date === "2026-11-30",
    ),
  ).toHaveLength(1);
  const due = month.getByRole("button", {
    name: /^Due: Update the price list, Cards · Due, Fri, Nov 20, due$/,
  });
  await expect(due).toContainText("Due Update the price list");
  await expect(
    month.getByRole("button", {
      name: /^Due: No access to this record, Cards · Due/,
    }),
  ).toBeVisible();
  await due.click();
  const summary = page.getByRole("dialog", { name: "Update the price list" });
  await expect(summary.getByText("Doing", { exact: true })).toBeVisible();
  await expect(summary.getByText("Fri, Nov 20, 2026")).toBeVisible();
  await expect(summary.getByText("Nobody", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const rail = page.getByRole("complementary", { name: "Calendars" });
  await rail.getByRole("checkbox", { name: "Quotes · Valid until" }).click();
  await expect(quote).toHaveCount(0);
  await page.reload();
  await expect(
    month.getByRole("button", { name: /^Customer account review,/ }).first(),
  ).toBeVisible();
  await expect(
    rail.getByRole("checkbox", { name: "Quotes · Valid until" }),
  ).not.toBeChecked();
  await expect(quote).toHaveCount(0);
  // A hidden source is not read.
  const before = api.recordReads.length;
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "December 2026", exact: true }),
  ).toBeVisible();
  expect(api.recordReads.length).toBe(before);
});

test("a manager adds a record source, reads the limit as a sentence, opens undated records, and removes a source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installCalendarApi(page);
  await page.route("**/api/views/data-sources?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: quotesModuleId,
            name: "Quotes",
            department_id: "00000000-0000-4000-8000-000000000a05",
            title_field_id: "00000000-0000-4000-8000-000000000a07",
          },
        ],
        pagination: {
          limit: 100,
          offset: 0,
          count: 1,
          total: 1,
          has_more: false,
        },
      },
    }),
  );
  await page.route(
    `**/api/views/data-sources/${quotesModuleId}/fields?**`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: validUntilFieldId,
              module_id: quotesModuleId,
              name: "Valid until",
              type: "date",
              required: false,
              position: 1,
              config: {},
            },
            {
              id: "00000000-0000-4000-8000-000000000a11",
              module_id: quotesModuleId,
              name: "Sent on",
              type: "datetime",
              required: false,
              position: 2,
              config: {},
            },
          ],
          pagination: {
            limit: 100,
            offset: 0,
            count: 2,
            total: 2,
            has_more: false,
          },
        },
      }),
  );
  await page.goto(calendarHref());
  const rail = page.getByRole("complementary", { name: "Calendars" });
  await rail.getByRole("button", { name: "Add record source" }).click();
  const dialog = page.getByRole("dialog", { name: "Add record source" });
  await dialog.getByLabel("Module").selectOption(quotesModuleId);
  // A field that is already a source is not offered again.
  await expect(dialog.getByLabel("Date field").locator("option")).toHaveText([
    "Choose a date field",
    "Sent on",
  ]);
  await dialog.getByLabel("Date field").selectOption({ label: "Sent on" });
  api.limitRefusal = true;
  await dialog.getByRole("button", { name: "Add source" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "This calendar already has 5 record sources. Remove one to add another.",
  );
  api.limitRefusal = false;
  await dialog.getByRole("button", { name: "Add source" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    rail.getByRole("checkbox", { name: "Quotes · Sent on" }),
  ).toBeChecked();

  await rail
    .getByRole("button", {
      name: "Record source actions, Quotes · Valid until",
    })
    .click();
  const undated = page.getByRole("menuitem", {
    name: "Open records without a date",
  });
  const href = await undated.getAttribute("href");
  expect(href).toContain(`module=${quotesModuleId}`);
  const changes = new URL(href!, "http://x").searchParams.get("changes")!;
  expect(
    JSON.parse(
      Buffer.from(
        changes.replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString(),
    ),
  ).toEqual({
    d: {
      filters: [
        {
          fieldId: validUntilFieldId,
          expectedType: "date",
          operator: "empty",
          value: null,
        },
      ],
    },
  });
  await page.getByRole("menuitem", { name: "Add to My calendar" }).click();
  await expect
    .poll(() => api.myCalendarWrites)
    .toEqual([{ module_id: quotesModuleId, date_field_id: validUntilFieldId }]);

  await rail
    .getByRole("button", {
      name: "Record source actions, Quotes · Valid until",
    })
    .click();
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Remove this record source?" })
    .getByRole("button", { name: "Remove source" })
    .click();
  await expect(
    rail.getByRole("checkbox", { name: "Quotes · Valid until" }),
  ).toHaveCount(0);
  expect(
    api.sourceWrites.map(({ method, path }) => [method, path]),
  ).toContainEqual([
    "DELETE",
    `/api/boards/00000000-0000-4000-8000-000000000a01/calendar-sources/${quotesSourceId}`,
  ]);
});

test("a failed source read shows in its row as not loaded, and Retry recovers it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installCalendarApi(page, { sourceFailures: 1 });
  await page.goto(calendarHref());
  const rail = page.getByRole("complementary", { name: "Calendars" });
  await expect(rail.getByText("not loaded ·")).toBeVisible();
  // The board's own events still show.
  await expect(
    page.getByRole("button", { name: /^Customer account review,/ }).first(),
  ).toBeVisible();
  await rail
    .getByRole("button", { name: "Retry Quotes · Valid until" })
    .click();
  await expect(
    page.getByRole("button", { name: /^Q-24112 Pacific Rim, Quotes/ }),
  ).toBeVisible();
  await expect(rail.getByText("not loaded ·")).toHaveCount(0);
});

test("a source the viewer cannot read stays hidden, with no placeholder and no read", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The server returns only the sources whose module the viewer reads.
  const api = await installCalendarApi(page, { level: "read", sources: [] });
  await page.goto(calendarHref());
  await expect(
    page.getByRole("button", { name: /^Customer account review,/ }).first(),
  ).toBeVisible();
  const rail = page.getByRole("complementary", { name: "Calendars" });
  await expect(
    rail.getByRole("heading", { name: "Record sources" }),
  ).toHaveCount(0);
  await expect(
    rail.getByRole("button", { name: "Add record source" }),
  ).toHaveCount(0);
  await expect(page.getByText("Quotes")).toHaveCount(0);
  expect(api.recordReads).toEqual([]);
});
