import { expect, test } from "./helpers/test";
import type { Page } from "./helpers/test";

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
      revision: current.revision + 1,
    };
    await route.fulfill({ json: current });
  });
  return { patches, read: () => current };
}

test.beforeEach(async ({ page }) => {
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

test("Manage organization reads and patches only the server-backed workspace fields", async ({
  page,
}) => {
  const workspace = installWorkspaceRoute(page, {
    ...initialWorkspace,
    display_name: "Harbor workspace",
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
  await expect(
    page.getByRole("note", { name: "Organization data", exact: true }),
  ).toHaveText(
    "Organization Name, locale and timezone save to the organization. Mark, currency, week start and business hours are examples; their changes last until this tab closes.",
  );
  await expect(name).toHaveValue("Harbor workspace");
  await expect(locale).toHaveValue("en-PH");
  await expect(locale.locator("option:checked")).toHaveText(
    "English (Philippines)",
  );
  await expect(timezone).toHaveValue("Asia/Manila");

  await name.fill("Harbor operations");
  await locale.selectOption("Filipino");
  await timezone.selectOption("UTC");
  await page
    .getByRole("combobox", { name: "Currency", exact: true })
    .selectOption("USD");
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
    },
  ]);
  await page.reload();
  await expect(name).toHaveValue("Harbor operations");
  await expect(
    page.getByRole("combobox", { name: "Currency", exact: true }),
  ).toHaveValue("USD");
  expect(workspace.read().locale).toBe("fil-PH");
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

test("Manage organization reports server success separately when saving example fields fails", async ({
  page,
}) => {
  const workspace = installWorkspaceRoute(page);
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  const currency = page.getByRole("combobox", {
    name: "Currency",
    exact: true,
  });
  await expect(name).toHaveValue("Riverside Services");
  await name.fill("Server name saved once");
  await currency.selectOption("USD");
  // A real browser dependency fails only while publishing proposed sample
  // settings. The runtime handles the failure; no controller hook is exposed.
  await page.evaluate(() => {
    const clone = window.structuredClone;
    window.structuredClone = (value, options) => {
      if (
        value &&
        typeof value === "object" &&
        "currency" in value &&
        value.currency === "USD" &&
        "name" in value
      ) {
        window.structuredClone = clone;
        throw new DOMException(
          "Synthetic sample save unavailable",
          "DataCloneError",
        );
      }
      return clone(value, options);
    };
  });
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Name, locale and timezone saved." }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Example fields could not be saved." }),
  ).toContainText(
    "Example fields could not be saved. Your example edits are still pending.",
  );
  await expect(name).toHaveValue("Server name saved once");
  await expect(currency).toHaveValue("USD");
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeEnabled();
  expect(workspace.patches).toEqual([
    { revision: 4, display_name: "Server name saved once" },
  ]);
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard changes", exact: true }),
  ).toBeDisabled();
  expect(workspace.patches).toHaveLength(1);
  await page.reload();
  await expect(name).toHaveValue("Server name saved once");
  await expect(currency).toHaveValue("USD");
});

test("Manage preserves section drafts, validates saves, and retains accepted settings after reload", async ({
  page,
}) => {
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toBeVisible();
  const original = await name.inputValue();
  await name.fill("Refactor journey workspace");
  await page
    .getByRole("link", { name: "Security & recovery", exact: true })
    .click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(name).toHaveValue("Refactor journey workspace");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(name).toHaveValue(original);
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

test("Manage reset cancellation retains drafts and confirmation requires draft acknowledgement", async ({
  page,
}) => {
  await page.goto("/manage?view=organization");
  const name = page.getByRole("textbox", {
    name: "Organization name",
    exact: true,
  });
  await expect(name).toBeVisible();
  const original = await name.inputValue();
  await name.fill("Keep this draft");
  const options = page.getByRole("button", {
    name: "Manage options",
    exact: true,
  });
  await options.click();
  const reset = page.getByRole("menuitem", {
    name: "Reset Manage",
    exact: true,
  });
  await reset.click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", {
    name: "Reset Manage configuration",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(name).toHaveValue("Keep this draft");
  await expect(options).toBeFocused();
  await options.click();
  await reset.click();
  await dialog
    .getByRole("checkbox", { name: "Discard affected unsaved drafts" })
    .check();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(name).toHaveValue(original);
});

test("Manage snapshot rename retains invalid input, restores focus on cancel, and persists an accepted name", async ({
  page,
}) => {
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", { name: "Inspect Scheduled snapshot", exact: true })
    .click();
  const opener = page.getByRole("button", {
    name: "Snapshot actions",
    exact: true,
  });
  await opener.click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Rename snapshot",
    exact: true,
  });
  const name = dialog.getByRole("textbox", {
    name: "Snapshot name",
    exact: true,
  });
  const submit = dialog.getByRole("button", {
    name: "Rename snapshot",
    exact: true,
  });
  await name.fill("");
  await expect(submit).toBeDisabled();
  await name.fill("After workspace setup");
  await submit.click();
  await expect(
    dialog.getByText("A snapshot already uses this name.", { exact: true }),
  ).toBeVisible();
  await expect(name).toHaveValue("After workspace setup");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(name).toHaveValue("Scheduled snapshot");
  await name.fill("Renamed journey snapshot");
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: "Inspect Renamed journey snapshot",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Inspect Renamed journey snapshot",
      exact: true,
    }),
  ).toBeVisible();
});

test("Updates and licensing share one destination without bypassing confirmations", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET")
      writes.push(request.url());
  });
  await page.goto("/manage?view=licensing");
  await expect(
    page.getByRole("heading", { level: 1, name: "Updates & licensing" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Updates & licensing", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("link", { name: "Licensing", exact: true }),
  ).toHaveCount(0);
  const software = page.getByRole("region", {
    name: "Software version",
    exact: true,
  });
  const license = page.getByRole("region", {
    name: "License & usage",
    exact: true,
  });
  await expect(software).toBeVisible();
  await expect(license).toBeVisible();
  await software
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await software
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("No software is installed.");
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(software.getByText("1.4.2", { exact: true })).toBeVisible();
  await software
    .getByRole("button", { name: "Review update", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Confirm update", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(software.getByText("1.5.0", { exact: true })).toBeVisible();

  await license.getByText("Activate license", { exact: true }).click();
  await license
    .getByRole("combobox", { name: "Bundled license key", exact: true })
    .selectOption("SAMPLE-BUSINESS-2026");
  await license.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(confirmation).toContainText(
    "No payment or license service will be contacted.",
  );
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(license.getByText("Team", { exact: true })).toBeVisible();
  await license.getByRole("button", { name: "Continue", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "Confirm activation", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(license.getByText("Business", { exact: true })).toBeVisible();
  await page.reload();
  await expect(software.getByText("1.5.0", { exact: true })).toBeVisible();
  await expect(license.getByText("Business", { exact: true })).toBeVisible();
  await software
    .getByRole("button", { name: "Roll back update", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Confirm rollback", exact: true })
    .click();
  await expect(software.getByText("1.4.2", { exact: true })).toBeVisible();
  await page.goto("/manage?view=updates");
  await expect(license.getByText("Business", { exact: true })).toBeVisible();
  await expect(software).toBeVisible();
  expect(writes).toEqual([]);
});
