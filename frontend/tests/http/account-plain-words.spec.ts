import { expect, test, type Page } from "./helpers/test";
import { installProfileApi, profileUserB } from "./helpers/profile-api";

// Phase 6 of docs/specs/profile-sidebar-relayout.md (the Phase 6 glossary):
// the words that Profile, Account settings and the shell show are customer
// words. Internal glossary words (docs/architecture/21-glossary.md) and the
// names that the relayout retired must not come back in any rendered state.
// "Workspace" stays out of this list: the shell keeps "Search workspace"
// (PD21) and "Workspace home" (PD26) on every page (glossary row PG23).
// Words that only another spec can reach stay with that spec: the photo
// cleanup alert with profile.spec.ts, and the email errors after a session
// check with auth-email-change.spec.ts.

test.use({ trace: "off", screenshot: "off", video: "off" });

const INTERNAL =
  /\b(bindings?|operators?|reconcil\w*|polic(?:y|ies)|authentication|authorization|memberships?|installations?|providers?|revocations?|MFA|TOTP|IANA)\b/i;
const RETIRED =
  /Look & behavior|Sign-in & security|Convenience shortcuts|Reload profile|Save identity|Live preview|Save timezone|Use organization timezone|\bMiB\b|Preferences unavailable|Not loaded|Short bio|devices that are signed in|sign-in context|Confirm account action|current session/i;

async function expectCustomerWords(page: Page, state: string) {
  const shown = await page.locator("body").innerText();
  const labels = await page
    .locator("[aria-label]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")).join("\n"),
    );
  for (const [words, where] of [
    [shown, state],
    [labels, `${state} (aria-label)`],
  ] as const) {
    expect(words, where).not.toMatch(INTERNAL);
    expect(words, where).not.toMatch(RETIRED);
  }
}

const stamp = "2026-10-24T09:47:00Z";
async function installTwoSessions(page: Page) {
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({
      json: [
        {
          id: "00000000-0000-4000-8000-000000000801",
          created_at: stamp,
          refreshed_at: stamp,
          expires_at: "2099-10-01T00:00:00Z",
          user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
          ip_address: "127.0.0.1",
          current: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000802",
          created_at: stamp,
          refreshed_at: stamp,
          expires_at: "2099-10-01T00:00:00Z",
          user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
          ip_address: "10.0.4.21",
          current: false,
        },
      ],
    }),
  );
}

const panel = (page: Page) =>
  page.getByRole("region", { name: "Settings", exact: true });

test("no Account settings state shows an internal or retired word", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installProfileApi(page);
  await installTwoSessions(page);
  await page.route("**/api/auth/me/email", (route) =>
    route.fulfill({ status: 403, json: { detail: "Forbidden" } }),
  );
  await page.goto("/settings");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "+1 555 0101",
  );
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).toBeEnabled();
  await expect(page.getByTestId("two-step-status")).toHaveText("Off");
  await expectCustomerWords(page, "Account settings");

  // Each dialog, and the email dialog after a refused request.
  await page.getByRole("button", { name: "Change password" }).click();
  const password = page.getByRole("dialog", { name: "Change password" });
  await expect(password).toContainText("Other devices sign out");
  await expectCustomerWords(page, "Change password");
  await password.getByRole("button", { name: "Close password" }).click();

  await page.getByRole("button", { name: "Change email" }).click();
  const email = page.getByRole("dialog", { name: "Change email" });
  await email.getByLabel("New email").fill("maya.new@example.com");
  await email.getByLabel("Current password").fill("correct horse battery");
  await email.getByRole("button", { name: "Send confirmation emails" }).click();
  await expect(email.getByRole("alert")).toBeVisible();
  await expectCustomerWords(page, "Change email refused");
  await email.getByRole("button", { name: "Close email" }).click();

  await page
    .getByRole("button", { name: "Manage two-step verification" })
    .click();
  const twoStep = page.getByRole("dialog", { name: "Two-step verification" });
  await expect(twoStep).toBeVisible();
  await expectCustomerWords(page, "Two-step verification");
  await twoStep.getByRole("button", { name: "Close two-step" }).click();

  // The session confirmations.
  await panel(page)
    .getByRole("button", { name: /^Session actions, Chrome on Windows/ })
    .click();
  await page.getByRole("menuitem", { name: /^End session, Chrome/ }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expectCustomerWords(page, "End session confirmation");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await panel(page)
    .getByRole("button", { name: "Sign out other sessions" })
    .click();
  await expect(confirm).toBeVisible();
  // Not the closing End session dialog: the one the button opened.
  await expect(confirm).toHaveAccessibleName("Sign out other sessions?");
  await expectCustomerWords(page, "Sign out other sessions confirmation");
  await confirm.getByRole("button", { name: "Cancel" }).click();

  // An unsaved change, then leaving through the account menu.
  await page.getByLabel("Phone", { exact: true }).fill("+1 555 0102");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
  await expectCustomerWords(page, "Account menu");
  await page.getByRole("menuitem", { name: "Your profile" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Keep editing");
  await expectCustomerWords(page, "Unsaved changes");
  await page.getByRole("button", { name: "Keep editing" }).click();

  // Help for this page.
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const help = page.getByRole("dialog", { name: "Help", exact: true });
  await expect(help).toContainText("Save profile");
  await expectCustomerWords(page, "Help on Account settings");
});

test("Account settings shows no retired word when preferences fail, or without an organization", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installProfileApi(page);
  api.preferencesStatus = 503;
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: "Retry preferences" }),
  ).toBeVisible();
  await expectCustomerWords(page, "Preferences failed");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await installProfileApi(page, { role: null });
  await page.goto("/settings");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Maya Chen",
  );
  await expectCustomerWords(page, "Without an organization");
});

test("no Profile or shell state shows an internal or retired word", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installProfileApi(page);
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { level: 1, name: "Maya Chen" }),
  ).toBeVisible();
  await expectCustomerWords(page, "Your profile");
  await page
    .getByRole("button", { name: /^Organization: / })
    .first()
    .click();
  await expect(page.getByRole("menu", { name: "Organizations" })).toBeVisible();
  await expectCustomerWords(page, "Organization menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Help" })).toContainText(
    "View profile",
  );
  await expectCustomerWords(page, "Help on Profile");
  await page.keyboard.press("Escape");

  await page.goto(`/profile?person=${profileUserB}`);
  await expect(page.locator("main")).toContainText(
    "This profile is not available.",
  );
  await expectCustomerWords(page, "Profile not available");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("dialog", { name: "OpenSlate navigation" }),
  ).toBeVisible();
  await expectCustomerWords(page, "Drawer");
});
