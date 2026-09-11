import { expect, test } from "../coverage";

test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
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

test("uses only the new six-pillar workspace even with a saved classic preference", async ({
  page,
  isMobile,
}) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.addInitScript(() =>
    localStorage.setItem("openslate-navigation-structure", "classic"),
  );
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/openview$/);
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  const navigation = page
    .getByRole("navigation", { name: "Main navigation" })
    .filter({ visible: true });
  for (const [name, slug] of [
    ["Sandbox", "sandbox"],
    ["Boards", "boards"],
    ["OpenComms", "comms"],
    ["Access", "access"],
    ["OpenView", "openview"],
    ["Manage", "manage"],
  ]) {
    await expect(
      navigation.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", `/${slug}`);
  }
  await expect(navigation.getByRole("link")).toHaveCount(6);
  await expect(
    page.getByRole("button", { name: "Live workspace", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sample workspace", exact: true }),
  ).toHaveCount(0);
  await Promise.all([
    page.waitForURL("**/sandbox"),
    navigation.getByRole("link", { name: "Sandbox", exact: true }).click(),
  ]);
  await expect(page).toHaveURL(/\/sandbox$/);
  await expect(
    page.getByRole("heading", { name: "Organization designer", exact: true }),
  ).toBeVisible();
});

test("offers one keyboard-accessible account menu with real sign out", async ({
  page,
}) => {
  let logoutMethod = "";
  await page.route("**/session/logout", async (route) => {
    logoutMethod = route.request().method();
    await route.fulfill({ json: { authenticated: false } });
  });
  await page.goto("/openview");
  const account = page.getByRole("button", { name: "Account", exact: true });
  await expect(account).toHaveCount(1);
  await account.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Account", exact: true });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Account settings", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(account).toBeFocused();
  await page.goto("/platform");
  await account.click();
  await menu
    .getByRole("menuitem", { name: "Account settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/platform#account$/);
  await expect(
    page.getByRole("heading", { name: "Personal preferences", exact: true }),
  ).toBeVisible();
  await account.click();
  await menu.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(logoutMethod).toBe("POST");
});

test("mobile navigation restores focus and reaches appearance without legacy rail controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sandbox");
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
    drawer.getByRole("button", { name: "Account", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawer.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
});

test("uses local OpenSlate branding without fetching a private logo", async ({
  page,
  isMobile,
}) => {
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
  const logoRequests: string[] = [];
  await page.route("**/bff/workspace/logo?*", (route) => {
    logoRequests.push(route.request().url());
    return route.fulfill({ status: 204 });
  });
  await page.goto("/openview");
  if (isMobile)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();

  const brand = page
    .getByRole("link", {
      name: isMobile ? "OpenSlate" : "OpenSlate workspace",
      exact: true,
    })
    .filter({ visible: true });
  await expect(brand).toHaveAttribute("href", "/openview");
  await expect(brand).toContainText("OS");
  expect(logoRequests).toEqual([]);
});

test("sidebar resizing and collapse persist through new Designer navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/openview");
  const resize = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await resize.focus();
  await resize.press("End");
  await expect(resize).toHaveAttribute("aria-valuenow", "400");
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "400");
  await resize.press("Home");
  await resize.press("ArrowRight");
  await expect(resize).toHaveAttribute("aria-valuenow", "272");
  await resize.press("ArrowLeft");
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await resize.hover();
  const bounds = await resize.boundingBox();
  if (!bounds) throw new Error("Visible sidebar resize control is required");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 50);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 50, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", "336");
  await page.reload();
  await expect(resize).toHaveAttribute("aria-valuenow", "336");
  await resize.dblclick();
  await expect(resize).toHaveAttribute("aria-valuenow", "256");
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(resize).not.toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Sandbox", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sandbox$/);
  await expect(resize).not.toBeVisible();
  await page
    .getByRole("button", { name: "Expand sidebar", exact: true })
    .click();
  await expect(resize).toBeVisible();
});
