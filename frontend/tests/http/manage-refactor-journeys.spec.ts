import { expect, heldResponse, signedInAs, test } from "./helpers/test";
import type { Page } from "./helpers/test";
import { mockManageBackups } from "./helpers/manage-backups";
import { sendOpenViewEvent } from "./helpers/openview-event-source";

type WorkspaceProfile = {
  id: string;
  display_name: string;
  legal_name: string | null;
  description: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  postal_address: string | null;
  logo_file_id: string | null;
  timezone: string;
  locale: string;
  mark: string;
  currency: string;
  week_start: "monday" | "sunday";
  business_hours: string;
  theme: "slate" | "whiteboard" | "triplicate" | "stockroom";
  invitation_expiry_days: number;
  guest_duration_days: number;
  revision: number;
  created_at: string;
  updated_at: string;
  today: string;
};

const initialWorkspace: WorkspaceProfile = {
  id: "00000000-0000-4000-8000-000000000077",
  display_name: "Riverside Services",
  legal_name: null,
  description: null,
  contact_email: null,
  contact_phone: null,
  postal_address: null,
  logo_file_id: null,
  timezone: "Asia/Manila",
  locale: "en-PH",
  mark: "RS",
  currency: "PHP",
  week_start: "monday",
  business_hours: "09:00–18:00",
  theme: "slate",
  invitation_expiry_days: 7,
  guest_duration_days: 30,
  revision: 4,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  today: "2026-09-01",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function chooseRegionalOption(
  page: Page,
  label: string,
  search: string,
  option: string | RegExp,
) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("dialog").getByRole("combobox").fill(search);
  await page
    .getByRole("option", { name: option, exact: typeof option === "string" })
    .click();
}

function installWorkspaceRoute(
  page: Page,
  initial: WorkspaceProfile = initialWorkspace,
) {
  let current: WorkspaceProfile = { ...initial };
  const patches: Record<string, unknown>[] = [];
  void page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: current });
      return;
    }
    if (route.request().method() !== "PATCH") {
      await route.fulfill({ status: 405 });
      return;
    }
    const payload: unknown = route.request().postDataJSON();
    if (!isRecord(payload) || typeof payload.revision !== "number")
      throw new Error("Workspace PATCH must include a revision");
    patches.push(payload);
    if (payload.revision !== current.revision) {
      await route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision" } },
      });
      return;
    }
    current = {
      ...current,
      display_name:
        typeof payload.display_name === "string"
          ? payload.display_name.trim()
          : current.display_name,
      locale:
        typeof payload.locale === "string" ? payload.locale : current.locale,
      timezone:
        typeof payload.timezone === "string"
          ? payload.timezone
          : current.timezone,
      mark:
        typeof payload.mark === "string" ? payload.mark.trim() : current.mark,
      currency:
        typeof payload.currency === "string"
          ? payload.currency.trim().toUpperCase()
          : current.currency,
      week_start:
        payload.week_start === "monday" || payload.week_start === "sunday"
          ? payload.week_start
          : current.week_start,
      business_hours:
        typeof payload.business_hours === "string"
          ? payload.business_hours.trim()
          : current.business_hours,
      revision: current.revision + 1,
    };
    await route.fulfill({ json: current });
  });
  return { patches };
}

test.beforeEach(async ({ page }) => {
  installWorkspaceRoute(page);
});

