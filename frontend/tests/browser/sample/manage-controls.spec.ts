import { expect, test } from "../coverage";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "../coverage";
import { initialManageSettings } from "../../../src/components/sample/manage/state";
import { initialPeople } from "../../../src/components/sample/access/model";

async function openSection(page: Page, name: string) {
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page
      .getByLabel("Manage section", { exact: true })
      .selectOption(name.toLowerCase());
  } else {
    await page.getByRole("tab", { name, exact: true }).click();
  }
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
});

test("Audit fits the desktop viewport with a compact filter toolbar and repaired legacy copy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2558, height: 1213 });
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "manage-activity-v1": Array.from({ length: 8 }, (_, index) => ({
          id: `legacy-manage-action-${index}`,
          user: "Sample administrator",
          date: `2026-09-${String(12 - index).padStart(2, "0")}T12:52:40.543Z`,
          entity: index % 2 ? "Configuration snapshots" : "Licensing",
          action: index % 2 ? "Restore" : "Renew",
          target: index % 2 ? "Manual snapshot" : "Sample license",
          before: index % 2 ? "Before restore" : "2027-09-11",
          after:
            index % 2
              ? "Restored sample snapshot."
              : "Sample license renewed for one year.",
          source: "manage",
        })),
      }),
    );
  });
  await page.goto("/manage?view=audit");
  await expect(page.locator("#audit-heading")).toBeVisible();

  const filterCard = page
    .getByRole("heading", { name: "Filter activity", exact: true })
    .locator("..")
    .locator("..");
  const filterHeight = await filterCard.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect.soft(filterHeight).toBeLessThanOrEqual(128);
  expect.soft(await page.getByRole("main").innerText()).not.toMatch(/sample/i);
  expect
    .soft(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= window.innerHeight + 1,
      ),
    )
    .toBe(true);
});

