import { expect, test } from "./helpers/test";
import {
  installProfileApi,
  profilePreferences,
  profileSelf,
  profileGate,
  profileUserA,
  regionalDefaults,
} from "./helpers/profile-api";
import { ids, mockAccessApi } from "./helpers/access-api";

test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  locale: "en-US",
  timezoneId: "Pacific/Auckland",
});

test("Profile Regional keeps an unsaved timezone through section navigation and guards leaving", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/profile#regional");
  const timezone = page.getByLabel("Timezone", { exact: true });
  await expect(timezone).toBeEnabled();
  await timezone.fill("Europe/London");
  await page
    .getByRole("navigation", { name: "Profile sections" })
    .getByRole("link", { name: "Identity", exact: true })
    .click();
  await expect(timezone).toHaveValue("Europe/London");
  await page
    .getByRole("complementary", { name: "Primary sidebar", exact: true })
    .getByRole("link", { name: "OpenComms", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog").filter({ hasText: /unsaved/i });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(page).toHaveURL(/\/profile#identity$/);
  await expect(timezone).toHaveValue("Europe/London");
});

test("Profile Regional confirms personal choices with partial writes and keeps device choices local", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  await page.goto("/profile#regional");
  await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
    "organization",
  );
  const hold = profileGate();
  api.holdPreferences = hold;
  try {
    await page.getByLabel("Date format", { exact: true }).selectOption("dmy");
    await hold.begun;
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
  await page
    .getByLabel("First day of the week", { exact: true })
    .selectOption("sunday");
  await expect(
    page.getByLabel("First day of the week", { exact: true }),
  ).toHaveValue("sunday");
  await page
    .getByLabel("Timezone", { exact: true })
    .fill("America/Los_Angeles");
  await page
    .getByRole("button", { name: "Save timezone", exact: true })
    .click();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(
    "America/Los_Angeles",
  );
  await expect(
    page.getByRole("button", { name: "Save timezone", exact: true }),
  ).toBeDisabled();
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
  const writeCount = api.writes.length;
  await page.getByLabel("Text size", { exact: true }).selectOption("125");
  await page
    .getByLabel("Page spacing", { exact: true })
    .selectOption("compact");
  await expect(
    page.getByRole("region", { name: "Appearance preview", exact: true }),
  ).toContainText("Equipment request");
  expect(api.writes).toHaveLength(writeCount);
  expect(
    await page.evaluate(() => ({
      size: document.documentElement.dataset.textSize,
      density: document.documentElement.dataset.density,
    })),
  ).toEqual({ size: "125", density: "compact" });
  await page.reload();
  await expect(page.getByLabel("Date format", { exact: true })).toHaveValue(
    "dmy",
  );
  await expect(
    page.getByLabel("Start page after sign-in", { exact: true }),
  ).toHaveValue("boards");
  expect(api.appearance.motion).toBe("system");
  expect(api.appearance.keyboard_shortcuts).toBe(true);
});

test("Profile Regional rejects an invalid IANA timezone and restores explicit organization inheritance", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  Object.assign(api.appearance, {
    timezone: "America/Los_Angeles",
    date_format: "mdy",
    time_format: "12h",
    week_start: "sunday",
  });
  await page.goto("/profile#regional");
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(
    "America/Los_Angeles",
  );
  await page.getByLabel("Timezone", { exact: true }).fill("+08:00");
  await page
    .getByRole("button", { name: "Save timezone", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /IANA/i }),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
  await page
    .getByRole("button", { name: "Use organization timezone", exact: true })
    .click();
  await expect.poll(() => api.appearance.timezone).toBeNull();
  await expect(page.getByLabel("Date format", { exact: true })).toBeEnabled();
  for (const label of ["Date format", "Time format", "First day of the week"]) {
    await page.getByLabel(label, { exact: true }).selectOption("organization");
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(
      "organization",
    );
  }
  expect(api.appearance).toEqual({
    motion: "system",
    keyboard_shortcuts: true,
    ...regionalDefaults,
  });
  const sessions = page.getByRole("list", {
    name: "Active sessions",
    exact: true,
  });
  await expect(sessions).toContainText(/Oct 1, 2026.*8:30\sAM/);
});

test("Profile Regional failed save keeps confirmed values and Retry does not repeat mutations", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  api.preferencesWriteStatus = 503;
  await page.goto("/profile#regional");
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

test("Profile personal regional time changes session display but not date-only or workspace settings", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  Object.assign(api.appearance, {
    timezone: "America/Los_Angeles",
    date_format: "ymd",
    time_format: "24h",
  });
  const workspaceRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/workspace")
      workspaceRequests.push(request.method());
  });
  await page.goto("/profile");
  await expect(
    page.getByRole("list", { name: "Active sessions", exact: true }),
  ).toContainText("2026-09-30");
  await expect(
    page.getByRole("list", { name: "Active sessions", exact: true }),
  ).toContainText("17:30");
  expect(workspaceRequests.every((method) => method === "GET")).toBe(true);
  expect(api.writes).toEqual([]);
  expect(api.people.get(profileUserA)?.expires_at).toBeNull();
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
  await page.goto("/profile#regional");
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
  await regional
    .getByLabel("Timezone", { exact: true })
    .fill("America/Los_Angeles");
  await regional
    .getByRole("button", { name: "Save timezone", exact: true })
    .click();
  await expect(
    regional.getByRole("button", { name: "Save timezone", exact: true }),
  ).toBeDisabled();
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
  await expect(row).toContainText("2027-01-01");
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