test("Manage organization loads and saves all seven workspace fields", async ({
  page,
}) => {
  const workspace = installWorkspaceRoute(page, {
    ...initialWorkspace,
    display_name: "Harbor workspace",
    mark: "",
    currency: "SGD",
    week_start: "sunday",
    business_hours: "08:00–17:00",
  });
  await page.goto("/manage?view=organization");

  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  const locale = page.getByRole("combobox", {
    name: "Regional format",
    exact: true,
  });
  const timezone = page.getByRole("combobox", {
    name: "Timezone",
    exact: true,
  });
  const mark = page.getByRole("textbox", {
    name: "Organization mark",
    exact: true,
  });
  const currency = page.getByRole("combobox", {
    name: "Currency",
    exact: true,
  });
  const week = page.getByRole("combobox", {
    name: "Week starts on",
    exact: true,
  });
  const hours = page.getByRole("textbox", {
    name: "Business hours",
    exact: true,
  });
  await expect(mark).toHaveValue("");
  await expect(currency).toContainText("SGD");
  await expect(week).toHaveValue("Sunday");
  await expect(hours).toHaveValue("08:00–17:00");
  await expect(page.getByRole("main")).not.toContainText("are examples");
  await expect(name).toHaveValue("Harbor workspace");
  await expect(locale).toContainText("English (Philippines)");
  await expect(timezone).toContainText("Asia/Manila");

  await name.fill("Harbor operations");
  await chooseRegionalOption(
    page,
    "Regional format",
    "Singapore",
    "English (Singapore)",
  );
  await chooseRegionalOption(page, "Timezone", "UTC", /^UTC\+00:00.*UTC$/);
  await mark.fill("HOP");
  await chooseRegionalOption(page, "Currency", "USD", /USD.*US Dollar/);
  await week.selectOption("Monday");
  await hours.fill("10:00–19:00");
  await page.getByRole("button", { name: "Save settings" }).click();

  await expect(name).toHaveValue("Harbor operations");
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  expect(workspace.patches).toEqual([
    {
      revision: 4,
      display_name: "Harbor operations",
      locale: "en-SG",
      timezone: "UTC",
      mark: "HOP",
      currency: "USD",
      week_start: "monday",
      business_hours: "10:00–19:00",
    },
  ]);
  await page.reload();
  await expect(name).toHaveValue("Harbor operations");
  await expect(
    page.getByRole("combobox", { name: "Currency", exact: true }),
  ).toContainText("USD");
  await expect(mark).toHaveValue("HOP");
  await expect(week).toHaveValue("Monday");
  await expect(hours).toHaveValue("10:00–19:00");
  await mark.fill("");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  expect(workspace.patches[1]).toEqual({ revision: 5, mark: "" });
  await page.reload();
  await expect(mark).toHaveValue("");
});

test("Manage organization refreshes a stale revision, keeps the draft, then shows a 403 without clearing it", async ({
  page,
}) => {
  let current = { ...initialWorkspace };
  const patches: Record<string, unknown>[] = [];
  let patchCount = 0;
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: current });
      return;
    }
    patchCount += 1;
    const payload: unknown = route.request().postDataJSON();
    if (!isRecord(payload)) throw new Error("Expected a workspace patch");
    patches.push(payload);
    if (patchCount === 1) {
      current = {
        ...current,
        display_name: "Another administrator's name",
        revision: current.revision + 1,
      };
      await route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision", message: "stale" } },
      });
      return;
    }
    await route.fulfill({
      status: 403,
      json: { detail: "Forbidden" },
    });
  });
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toHaveValue("Riverside Services");
  await name.fill("My pending change");
  await page.getByRole("button", { name: "Save settings" }).click();

  const saveAgain = page.getByRole("button", {
    name: "Save again",
    exact: true,
  });
  await expect(saveAgain).toBeEnabled();
  await expect(name).toHaveValue("My pending change");
  await saveAgain.click();
  await expect(
    page.getByText(
      "Only administrators can change these settings. Reload the page to check your access.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(name).toHaveValue("My pending change");
  expect(patches).toEqual([
    { revision: 4, display_name: "My pending change" },
    { revision: 5, display_name: "My pending change" },
  ]);
});