test("Audit keeps visible labels and touch-sized filters on narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto("/manage?view=audit");
  await expect(
    page.getByText("Search activity", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Audit user", { exact: true })).toBeVisible();
  expect(
    await page
      .getByLabel("Search activity", { exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

test("Manage presents realistic paginated data with compact, non-scrolling sections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/manage?view=organization");
  const main = page.getByRole("main");
  await expect(main).not.toContainText(/sample/i);

  for (const section of [
    "Organization",
    "Security",
    "Audit",
    "Backup",
    "Updates",
    "Licensing",
  ]) {
    await openSection(page, section);
    const heading = {
      Organization: "Organization",
      Security: "Security policies",
      Audit: "Activity history",
      Backup: "Backup & recovery",
      Updates: "Updates",
      Licensing: "License & usage",
    }[section];
    await expect(page).toHaveURL(new RegExp(`view=${section.toLowerCase()}`));
    await expect(
      main.getByRole("heading", { name: heading, exact: true }).first(),
    ).toBeVisible();
    const activeSection = main.locator("section").first();
    await expect(activeSection).toBeVisible();
    const viewportFit = await page.evaluate(() => ({
      fits: document.documentElement.scrollHeight <= window.innerHeight + 1,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }));
    expect(
      viewportFit.fits,
      `${section} should fit the ${viewportFit.viewportHeight}px desktop viewport; rendered height was ${viewportFit.scrollHeight}px`,
    ).toBe(true);
  }

  await openSection(page, "Security");
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(
    page.getByRole("navigation", { name: "Session pages" }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) >= 768) {
    const searchHeight = await page
      .getByLabel("Search sessions", { exact: true })
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(searchHeight).toBeLessThanOrEqual(40);
  }

  await openSection(page, "Audit");
  await expect(page.getByText("Showing 1–5 of 10 entries")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Activity pages" }),
  ).toBeVisible();

  await openSection(page, "Backup");
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(
    page.getByRole("navigation", { name: "Snapshot pages" }),
  ).toBeVisible();

  const scrollingTables = await main
    .locator('[data-slot="table-container"]')
    .evaluateAll((containers) =>
      containers.flatMap((container, index) =>
        container.scrollHeight > container.clientHeight ||
        container.scrollWidth > container.clientWidth
          ? [
              {
                index,
                clientWidth: container.clientWidth,
                scrollWidth: container.scrollWidth,
                clientHeight: container.clientHeight,
                scrollHeight: container.scrollHeight,
              },
            ]
          : [],
      ),
    );
  expect(scrollingTables).toEqual([]);
});

test("audit details and exports never expose sample-prefixed identifiers", async ({
  page,
}) => {
  await page.goto("/manage?view=audit");
  await page
    .getByRole("button", { name: "View audit WO-1042", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Audit entry detail", exact: true }),
  ).not.toContainText(/sample/i);
  await page.keyboard.press("Escape");

  await page
    .getByRole("button", { name: "Export audit preview", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const csv = await readFile((await (await downloading).path()) ?? "", "utf8");
  expect(csv).not.toMatch(/sample/i);
});

test("legacy release history is repaired before it is displayed", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "manage-history": [
          "Installed sample version 1.4.2",
          "Applied sample release 1.5.0",
        ],
      }),
    );
  });
  await page.goto("/manage?view=updates");
  await expect(
    page.getByText("Installed version 1.4.2", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Applied release 1.5.0", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(/sample/i);
});

test("activity search filters the downloadable CSV and invalid dates block exports", async ({
  page,
}) => {
  await page.goto("/manage?view=audit");
  await page.getByLabel("Search activity", { exact: true }).fill("EQ-0028");
  await expect(
    page.getByRole("button", { name: "View audit EQ-0028", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View audit WO-1042", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Export audit preview", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  const csv = await readFile(path ?? "", "utf8");
  expect(csv).toContain("EQ-0028");
  expect(csv).not.toContain("WO-1042");
  await page.keyboard.press("Escape");
  await page.getByLabel("From date", { exact: true }).fill("2026-09-12");
  await page.getByLabel("To date", { exact: true }).fill("2026-09-01");
  await expect(
    page.getByRole("button", { name: "Export audit preview", exact: true }),
  ).toBeDisabled();
});

test("Manage drafts survive section changes and reload without committing unrelated settings", async ({
  page,
}) => {
  await page.goto("/manage");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Unfinished organization");
  await openSection(page, "Security");
  await page
    .getByLabel("Two-factor authentication", { exact: true })
    .selectOption("Required for everyone");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await openSection(page, "Organization");
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Unfinished organization");
  await page.reload();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Unfinished organization");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Riverside Services");
  await page.goto("/manage?view=security");
  await expect(
    page.getByLabel("Two-factor authentication", { exact: true }),
  ).toHaveValue("Required for everyone");
});

test("Manage section history, keyboard navigation, and light/dark layouts remain accessible", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/manage");
  await openSection(page, "Security");
  await expect(page).toHaveURL(/view=security/);
  await openSection(page, "Backup");
  await expect(page).toHaveURL(/view=backup/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Security policies", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/view=backup/);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.classList.toggle("dark", value === "dark");
    }, theme);
    for (const section of [
      "Organization",
      "Security",
      "Audit",
      "Backup",
      "Updates",
      "Licensing",
    ]) {
      await openSection(page, section);
      await expect(page).toHaveURL(new RegExp(`view=${section.toLowerCase()}`));
      const result = await new AxeBuilder({ page })
        .include("main")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(result.violations, `${theme} ${section}`).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`${theme}-${section.toLowerCase()}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 1280);
    }
  }
  if ((page.viewportSize()?.width ?? 1280) >= 768) {
    await page.getByRole("tab", { name: "Organization", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "Security", exact: true }),
    ).toBeFocused();
  }
});

test("Manage preserves drafts when browser storage fails and explains persistence limits", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Unavailable", "QuotaExceededError");
    };
  });
  await page.goto("/manage");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Memory only");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Memory only");
  await expect(
    page.getByText(/Changes cannot be saved in this browser/),
  ).toBeVisible();
});

test("ending a sample session stays consistent with Access and never signs out", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (/\/bff\/|\/session\//.test(request.url()) && request.method() !== "GET")
      writes.push(request.url());
  });
  await page.goto("/manage?view=security");
  await page
    .getByRole("button", { name: "End session · Eli", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm end session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Current session", { exact: true }),
  ).toBeVisible();
  await page.goto("/access?view=identities");
  await page.getByLabel("Search identities", { exact: true }).fill("Eli Cruz");
  await page
    .getByRole("button", { name: "Manage Eli Cruz", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Disable identity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Revoke Mobile · Chrome · Quezon City",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Disable identity", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review lifecycle impact" })
    .getByRole("button", { name: "Continue to name confirmation" })
    .click();
  const confirmation = page.getByRole("dialog", { name: "Disable identity?" });
  await confirmation
    .getByLabel("Identity name", { exact: true })
    .fill("Eli Cruz");
  await confirmation
    .getByRole("button", { name: "Disable identity", exact: true })
    .click();
  await page.goto("/manage?view=security");
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Current session", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("configuration snapshots download, recover saved settings, and explicitly discard drafts", async ({
  page,
}) => {
  await page.goto("/manage?view=backup");
  await page.getByLabel("Snapshot name", { exact: true }).fill("Before change");
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore Before change", exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download Before change", exact: true })
    .click();
  const path = await (await downloaded).path();
  const exported = JSON.parse(await readFile(path ?? "", "utf8"));
  expect(exported).toMatchObject({
    format: "openslate.manage.sample",
    version: 1,
    snapshot: {
      name: "Before change",
      settings: { name: "Riverside Services" },
    },
  });
  expect(exported.snapshot).not.toHaveProperty("sessions");
  await openSection(page, "Organization");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Saved organization");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Unfinished newer draft");
  await openSection(page, "Backup");
  await page
    .getByRole("button", { name: "Restore Before change", exact: true })
    .click();
  const restore = page.getByRole("alertdialog");
  await expect(restore).toContainText("Saved organization");
  await expect(restore).toContainText("Riverside Services");
  await expect(
    restore.getByRole("button", {
      name: "Confirm restore",
      exact: true,
    }),
  ).toBeDisabled();
  await restore
    .getByRole("checkbox", {
      name: "Discard affected unsaved drafts",
      exact: true,
    })
    .check();
  await restore
    .getByRole("button", { name: "Confirm restore", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restore Before restore", exact: true }),
  ).toBeVisible();
  await openSection(page, "Organization");
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Riverside Services");
  await openSection(page, "Backup");
  await page
    .getByRole("button", { name: "Restore Before restore", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm restore", exact: true })
    .click();
  await openSection(page, "Organization");
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Saved organization");
});

test("settings comparisons paginate instead of creating a scrolling table", async ({
  page,
}) => {
  await page.addInitScript((defaults) => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "manage-backups": [
          {
            id: "many-differences",
            name: "Regional policy migration",
            date: "2026-09-12T08:00:00Z",
            settings: {
              ...defaults,
              name: "Harborline Operations",
              logo: "Compass",
              locale: "English (US)",
              timezone: "UTC",
              currency: "USD",
              week: "Sunday",
              hours: "08:00–17:00",
            },
          },
        ],
      }),
    );
  }, initialManageSettings);
  await page.goto("/manage?view=backup");
  await page
    .getByRole("button", {
      name: "Restore Regional policy migration",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("row")).toHaveCount(6);
  await expect(
    dialog.getByRole("navigation", { name: "Settings change pages" }),
  ).toBeVisible();
  expect(
    await dialog
      .locator('[data-slot="table-container"]')
      .evaluate(
        (container) => container.scrollHeight <= container.clientHeight,
      ),
  ).toBe(true);
});

test("snapshot rename/delete and configuration reset keep usable focus and unrelated sample state", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("openslate.sample.v1")) return;
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({ "untouched-sample-domain": { marker: "keep" } }),
    );
  });
  await page.goto("/manage?view=backup");
  await page
    .getByLabel("Snapshot name", { exact: true })
    .fill("Temporary checkpoint");
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Rename Temporary checkpoint", exact: true })
    .click();
  const rename = page.getByRole("dialog", {
    name: "Rename snapshot",
    exact: true,
  });
  await rename
    .getByLabel("Snapshot name", { exact: true })
    .fill("Renamed checkpoint");
  await rename
    .getByRole("button", { name: "Rename snapshot", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete Renamed checkpoint", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete Renamed checkpoint", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Restore Renamed checkpoint",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement !== document.body &&
          document.activeElement?.isConnected,
      ),
    )
    .toBe(true);
  await openSection(page, "Organization");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Reset this");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Reset Manage", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Reset this");
  await expect(page.getByRole("alertdialog")).toContainText(
    "Riverside Services",
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Reset Manage configuration", exact: true })
    .click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Riverside Services");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("openslate.sample.v1") ?? "{}")[
          "untouched-sample-domain"
        ],
    ),
  ).toEqual({ marker: "keep" });
  await openSection(page, "Backup");
  await expect(
    page.getByRole("button", {
      name: "Restore Before configuration reset",
      exact: true,
    }),
  ).toBeVisible();
});

test("security search, MFA walkthrough, and bulk session confirmation work without credentials", async ({
  page,
}) => {
  await page.goto("/manage?view=security");
  await page.getByLabel("Search sessions", { exact: true }).fill("Quezon");
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Current session", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Search sessions", { exact: true }).fill("");
  const preview = page.getByRole("button", {
    name: "Preview MFA setup",
    exact: true,
  });
  await preview.click();
  const mfa = page.getByRole("dialog", {
    name: "MFA enrollment preview",
    exact: true,
  });
  await expect(
    mfa.getByRole("heading", { name: "Choose a factor", exact: true }),
  ).toBeVisible();
  await mfa.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    mfa.getByRole("heading", { name: "Verify the factor", exact: true }),
  ).toBeVisible();
  await mfa.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    mfa.getByRole("heading", { name: "Review recovery options", exact: true }),
  ).toBeVisible();
  await expect(mfa.getByRole("textbox")).toHaveCount(0);
  await mfa.getByRole("button", { name: "Done", exact: true }).click();
  await expect(preview).toBeFocused();
  await page
    .getByRole("button", { name: "End all remote sessions", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "End all remote sessions", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: "Confirm end all remote sessions",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "End session · Eli", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Current session", { exact: true }),
  ).toBeVisible();
});

test("Manage recovers malformed stored entries without discarding valid legacy configuration", async ({
  page,
}) => {
  await page.addInitScript((defaults) => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "manage-settings": {
          ...defaults,
          name: "Legacy organization",
          timezone: "Invalid/Zone",
        },
        "manage-backups": [
          {
            id: "legacy",
            name: "Legacy checkpoint",
            date: "9/11/2026, 2:00:00 AM",
            settings: { ...defaults, name: "Legacy backup" },
          },
          { id: "malformed" },
        ],
      }),
    );
  }, initialManageSettings);
  await page.goto("/manage");
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Legacy organization");
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(
    "Asia/Manila",
  );
  await openSection(page, "Backup");
  await expect(
    page.getByRole("button", {
      name: "Restore Legacy checkpoint",
      exact: true,
    }),
  ).toBeVisible();
});

test("invalid regional drafts remain editable without crashing their preview", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "manage-drafts-v1": {
          organization: {
            name: "Keep my draft",
            timezone: "Invalid/Zone",
            currency: "invalid",
          },
        },
      }),
    );
  });
  await page.goto("/manage");
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Keep my draft");
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.getByLabel("Timezone", { exact: true }).selectOption("UTC");
  await page.getByLabel("Currency", { exact: true }).selectOption("USD");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Keep my draft");
});

test("activity pagination and sorting do not limit the downloaded filtered history", async ({
  page,
}) => {
  await page.goto("/manage");
  for (let index = 1; index <= 6; index++) {
    await page
      .getByLabel("Organization name", { exact: true })
      .fill(`Batch ${index}`);
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
  }
  await openSection(page, "Audit");
  await page
    .getByLabel("Audit entity", { exact: true })
    .selectOption("Organization");
  await page
    .getByLabel("Activity order", { exact: true })
    .selectOption("oldest");
  await expect(page.getByRole("button", { name: /^View audit / })).toHaveCount(
    5,
  );
  await expect(
    page.getByRole("button", { name: "View audit Batch 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Go to next page", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^View audit / })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: "View audit Batch 6", exact: true }),
  ).toBeVisible();
  const detailTrigger = page.getByRole("button", {
    name: "View audit Batch 6",
    exact: true,
  });
  await detailTrigger.click();
  const detail = page.getByRole("dialog", {
    name: "Audit entry detail",
    exact: true,
  });
  await expect(detail).toContainText("Organization name: Batch 5");
  await expect(detail).toContainText("Organization name: Batch 6");
  await detail
    .getByRole("button", { name: "Close detail", exact: true })
    .click();
  await expect(detailTrigger).toBeFocused();
  await page
    .getByRole("button", { name: "Export audit preview", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const csv = await readFile((await (await downloading).path()) ?? "", "utf8");
  for (let index = 1; index <= 6; index++)
    expect(csv).toContain(`"Batch ${index}"`);
  expect(csv.indexOf('"Batch 1"')).toBeLessThan(csv.indexOf('"Batch 6"'));
});

test("saved maintenance preferences guide simulation and retention previews without deleting snapshots", async ({
  page,
}) => {
  await page.addInitScript((defaults) => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "manage-backups": [
          {
            id: "old",
            name: "Old checkpoint",
            date: "2020-01-01T00:00:00Z",
            settings: defaults,
          },
        ],
      }),
    );
  }, initialManageSettings);
  await page.goto("/manage?view=backup");
  await page
    .getByLabel("Retention period", { exact: true })
    .selectOption("7 days");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page
    .getByLabel("Retention period", { exact: true })
    .selectOption("90 days");
  await page
    .getByRole("button", { name: "Preview retention candidates", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Retention preview",
    exact: true,
  });
  await expect(preview).toContainText("7 days");
  await expect(preview).toContainText("Old checkpoint");
  await preview
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Simulate scheduled backup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /^Restore Scheduled snapshot ·/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore Old checkpoint", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Backup schedule", { exact: true })
    .selectOption("Disabled");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Simulate scheduled backup",
      exact: true,
    }),
  ).toBeDisabled();
});

test("license usage explains an over-limit preview and terms open as an action", async ({
  page,
}) => {
  await page.addInitScript((person) => {
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({
        "access-people": Array.from({ length: 26 }, (_, index) => ({
          ...person,
          id: `sample-seat-${index}`,
          name: `Sample seat ${index}`,
          active: true,
        })),
      }),
    );
  }, initialPeople[0]);
  await page.goto("/manage?view=licensing");
  await expect(
    page.getByText("User limit exceeded", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "User license usage", exact: true }),
  ).toHaveAttribute("aria-valuetext", "26 active users; 25 seats");
  const terms = page.getByRole("button", {
    name: "View license terms",
    exact: true,
  });
  await terms.click();
  const dialog = page.getByRole("dialog", {
    name: "License terms preview",
    exact: true,
  });
  await expect(dialog).toContainText("Team: 25 users");
  await dialog
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  await expect(terms).toBeFocused();
  await page
    .getByLabel("Bundled license key", { exact: true })
    .selectOption("SAMPLE-BUSINESS-2026");
  await page
    .getByRole("button", { name: "Activate license", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm activation", exact: true })
    .click();
  await expect(
    page.getByText("User limit exceeded", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("progressbar", { name: "User license usage", exact: true }),
  ).toHaveAttribute("aria-valuetext", "26 active users; 100 seats");
});
