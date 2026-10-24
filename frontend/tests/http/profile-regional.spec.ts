import { expect, heldResponse, test, type Page } from "./helpers/test";
import {
  installProfileApi,
  profilePreferences,
  profileSelf,
} from "./helpers/profile-api";
import { ids, mockAccessApi } from "./helpers/access-api";

/** Choose a zone in the searchable Timezone select; each choice saves at once. */
async function chooseTimezone(page: Page, search: string, option: RegExp) {
  await page.getByRole("combobox", { name: "Timezone", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search timezone", exact: true })
    .fill(search);
  await page.getByRole("listbox").getByRole("option", { name: option }).click();
}

test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  locale: "en-US",
  timezoneId: "Pacific/Auckland",
});

test("Profile Regional saves a timezone at once, so leaving after it needs no guard", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  await page.goto("/settings#regional");
  const timezone = page.getByRole("combobox", {
    name: "Timezone",
    exact: true,
  });
  await expect(timezone).toBeEnabled();
  await chooseTimezone(page, "London", /Europe\/London$/);
  await expect(timezone).toContainText("Europe/London");
  await expect
    .poll(() => api.writes.map(({ body }) => body))
    .toEqual([{ appearance: { timezone: "Europe/London" } }]);
  await page
    .getByRole("complementary", { name: "Primary sidebar", exact: true })
    .getByRole("link", { name: "OpenComms", exact: true })
    .click();
  await expect(page).toHaveURL(/\/comms$/);
  await expect(
    page.getByRole("alertdialog").filter({ hasText: /unsaved/i }),
  ).toHaveCount(0);
});

test("Profile Regional confirms personal choices with partial writes", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  await page.goto("/settings#regional");
  await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
    "organization",
  );
  const hold = heldResponse();
  api.holdPreferences = hold;
  try {
    await page.getByLabel("Date format", { exact: true }).selectOption("dmy");
    await hold.entered;
    await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
      "organization",
    );
    await expect(
      page.getByLabel("Time format", { exact: true }),
    ).toBeDisabled();
    hold.release();
    await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
      "dmy",
    );
  } finally {
    hold.release();
  }
  await page.getByLabel("Time format", { exact: true }).selectOption("24h");
  await expect(page.getByLabel("Time format", { exact: true })).toHaveValue(
    "24h",
  );
  await page.getByLabel("Week starts", { exact: true }).selectOption("sunday");
  await expect(page.getByLabel("Week starts", { exact: true })).toHaveValue(
    "sunday",
  );
  await chooseTimezone(page, "Los Angeles", /America\/Los Angeles$/);
  await expect(
    page.getByRole("combobox", { name: "Timezone", exact: true }),
  ).toContainText("America/Los Angeles");
  await expect(
    page.getByLabel("Start page after sign-in", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Start page after sign-in", { exact: true })
    .selectOption("boards");
  await expect(
    page.getByLabel("Start page after sign-in", { exact: true }),
  ).toHaveValue("boards");
  expect(api.writes.map(({ body }) => body)).toEqual([
    { appearance: { date_format: "dmy" } },
    { appearance: { time_format: "24h" } },
    { appearance: { week_start: "sunday" } },
    { appearance: { timezone: "America/Los_Angeles" } },
    { appearance: { start_page: "boards" } },
  ]);
  await page.getByLabel("Text size", { exact: true }).selectOption("125");
  await page
    .getByLabel("Page spacing", { exact: true })
    .selectOption("compact");
  await expect(
    page.getByRole("region", { name: "Appearance preview", exact: true }),
  ).toContainText("Equipment request");
  await page.reload();
  await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
    "dmy",
  );
  await expect(
    page.getByLabel("Start page after sign-in", { exact: true }),
  ).toHaveValue("boards");
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Use shortcuts" }),
  ).toBeChecked();
});

for (const [dateFormat, timeFormat] of [
  ["mdy", "12h"],
  ["ymd", "24h"],
] as const) {
  test(`Profile Regional restores explicit organization inheritance from ${dateFormat}/${timeFormat}`, async ({
    page,
  }) => {
    const api = await installProfileApi(page);
    Object.assign(api.appearance, {
      timezone: "America/Los_Angeles",
      date_format: dateFormat,
      time_format: timeFormat,
      week_start: "sunday",
    });
    const workspaceRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/workspace")
        workspaceRequests.push(request.method());
    });
    await page.goto("/settings#regional");
    const timezone = page.getByRole("combobox", {
      name: "Timezone",
      exact: true,
    });
    await expect(timezone).toContainText("America/Los Angeles");
    const sessions = page.getByRole("list", {
      name: "Active sessions",
      exact: true,
    });
    if (dateFormat === "ymd") {
      // Personal date and time choices format the session list.
      await expect(sessions).toContainText("2026-09-30");
      await expect(sessions).toContainText("17:30");
    }
    // The options come from the zone catalog, so an offset such as "+08:00"
    // cannot be chosen (isolated/shell/account-settings.spec.ts).
    await timezone.click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "Organization timezone (Asia/Manila)" })
      .click();
    await expect.poll(() => api.appearance.timezone).toBeNull();
    await expect(page.getByLabel("Date format", { exact: true })).toBeEnabled();
    for (const label of ["Date format", "Time format", "Week starts"]) {
      await page
        .getByLabel(label, { exact: true })
        .selectOption("organization");
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(
        "organization",
      );
    }
    expect(api.appearance).toEqual({
      motion: "system",
      keyboard_shortcuts: true,
      timezone: null,
      date_format: "organization",
      time_format: "organization",
      week_start: "organization",
      start_page: "automatic",
    });
    await page.reload();
    await expect(timezone).toHaveText("Organization timezone (Asia/Manila)");
    for (const label of ["Date format", "Time format", "Week starts"])
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(
        "organization",
      );
    await expect(
      page.getByLabel("Start page after sign-in", { exact: true }),
    ).toHaveValue("automatic");
    await expect(
      page.getByRole("switch", { name: "Reduce motion" }),
    ).not.toBeChecked();
    await expect(sessions).toContainText(/Oct 1, 2026.*8:30\sAM/);
    // Personal choices never write the organization's settings.
    expect(workspaceRequests.every((method) => method === "GET")).toBe(true);
  });
}