test("Manage organization retries a failed workspace load", async ({
  page,
}) => {
  let allowRead = false;
  await page.route("**/api/workspace", async (route) => {
    if (!allowRead) {
      await route.fulfill({
        status: 503,
        json: { detail: { code: "workspace_unavailable" } },
      });
      return;
    }
    await route.fulfill({ json: initialWorkspace });
  });
  await page.goto("/manage?view=organization");
  await expect(
    page.getByText("The organization settings could not be loaded.", {
      exact: true,
    }),
  ).toBeVisible();
  allowRead = true;
  const retried = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/workspace",
  );
  await page
    .getByRole("button", { name: "Retry organization settings", exact: true })
    .click();
  await retried;
  await expect(
    page.getByRole("textbox", { name: "Organization name", exact: true }),
  ).toHaveValue("Riverside Services");
});

test.describe("Organization regional choices", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });

  test("regional choices search names and save stable format, zone and currency values", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-07-01T12:00:00Z") });
    const workspace = installWorkspaceRoute(page);
    await page.goto("/manage?view=organization");
    const format = page.getByRole("combobox", {
      name: "Regional format",
      exact: true,
    });
    await expect(format).toContainText("English (Philippines)");
    await page
      .getByRole("combobox", { name: "Regional format", exact: true })
      .click();
    await expect(page.getByRole("dialog").getByRole("option")).toHaveText([
      "English (Australia)",
      "English (Canada)",
      "English (Europe)",
      "English (India)",
      "English (Ireland)",
      "English (New Zealand)",
      "English (Philippines)",
      "English (Singapore)",
      "English (South Africa)",
      "English (UK)",
      "English (US)",
    ]);
    await page.keyboard.press("Escape");
    // The closing popup's search box shares the field name until it unmounts.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await chooseRegionalOption(
      page,
      "Regional format",
      "Ireland",
      "English (Ireland)",
    );
    await chooseRegionalOption(
      page,
      "Timezone",
      "New York",
      /UTC-04:00.*America\/New York/,
    );
    await chooseRegionalOption(page, "Currency", "Yen", /JPY.*Yen/);
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(
      page.getByText("Organization settings saved.", { exact: true }),
    ).toBeVisible();
    expect(workspace.patches).toEqual([
      {
        revision: 4,
        locale: "en-IE",
        timezone: "America/New_York",
        currency: "JPY",
      },
    ]);
    await page.reload();
    await expect(format).toContainText("English (Ireland)");
    await expect(
      page.getByRole("combobox", { name: "Timezone", exact: true }),
    ).toContainText("America/New York");
    await expect(
      page.getByRole("combobox", { name: "Currency", exact: true }),
    ).toContainText("JPY");
    await expect(
      page.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeDisabled();
  });

  test("regional choices retain saved aliases and current currency without a command, and support keyboard dismissal", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-01-01T12:00:00Z") });
    const workspace = installWorkspaceRoute(page, {
      ...initialWorkspace,
      locale: "fr-CA",
      timezone: "US/Eastern",
      currency: "XAU",
    });
    await page.goto("/manage?view=organization");
    const format = page.getByRole("combobox", {
      name: "Regional format",
      exact: true,
    });
    const timezone = page.getByRole("combobox", {
      name: "Timezone",
      exact: true,
    });
    const currency = page.getByRole("combobox", {
      name: "Currency",
      exact: true,
    });
    await expect(format).toContainText("Canadian French");
    await expect(timezone).toContainText("US/Eastern");
    await expect(timezone).toContainText("UTC-05:00");
    await expect(currency).toContainText("XAU");
    await expect(currency).toContainText(/current/i);
    await timezone.focus();
    await page.keyboard.press("Enter");
    const search = page.getByRole("dialog").getByRole("combobox");
    await expect(search).toBeFocused();
    await search.fill("UTC");
    await expect(
      page.getByRole("option", { name: /^UTC\+00:00.*UTC$/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page
        .getByRole("region", { name: "Organization settings", exact: true })
        .getByRole("combobox", { name: "Timezone", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeDisabled();
    expect(workspace.patches).toEqual([]);
  });
});

test("Manage organization keeps all its draft fields after a failed save", async ({
  page,
}) => {
  const workspace = installWorkspaceRoute(page);
  let failNextPatch = true;
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "PATCH" && failNextPatch) {
      failNextPatch = false;
      await route.fulfill({
        status: 503,
        json: { detail: { code: "workspace_unavailable" } },
      });
    } else await route.fallback();
  });
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  const mark = page.getByRole("textbox", {
    name: "Organization mark",
    exact: true,
  });
  const currency = page.getByRole("combobox", {
    name: "Currency",
    exact: true,
  });
  const week = page.getByRole("combobox", {
    name: "Week starts on",
    exact: true,
  });
  const hours = page.getByRole("textbox", {
    name: "Business hours",
    exact: true,
  });
  await expect(name).toHaveValue("Riverside Services");
  await name.fill("Pending workspace");
  await mark.fill("HOP");
  await chooseRegionalOption(page, "Currency", "USD", /USD.*US Dollar/);
  await week.selectOption("Sunday");
  await hours.fill("10:00–19:00");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The settings could not be saved. Try again." }),
  ).toBeVisible();
  await expect(name).toHaveValue("Pending workspace");
  await expect(mark).toHaveValue("HOP");
  await expect(currency).toContainText("USD");
  await expect(week).toHaveValue("Sunday");
  await expect(hours).toHaveValue("10:00–19:00");
  expect(workspace.patches).toEqual([]);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(name).toHaveValue("Pending workspace");
  await expect(mark).toHaveValue("HOP");
  await expect(currency).toContainText("USD");
  await expect(week).toHaveValue("Sunday");
  await expect(hours).toHaveValue("10:00–19:00");
});

