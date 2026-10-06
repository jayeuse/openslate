import { expect, test } from "./helpers/test";
import type { Page } from "./helpers/test";
import { mockManageBackups } from "./helpers/manage-backups";
import { mockManageSecurity } from "./helpers/manage-security";
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
  return { patches, read: () => current };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: "00000000-0000-4000-8000-000000000101",
        role: "admin",
        access: [],
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
  const locale = page.getByRole("combobox", { name: "Locale", exact: true });
  const timezone = page.getByRole("combobox", {
    name: "Timezone",
    exact: true,
  });
  const mark = page.getByRole("combobox", {
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
  await expect(mark.locator("option:checked")).toHaveText("No mark");
  await expect(currency).toHaveValue("SGD");
  await expect(week).toHaveValue("Sunday");
  await expect(hours).toHaveValue("08:00–17:00");
  await expect(
    page.getByRole("note", { name: "Organization data", exact: true }),
  ).not.toContainText("are examples");
  await expect(name).toHaveValue("Harbor workspace");
  await expect(locale).toHaveValue("en-PH");
  await expect(locale.locator("option:checked")).toHaveText(
    "English (Philippines)",
  );
  await expect(timezone).toHaveValue("Asia/Manila");

  await name.fill("Harbor operations");
  await locale.selectOption("Filipino");
  await timezone.selectOption("UTC");
  await mark.selectOption("Compass");
  await currency.selectOption("USD");
  await week.selectOption("Monday");
  await hours.fill("10:00–19:00");
  await page.getByRole("button", { name: "Save settings" }).click();

  await expect(name).toHaveValue("Harbor operations");
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(workspace.patches).toEqual([
    {
      revision: 4,
      display_name: "Harbor operations",
      locale: "fil-PH",
      timezone: "UTC",
      mark: "Compass",
      currency: "USD",
      week_start: "monday",
      business_hours: "10:00–19:00",
    },
  ]);
  await page.reload();
  await expect(name).toHaveValue("Harbor operations");
  await expect(
    page.getByRole("combobox", { name: "Currency", exact: true }),
  ).toHaveValue("USD");
  await expect(mark).toHaveValue("Compass");
  await expect(week).toHaveValue("Monday");
  await expect(hours).toHaveValue("10:00–19:00");
  expect(workspace.read()).toMatchObject({
    display_name: "Harbor operations",
    locale: "fil-PH",
    timezone: "UTC",
    mark: "Compass",
    currency: "USD",
    week_start: "monday",
    business_hours: "10:00–19:00",
  });
  await mark.selectOption({ label: "No mark" });
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(workspace.patches[1]).toEqual({ revision: 5, mark: "" });
  await page.reload();
  await expect(mark).toHaveValue("");
  await expect(mark.locator("option:checked")).toHaveText("No mark");
  expect(workspace.read().mark).toBe("");
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
  let reads = 0;
  let allowRead = false;
  await page.route("**/api/workspace", async (route) => {
    reads += 1;
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
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(
    page.getByText("The organization settings could not be loaded.", {
      exact: true,
    }),
  ).toBeVisible();
  const failedReads = reads;
  allowRead = true;
  await page
    .getByRole("button", { name: "Retry organization settings", exact: true })
    .click();
  await expect.poll(() => reads).toBeGreaterThan(failedReads);
  await expect(
    page.getByRole("textbox", { name: "Organization name", exact: true }),
  ).toHaveValue("Riverside Services");
});

test("Manage organization shows readable locale names and sends locale tags", async ({
  page,
}) => {
  const workspace = installWorkspaceRoute(page, {
    ...initialWorkspace,
    locale: "fr-FR",
  });
  await page.goto("/manage?view=organization");
  const locale = page.getByRole("combobox", { name: "Locale", exact: true });
  await expect(locale).toHaveValue("fr-FR");
  await expect(locale.locator("option:checked")).toHaveText("French (France)");
  await locale.selectOption({ label: "English (US)" });
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(workspace.patches).toEqual([{ revision: 4, locale: "en-US" }]);
  await page.reload();
  await expect(locale).toHaveValue("en-US");
  await expect(locale.locator("option:checked")).toHaveText("English (US)");
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
  const mark = page.getByRole("combobox", {
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
  await mark.selectOption("Compass");
  await currency.selectOption("USD");
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
  await expect(mark).toHaveValue("Compass");
  await expect(currency).toHaveValue("USD");
  await expect(week).toHaveValue("Sunday");
  await expect(hours).toHaveValue("10:00–19:00");
  expect(workspace.patches).toEqual([]);
  expect(workspace.read()).toEqual(initialWorkspace);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(workspace.read()).toMatchObject({
    display_name: "Pending workspace",
    mark: "Compass",
    currency: "USD",
    week_start: "sunday",
    business_hours: "10:00–19:00",
  });
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
  const mark = page.getByRole("combobox", {
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
  await currency.selectOption("USD");
  await mark.selectOption("Compass");
  await week.selectOption("Sunday");
  await hours.fill("10:00–19:00");
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(name).toHaveValue("Refactor journey workspace");
  await expect(currency).toHaveValue("USD");
  await expect(mark).toHaveValue("Compass");
  await expect(week).toHaveValue("Sunday");
  await expect(hours).toHaveValue("10:00–19:00");
  expect(workspace.patches).toEqual([]);
  expect(workspace.read()).toEqual(initialWorkspace);
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(name).toHaveValue(original);
  await expect(currency).toHaveValue("PHP");
  await expect(mark).toHaveValue("RS");
  await expect(week).toHaveValue("Monday");
  await expect(hours).toHaveValue("09:00–18:00");
  expect(workspace.patches).toEqual([]);
  expect(workspace.read()).toEqual(initialWorkspace);
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
  ).toBeDisabled();
  await page.reload();
  await expect(name).toHaveValue("Accepted journey workspace");
});

test("Manage organization retains draft controls without the sample Reset Manage action", async ({
  page,
}) => {
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toHaveValue("Riverside Services");
  await expect(
    page.getByRole("button", { name: "Manage options", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Reset Manage", exact: true }),
  ).toHaveCount(0);
  await name.fill("Keep this draft");
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(name).toHaveValue("Riverside Services");
});

test("Backup request name validation and cancel restore focus without any local snapshot mutation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockManageSecurity(page);
  const backup = await mockManageBackups(page);
  await page.goto("/manage?view=backup");
  const opener = page.getByRole("button", { name: "Back up now", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Back up now", exact: true });
  const name = dialog.getByLabel("Backup name", { exact: true });
  const submit = dialog.getByRole("button", {
    name: "Back up now",
    exact: true,
  });
  await name.fill(" ");
  await submit.click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toContainText("Enter a backup name");
  expect(backup.queueRequests).toEqual([]);
  await name.fill("Preserved name");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(backup.queueRequests).toEqual([]);
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
  const software = page.getByRole("region", {
    name: "Software version",
    exact: true,
  });
  const license = page.getByRole("region", {
    name: "License & usage",
    exact: true,
  });
  await expect(software.getByText("0.1.0", { exact: true })).toBeVisible();
  await expect(software).toContainText("Release information unavailable");
  await expect(software.getByText("Up to date", { exact: true })).toHaveCount(
    0,
  );
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
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(software).toContainText("Release information unavailable");
  expect(state.versionReads).toBeGreaterThanOrEqual(2);
  await expect(
    software.getByRole("link", { name: "Update procedure", exact: true }),
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
    name: "Software version",
    exact: true,
  });
  await expect(software).toContainText("Version status could not be loaded");
  await expect(software.getByText("1.4.2", { exact: true })).toHaveCount(0);
  state.versionReadStatus = 200;
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(software.getByText("0.1.0", { exact: true })).toBeVisible();
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
  await expect(software.getByText("0.1.0", { exact: true })).toHaveCount(0);
  state.versionReadStatus = 200;
  state.version.status = "current";
  state.version.latest_version = "0.1.0";
  state.version.failure_code = null;
  state.version.observed_at = "2026-10-08T04:00:00Z";
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(software.getByText("Up to date", { exact: true })).toBeVisible();
  await expect(software).toContainText("Host runner observation");
  state.version.current_version = "2.7.1-development";
  state.version.status = "unknown";
  state.version.latest_version = "2.7.1";
  state.version.observed_at = "2026-10-08T04:00:00Z";
  state.version.checked_at = "2026-10-08T04:01:00Z";
  state.version.release_url =
    "https://github.com/jayeuse/openslate/releases/tag/v2.7.1";
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(
    software.getByText("2.7.1-development", { exact: true }),
  ).toBeVisible();
  await expect(software).toContainText("Version comparison unavailable");
  await expect(software).not.toContainText("No release observation recorded");
  await expect(software.getByText("2.7.1", { exact: true })).toBeVisible();
  await expect(
    software.getByRole("link", { name: "Release notes", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://github.com/jayeuse/openslate/releases/tag/v2.7.1",
  );
  await expect(software.getByText("Up to date", { exact: true })).toHaveCount(
    0,
  );
  state.version.latest_version = null;
  state.version.observed_at = null;
  state.version.checked_at = null;
  state.version.release_url = null;
  await software
    .getByRole("button", { name: "Refresh release status", exact: true })
    .click();
  await expect(software).toContainText("No release observation recorded");
  await expect(
    software.getByText("2.7.1-development", { exact: true }),
  ).toBeVisible();
});

test("leaving Manage with an unsaved organization draft asks before discarding it", async ({
  page,
}) => {
  installWorkspaceRoute(page);
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toHaveValue("Riverside Services");
  await name.fill("Riverside Field Services");

  // Switching Manage sections keeps drafts, so it is not held.
  const leave = page.getByRole("link", { name: /People and groups/ });
  await leave.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Discard unsaved Manage changes?");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/manage\?view=organization/);
  await expect(name).toHaveValue("Riverside Field Services");

  await leave.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(page).toHaveURL(/\/access/);
});
