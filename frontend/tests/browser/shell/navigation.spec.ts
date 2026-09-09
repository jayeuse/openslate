import { expect, test, type Locator } from "@playwright/test";

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