test("Manage preserves section drafts without saving on leave or discard, validates saves, and retains accepted settings after reload", async ({
  page,
}) => {
  const workspace = installWorkspaceRoute(page);
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toBeVisible();
  const original = await name.inputValue();
  await name.fill("Refactor journey workspace");
  const currency = page.getByRole("combobox", {
    name: "Currency",
    exact: true,
  });
  const mark = page.getByRole("textbox", {
    name: "Organization mark",
    exact: true,
  });
  const week = page.getByRole("combobox", {
    name: "Week starts on",
    exact: true,
  });
  const hours = page.getByRole("textbox", {
    name: "Business hours",
    exact: true,
  });
  await chooseRegionalOption(page, "Currency", "USD", /USD.*US Dollar/);
  await mark.fill("HOP");
  await week.selectOption("Sunday");
  await hours.fill("10:00–19:00");
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(name).toHaveValue("Refactor journey workspace");
  await expect(currency).toContainText("USD");
  await expect(mark).toHaveValue("HOP");
  await expect(week).toHaveValue("Sunday");
  await expect(hours).toHaveValue("10:00–19:00");
  expect(workspace.patches).toEqual([]);
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(name).toHaveValue(original);
  await expect(currency).toContainText("PHP");
  await expect(mark).toHaveValue("RS");
  await expect(week).toHaveValue("Monday");
  await expect(hours).toHaveValue("09:00–18:00");
  expect(workspace.patches).toEqual([]);
  await name.fill(" ");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveValue(" ");
  await name.fill("Accepted journey workspace");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(name).toHaveValue("Accepted journey workspace");
});