test("Profile Regional failed save keeps confirmed values and Retry does not repeat mutations", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  api.preferencesWriteStatus = 503;
  await page.goto("/settings#regional");
  await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
    "organization",
  );
  await page.getByLabel("Date format", { exact: true }).selectOption("ymd");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /Preferences could not be saved/ })
      .first(),
  ).toBeVisible();
  await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
    "organization",
  );
  await expect(page.getByLabel("Date format", { exact: true })).toBeDisabled();
  api.preferencesWriteStatus = 200;
  await page
    .getByRole("button", { name: "Retry preferences", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Date format", { exact: true })).toBeEnabled();
  expect(api.writes).toHaveLength(1);
});

test("confirmed Profile Regional choices reach Access people and sessions without changing expiry inputs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-12-28T12:00:00Z"));
  const access = await mockAccessApi(page);
  Object.assign(access.users.get(ids.ben)!, {
    role: "guest",
    sponsor_user_id: ids.rosa,
    expires_at: "2027-01-02T00:30:00Z",
  });
  access.monitoring.set(ids.ben, {
    active_session_count: 1,
    mfa_verified_totp: false,
    mfa_observed_at: null,
    last_active_at: "2026-12-27T18:00:00Z",
  });
  Object.assign(access.sessions[0]!, {
    created_at: "2026-10-01T00:30:00Z",
    refreshed_at: "2026-10-01T00:30:00Z",
    expires_at: "2099-01-01T00:00:00Z",
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: profileSelf(ids.rosa, "admin") }),
  );
  const preferences = profilePreferences(ids.rosa);
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        display_name: "Northwind",
        mark: "NW",
        logo_file_id: null,
        revision: 3,
        today: "2026-12-28",
        week_start: "monday",
        locale: "en-US",
        timezone: "Asia/Manila",
        invitation_expiry_days: 7,
        guest_duration_days: 45,
      },
    }),
  );
  const writes: unknown[] = [];
  await page.route(`**/api/users/${ids.rosa}/preferences`, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        appearance: Record<string, unknown>;
      };
      writes.push(body);
      Object.assign(preferences.appearance, body.appearance);
    }
    return route.fulfill({ json: preferences });
  });
  await page.goto("/settings#regional");
  const regional = page.getByRole("region", { name: "Regional", exact: true });
  await expect(
    regional.getByLabel("Date format", { exact: true }),
  ).toBeEnabled();
  await regional.getByLabel("Date format", { exact: true }).selectOption("ymd");
  await expect(regional.getByLabel("Date format", { exact: true })).toHaveValue(
    "ymd",
  );
  await regional.getByLabel("Time format", { exact: true }).selectOption("24h");
  await expect(regional.getByLabel("Time format", { exact: true })).toHaveValue(
    "24h",
  );
  await chooseTimezone(page, "Los Angeles", /America\/Los Angeles$/);
  await expect(
    regional.getByRole("combobox", { name: "Timezone", exact: true }),
  ).toContainText("America/Los Angeles");
  await expect(
    regional.getByLabel("Date format", { exact: true }),
  ).toBeEnabled();
  const navigation = page.getByRole("navigation", {
    name: "Main navigation",
    exact: true,
  });
  await navigation.getByRole("button", { name: "Access", exact: true }).click();
  await navigation.getByRole("link", { name: "People", exact: true }).click();
  const table = page.getByRole("table", { name: "People", exact: true });
  const row = table.getByRole("row").filter({ hasText: "Ben Cruz" });
  // Rows show relative activity; its full time follows the person's choices.
  await expect(row.locator("time")).toHaveAttribute(
    "title",
    /2026-12-27.*10:00/,
  );
  await row
    .getByRole("button", { name: "Manage Ben Cruz", exact: true })
    .click();
  const person = page.getByRole("dialog", { name: "Ben Cruz", exact: true });
  await expect(person).toContainText("Ends 2027-01-01");
  // This is a machine date input under the existing Access expiry policy,
  // not a personal-display date. No change to the expiry is requested.
  await expect(person.getByLabel("Access ends", { exact: true })).toHaveValue(
    "2027-01-02",
  );
  await person.getByRole("tab", { name: "Sessions", exact: true }).click();
  const sessions = person.getByRole("list", { name: "Sessions", exact: true });
  const laptop = sessions
    .getByRole("listitem")
    .filter({ hasText: "Laptop browser" });
  await expect(laptop).toContainText("2026-09-30");
  await expect(laptop).toContainText("17:30");
  expect(writes).toEqual([
    { appearance: { date_format: "ymd" } },
    { appearance: { time_format: "24h" } },
    { appearance: { timezone: "America/Los_Angeles" } },
  ]);
  expect(access.calls.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(access.users.get(ids.ben)?.expires_at).toBe("2027-01-02T00:30:00Z");
});
