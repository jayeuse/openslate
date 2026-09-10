import { expect, test, type Locator } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/bff/files?*", (route) =>
    route.fulfill({
      json: {
        items: [],
        pagination: {
          offset: 0,
          limit: 25,
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    }),
  );
  await page.route("**/bff/auth/me", (route) =>
    route.fulfill({
      json: {
        id: "user",
        role: "admin",
        permissions: ["departments.read", "departments.write", "records.read"],
      },
    }),
  );
  await page.route("**/bff/workspace", (route) =>
    route.fulfill({
      json: {
        id: 1,
        display_name: "OpenSlate",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        timezone: "UTC",
        locale: "en-US",
        revision: 1,
        logo_file_id: null,
      },
    }),
  );
});

test("navigates from Sandbox to Appearance on desktop and mobile", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/sandbox");
  if (isMobile) {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "Appearance", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
});

test("supports Account menu keyboard dismissal, outside click, and logout", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  let logoutMethod = "";
  await page.route("**/session/logout", async (route) => {
    logoutMethod = route.request().method();
    await route.fulfill({ json: { authenticated: false } });
  });
  await page.goto("/workspace");

  let account: Locator;
  if (isMobile) {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    account = page
      .locator("#mobile-navigation")
      .getByRole("button", { name: "Account", exact: true });
  } else {
    account = page
      .getByRole("complementary", { name: "Primary sidebar" })
      .getByRole("button", { name: "Account", exact: true });
  }
  const menu = page.getByRole("menu", { name: "Account", exact: true });
  await account.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Sign out", exact: true }),
  ).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(account).toBeFocused();

  await account.click();
  await expect(menu).toBeVisible();
  if (!isMobile) {
    await page.mouse.click(800, 200);
    await expect(menu).toHaveCount(0);
  } else {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }

  await account.click();
  await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(logoutMethod).toBe("POST");
});

test("keeps mobile navigation focused without desktop rail controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto("/workspace");

  const trigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await trigger.click();
  const drawer = page.locator("#mobile-navigation");
  await expect(
    drawer.getByRole("button", { name: "Close navigation", exact: true }),
  ).toBeFocused();
  await expect(
    drawer.getByRole("separator", { name: "Resize sidebar", exact: true }),
  ).toHaveCount(0);
  await expect(
    drawer.getByRole("button", { name: "Collapse sidebar", exact: true }),
  ).toHaveCount(0);
  await expect(
    drawer.getByRole("button", { name: "Expand sidebar", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("keeps administrator navigation hidden for a custom role with every capability", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/auth/me", (route) =>
    route.fulfill({
      json: {
        id: "custom",
        role: "manager",
        permissions: [
          "departments.read",
          "departments.write",
          "modules.read",
          "modules.write",
          "fields.read",
          "fields.write",
          "records.read",
          "records.write",
          "relationships.read",
          "relationships.write",
        ],
      },
    }),
  );
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "OpenSlate", exact: true }),
  ).toBeVisible();
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  const navigation = page
    .getByRole("navigation", { name: "Main navigation" })
    .filter({ visible: true });
  await expect(
    navigation.getByRole("button", { name: "Access", exact: true }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Workspace settings" }),
  ).toHaveCount(0);
  await page.goto("/settings/workspace");
  await expect(
    page.getByText("Administrator access is required to manage the workspace."),
  ).toBeVisible();
});

test("saves profile edits with their revision and retains a rejected draft", async ({
  page,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  let profile = {
    id: 1,
    display_name: "OpenSlate",
    legal_name: null,
    description: null,
    contact_email: null,
    contact_phone: null,
    postal_address: null,
    timezone: "UTC",
    locale: "en-US",
    revision: 1,
    logo_file_id: null,
  };
  let reject = false;
  await page.route("**/bff/workspace", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(profile.revision);
      if (reject) {
        await route.fulfill({
          status: 409,
          json: { detail: "Workspace changed. Reload before saving." },
        });
        return;
      }
      profile = { ...profile, ...body, revision: profile.revision + 1 };
    }
    await route.fulfill({ json: profile });
  });
  await page.goto("/settings/workspace");
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Operations team");
  await page
    .getByRole("button", { name: "Save workspace", exact: true })
    .click();
  await expect(
    page.getByText("Workspace saved.", { exact: true }),
  ).toBeVisible();
  reject = true;
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Preserved draft");
  await page
    .getByRole("button", { name: "Save workspace", exact: true })
    .click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Preserved draft",
  );
  await expect(
    page.getByText("Workspace changed. Reload before saving."),
  ).toBeVisible();
});

test("loads the current private logo directly and exposes documents in classic navigation", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/workspace", (route) =>
    route.fulfill({
      json: {
        id: 1,
        display_name: "Operations",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        timezone: "UTC",
        locale: "en-US",
        revision: 2,
        logo_file_id: "logo",
      },
    }),
  );
  await page.route("**/bff/workspace/logo?*", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
        "base64",
      ),
    }),
  );
  await page.addInitScript(() =>
    localStorage.setItem("openslate-navigation-structure", "classic"),
  );
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await expect(
    page.locator('img[src*="/bff/workspace/logo"]').filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: "Documents", exact: true })
      .filter({ visible: true }),
  ).toHaveAttribute("href", "/administration/files");
});