test("Updates and licensing share a real read-only destination and never simulate upgrades or licenses", async ({
  page,
}) => {
  const state = await mockManageBackups(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      writes.push(new URL(request.url()).pathname);
  });
  await page.goto("/manage?view=licensing");
  await expect(
    page.getByRole("heading", { level: 1, name: "Updates & licensing" }),
  ).toBeVisible();
  // One summary of label-left rows holds the version and the license.
  const software = page.getByRole("region", {
    name: "Installation",
    exact: true,
  });
  const license = software;
  await expect(software.getByRole("term")).toHaveText([
    "Version",
    "Release check",
    "License",
    "Limits",
  ]);
  await expect(software.getByRole("definition")).toHaveText([
    "0.1.0 · Stable channel",
    /^Release information unavailable/,
    "No license required · Self-hosted",
    "None · capacity depends on your server",
  ]);
  await expect(
    page.getByRole("heading", { name: /Software version|License & usage/ }),
  ).toHaveCount(0);
  await expect(software).toContainText("Release information unavailable");
  await expect(license).toContainText("No license required");
  await expect(
    license.getByText(
      /Sample license|Activate license|Renew license|Team|Business/,
    ),
  ).toHaveCount(0);
  await expect(
    software.getByRole("button", {
      name: /Review update|Roll back update|Confirm update/,
    }),
  ).toHaveCount(0);
  const refreshed = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/version",
  );
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await refreshed;
  await expect(software).toContainText("Release information unavailable");
  await expect(
    software.getByRole("link", {
      name: "Update procedure for this release",
      exact: true,
    }),
  ).toHaveAttribute(
    "href",
    "https://github.com/jayeuse/openslate/blob/main/infra/supabase/README.md#operator-updates",
  );
  state.version = {
    current_version: "0.1.0",
    status: "available",
    latest_version: "0.2.0",
    observed_at: "2026-10-08T04:00:00Z",
    checked_at: "2026-10-08T04:00:00Z",
    failure_code: null,
    release_url: "https://github.com/jayeuse/openslate/releases/tag/v0.2.0",
  };
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(software).toContainText("Version 0.2.0 is available");
  await expect(
    software.getByRole("link", { name: "Release notes", exact: true }),
  ).toHaveAttribute("href", state.version.release_url!);
  await page.reload();
  await expect(software).toContainText("Version 0.2.0 is available");
  await page.goto("/manage?view=updates");
  await expect(software).toBeVisible();
  await expect(license).toContainText("No license required");
  expect(writes).toEqual([]);
});

test("Recorded version loading, denial, stale and current observations remain honest on refresh", async ({
  page,
}) => {
  const state = await mockManageBackups(page);
  state.versionReadStatus = 503;
  await page.goto("/manage?view=updates");
  const software = page.getByRole("region", {
    name: "Installation",
    exact: true,
  });
  await expect(software).toContainText("Version status could not be loaded");
  await expect(software.getByText("1.4.2", { exact: true })).toHaveCount(0);
  state.versionReadStatus = 200;
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(
    software.getByText("0.1.0 · Stable channel", { exact: true }),
  ).toBeVisible();
  state.version.status = "stale";
  state.version.latest_version = "0.2.0";
  state.version.observed_at = "2026-10-01T00:00:00Z";
  await sendOpenViewEvent(page, "invalidate", { entity: "update_statuses" });
  await expect(software).toContainText("Release information is stale");
  await expect(software.getByText("Up to date", { exact: true })).toHaveCount(
    0,
  );
  state.versionReadStatus = 403;
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(software).toContainText(
    "Only administrators can review version status",
  );
  await expect(
    software.getByText("0.1.0 · Stable channel", { exact: true }),
  ).toHaveCount(0);
  state.versionReadStatus = 200;
  state.version.status = "current";
  state.version.latest_version = "0.1.0";
  state.version.failure_code = null;
  state.version.observed_at = "2026-10-08T04:00:00Z";
  // While the release check runs, Refresh waits and says so.
  const held = heldResponse();
  await page.route("**/api/version", async (route) => {
    held.enter();
    await held.released;
    await route.fallback();
  });
  const refresh = software.getByRole("button", {
    name: "Refresh release status",
    exact: true,
  });
  await refresh.click();
  try {
    await held.entered;
    await expect(refresh).toBeDisabled();
    await expect(software.getByRole("status")).toHaveText(
      "Checking release status…",
    );
  } finally {
    held.release();
  }
  await expect(software.getByText("Up to date", { exact: true })).toBeVisible();
  await expect(software.getByRole("status")).toHaveCount(0);
  await expect(software).toContainText("Release check");
});

test("Organization Larger text reflows at 1024 and phone widths with all settings reachable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("openslate-text-size", "125");
    localStorage.setItem("openslate-density", "spacious");
  });
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/manage?view=organization");
    const name = page.getByRole("textbox", {
      name: "Organization name",
      exact: true,
    });
    await expect(name).toHaveValue("Riverside Services");
    const settings = page.getByRole("region", {
      name: "Organization settings",
      exact: true,
    });
    const controls = settings
      .getByRole("textbox")
      .or(settings.getByRole("combobox"));
    const boxes = await controls.evaluateAll((elements) =>
      elements
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => {
          const box = el.getBoundingClientRect();
          return { x: box.x, right: box.right };
        }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(7);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page
      .getByRole("combobox", { name: "Timezone", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("combobox", { name: "Timezone", exact: true }),
    ).toBeInViewport();
  }
});

// The Organization relayout (MD4, MD5 in docs/specs/manage-relayout.md):
// label-left groups, a pinned footer, a still page from 1280px, and a reader
// who sees plain text.
const settingsPanel = (page: Page) =>
  page.getByRole("region", { name: "Organization settings", exact: true });
const settingsActions = (page: Page) =>
  page.getByRole("group", { name: "Organization actions", exact: true });

test("Organization settings read as label-left rows in Identity, Region and Look at 1440", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/manage?view=organization");
  const settings = settingsPanel(page);
  for (const group of ["Identity", "Region", "Look"])
    await expect(
      settings.getByRole("heading", { level: 2, name: group, exact: true }),
    ).toBeVisible();
  for (const [label, control] of [
    ["Name", settings.getByRole("textbox", { name: "Organization name" })],
    ["Currency", settings.getByRole("combobox", { name: "Currency" })],
  ] as const) {
    // The row label comes first; a search select keeps its own hidden one.
    const labelBox = (await settings
      .locator("label")
      .getByText(label, { exact: true })
      .first()
      .boundingBox())!;
    const controlBox = (await control.boundingBox())!;
    expect(labelBox.x + labelBox.width, label).toBeLessThan(controlBox.x);
    expect(
      Math.abs(
        labelBox.y +
          labelBox.height / 2 -
          (controlBox.y + controlBox.height / 2),
      ),
      label,
    ).toBeLessThan(8);
  }
  // Each Region row holds one control whose name contains its visible label.
  const labels = settings
    .getByRole("group", { name: "Region", exact: true })
    .locator("label[for]:not([data-slot])");
  await expect(labels).toHaveText([
    "Format",
    "Timezone",
    "Currency",
    "Week starts",
    "Business hours",
  ]);
  for (const label of await labels.all()) {
    const text = (await label.textContent()) ?? "";
    await expect(
      page.locator(`[id="${await label.getAttribute("for")}"]`),
      text,
    ).toHaveAccessibleName(new RegExp(text, "i"));
  }
  // Four look tiles fit across at 1440, each swatch whole.
  const tiles = settings
    .getByRole("radiogroup", { name: "Organization look" })
    .locator("label");
  const tops = await tiles.evaluateAll((all) =>
    all.map((tile) => Math.round(tile.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
  expect(
    await tiles
      .locator("span:not(.sr-only)")
      .evaluateAll(
        (parts) =>
          parts.filter((part) => part.scrollWidth > part.clientWidth).length,
      ),
  ).toBe(0);
  await expect(
    settings.getByRole("textbox", { name: "Business hours" }),
  ).toHaveAccessibleDescription(
    "Use 24-hour time and a dash, for example 09:00–18:00.",
  );
});

test("Organization keeps the page still at 1280 by 720 while its settings panel scrolls under a pinned footer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/manage?view=organization");
  const save = settingsActions(page).getByRole("button", {
    name: "Save settings",
  });
  await expect(save).toBeInViewport();
  // The timezone reads in full at the narrower width.
  expect(
    await settingsPanel(page)
      .getByRole("combobox", { name: "Timezone" })
      .locator("span")
      .first()
      .evaluate((value) => value.scrollWidth > value.clientWidth),
  ).toBe(false);
  // Each look tile shows its whole swatch, text included, at 1280.
  expect(
    await page
      .getByRole("radiogroup", { name: "Organization look" })
      .locator("label, label span:not(.sr-only)")
      .evaluateAll(
        (parts) =>
          parts.filter((part) => part.scrollWidth > part.clientWidth).length,
      ),
  ).toBe(0);
  const profile = settingsPanel(page).getByRole("button", { name: /^Profile/ });
  await profile.scrollIntoViewIfNeeded();
  await expect(profile).toBeInViewport();
  await expect(save).toBeInViewport();
  expect(
    await page.evaluate(() => ({
      document:
        document.documentElement.scrollHeight -
        document.documentElement.clientHeight,
      scrolled: window.scrollY,
    })),
  ).toEqual({ document: 0, scrolled: 0 });
});

test("Organization footer offers Discard only for a draft, says why Save waits, and shows a save error in place", async ({
  page,
}) => {
  await page.goto("/manage?view=organization");
  const actions = settingsActions(page);
  const save = actions.getByRole("button", { name: "Save settings" });
  await expect(actions.getByRole("status")).toHaveText("Saved");
  await expect(
    actions.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(save).toHaveAccessibleDescription("No changes to save.");

  await page.route("**/api/workspace", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { detail: "Unavailable" } })
      : route.fallback(),
  );
  const name = page.getByRole("textbox", { name: "Organization name" });
  await name.fill("Riverside Field Services");
  await expect(actions.getByRole("status")).toHaveText("1 unsaved change");
  await expect(save).not.toHaveAttribute("aria-disabled", "true");
  await save.click();
  await expect(actions.getByRole("alert")).toHaveText(
    "The settings could not be saved. Try again.",
  );
  await expect(name).toHaveValue("Riverside Field Services");
  await actions.getByRole("button", { name: "Discard changes" }).click();
  await expect(name).toHaveValue("Riverside Services");
  await expect(
    actions.getByRole("button", { name: "Discard changes" }),
  ).toHaveCount(0);
});

test("a member reads Organization as plain text with one look tile and no footer", async ({
  page,
}) => {
  installWorkspaceRoute(page, {
    ...initialWorkspace,
    mark: "",
    legal_name: "Riverside Services Ltd",
    theme: "stockroom",
  });
  await signedInAs(page, {
    id: "00000000-0000-4000-8000-000000000301",
    role: "member",
  });
  await page.goto("/manage?view=organization");
  const settings = settingsPanel(page);
  const value = (label: string) =>
    settings.locator(`dt:text-is("${label}") + dd`);
  await expect(value("Name")).toHaveText("Riverside Services");
  await expect(value("Mark")).toHaveText("Not set");
  await expect(value("Currency")).toHaveText("PHP · Philippine Peso");
  await expect(value("Legal name")).toHaveText("Riverside Services Ltd");
  await expect(value("Contact phone")).toHaveText("Not set");
  await expect(settings.getByRole("textbox")).toHaveCount(0);
  await expect(settings.getByRole("combobox")).toHaveCount(0);
  const look = settings.getByRole("group", { name: "Look", exact: true });
  await expect(look.getByText("Stockroom", { exact: true })).toBeVisible();
  await expect(look.getByRole("radio")).toHaveCount(0);
  await expect(settingsActions(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(
    0,
  );
});

test("Organization on a phone stacks labels above fields and keeps the footer at the bottom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/manage?view=organization");
  const settings = settingsPanel(page);
  const labelBox = (await settings
    .locator("label")
    .getByText("Name", { exact: true })
    .boundingBox())!;
  const nameBox = (await settings
    .getByRole("textbox", { name: "Organization name" })
    .boundingBox())!;
  expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(nameBox.y);
  const save = settingsActions(page).getByRole("button", {
    name: "Save settings",
  });
  await expect(save).toBeInViewport();
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // The shared Advanced header (here "Profile") is a 44px target below 1280.
  const profile = settings.getByRole("button", { name: /^Profile/ });
  await profile.scrollIntoViewIfNeeded();
  expect((await profile.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(save).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
