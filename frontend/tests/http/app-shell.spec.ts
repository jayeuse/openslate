import { wireWorkspace } from "../helpers/wire";
import { installProfileApi } from "./helpers/profile-api";
import {
  authMeBody,
  expect,
  signedInSession,
  test,
  type Locator,
  type Page,
} from "./helpers/test";

// The slim shell (docs/specs/profile-sidebar-relayout.md, PD1–PD8): 32px
// one-line rows and 32px header controls from 1280px, the 44px floor below,
// and the phone drawer with its own row sizes, descriptions and active ink.
// The navigation model itself is owned by isolated/workspace-navigation.spec.ts.

const ADMIN = "00000000-0000-4000-8000-000000000501";

async function signInAsHarborAdmin(page: Page) {
  await signedInSession(page, ADMIN);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({ id: ADMIN, role: "admin", display_name: "HO Admin" }),
    }),
  );
  await page.route("**/api/workspace", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: wireWorkspace({
            id: "00000000-0000-4000-8000-000000000102",
            display_name: "Harbor Operations Group",
            mark: "HOG",
            locale: "en-PH",
            timezone: "Asia/Manila",
            currency: "PHP",
            today: "2026-10-06",
            purge_enabled: false,
          }),
        })
      : route.fallback(),
  );
}

const sidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Primary sidebar", exact: true });
const mainNavigation = (scope: Page | Locator) =>
  scope.getByRole("navigation", { name: "Main navigation", exact: true });
const height = async (target: Locator) =>
  Math.round((await target.boundingBox())?.height ?? 0);
const size = async (target: Locator) => {
  const box = await target.boundingBox();
  return [Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)];
};

test("from 1280px the sidebar is 240px with 32px one-line rows, the full organization name and the account row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAsHarborAdmin(page);
  await page.goto("/platform");
  const navigation = mainNavigation(sidebar(page));
  const access = navigation.getByRole("button", {
    name: "Access",
    exact: true,
  });
  await expect(access).toBeVisible();

  // One line: the description is the row's title and description, not text.
  await expect(access).toHaveText("Access");
  await expect(access).toHaveAttribute("title", "Who can see and change what");
  await expect(access).toHaveAttribute(
    "aria-description",
    "Who can see and change what",
  );
  expect(await height(access)).toBe(32);
  const files = navigation.getByRole("link", { name: "Files", exact: true });
  expect(await height(files)).toBe(32);
  const comms = sidebar(page).getByRole("link", {
    name: "OpenComms",
    exact: true,
  });
  await expect(comms).toHaveText("OpenComms");
  await expect(comms).toHaveAttribute(
    "aria-description",
    "Messages and channels",
  );
  expect(await height(comms)).toBe(32);

  await expect
    .poll(() =>
      page
        .locator("#primary-sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    )
    .toBe(240);
  const name = sidebar(page)
    .getByRole("button", {
      name: "Organization: Harbor Operations Group",
      exact: true,
    })
    .getByText("Harbor Operations Group", { exact: true });
  await expect(name).toBeVisible();
  expect(
    await name.evaluate(
      (el) =>
        el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
    ),
  ).toBe(true);

  // The footer account row is a real link to the person's own profile.
  const account = sidebar(page).getByRole("link", {
    name: "Your profile, HO Admin",
    exact: true,
  });
  await expect(account).toHaveAttribute("href", "/profile");
  await expect(account).toContainText("Administrator");
  await expect(account).toHaveAttribute("aria-description", "Administrator");
  await expect(account).not.toHaveAttribute("aria-current", "page");
  await expect(
    sidebar(page).getByRole("button", { name: "Your profile", exact: true }),
  ).toHaveCount(0);

  // Collapse sits in the sidebar header and toggles the 56px rail.
  const header = sidebar(page).locator('[data-slot="sidebar-header"]');
  await header
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator("#primary-sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    )
    .toBe(56);
  const expand = header.getByRole("button", {
    name: "Expand sidebar",
    exact: true,
  });
  await expect(expand).toBeVisible();
  expect(await size(expand)).toEqual([32, 32]);
  // In the rail the mark is the organization menu; its first item is the
  // workspace home, so the separate home link and chevron are gone.
  await expect(header.getByRole("link")).toHaveCount(0);
  await expect(header.getByRole("button")).toHaveCount(2);
  const mark = header.getByRole("button", {
    name: "Organization: Harbor Operations Group",
    exact: true,
  });
  expect(await size(mark)).toEqual([32, 32]);
  await mark.click();
  await expect(
    page.getByRole("menuitem", { name: "Workspace home", exact: true }),
  ).toHaveAttribute("href", "/openview");
  await page.keyboard.press("Escape");
  expect(
    await size(
      sidebar(page).getByRole("link", {
        name: "Your profile, HO Admin",
        exact: true,
      }),
    ),
  ).toEqual([32, 32]);
  await expand.click();
  await expect
    .poll(() =>
      page
        .locator("#primary-sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    )
    .toBe(240);
});

test("the account row is current on the person's own profile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installProfileApi(page);
  await page.goto("/profile");
  await expect(
    sidebar(page).getByRole("link", {
      name: "Your profile, Maya Chen",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
});

test("header controls are 32px from 1280px and 44px on a phone; Search is a quiet named control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAsHarborAdmin(page);
  await page.goto("/platform");
  const header = page.locator('[data-skin="topbar"]');
  const search = header.getByRole("link", {
    name: "Search workspace",
    exact: true,
  });
  await expect(search).toHaveText("Search");
  expect(await height(search)).toBe(32);
  const controls = [
    header.getByRole("button", { name: /^Notifications/ }),
    header.getByRole("button", { name: "Help", exact: true }),
    header.getByRole("button", { name: "Account", exact: true }),
  ];
  for (const control of controls) expect(await size(control)).toEqual([32, 32]);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const control of [
    header.getByRole("button", { name: "Open navigation", exact: true }),
    search,
    ...controls,
  ]) {
    const [width, tall] = await size(control);
    expect(Math.min(width, tall)).toBeGreaterThanOrEqual(44);
  }
});

test("from 1024 to 1279px the sidebar keeps one-line rows at the 44px floor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await signInAsHarborAdmin(page);
  await page.goto("/platform");
  const navigation = mainNavigation(sidebar(page));
  const access = navigation.getByRole("button", {
    name: "Access",
    exact: true,
  });
  await expect(access).toHaveText("Access");
  expect(await height(access)).toBeGreaterThanOrEqual(44);
  expect(
    await height(navigation.getByRole("link", { name: "Files", exact: true })),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await height(
      sidebar(page).getByRole("link", { name: "Your profile, HO Admin" }),
    ),
  ).toBeGreaterThanOrEqual(44);

  // The rail keeps 44px targets below 1280px.
  await sidebar(page)
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator("#primary-sidebar")
        .evaluate((el) => el.getBoundingClientRect().width),
    )
    .toBe(56);
  for (const target of [
    sidebar(page).getByRole("button", {
      name: "Organization: Harbor Operations Group",
      exact: true,
    }),
    sidebar(page).getByRole("button", { name: "Expand sidebar", exact: true }),
    navigation.getByRole("button", { name: "Access", exact: true }),
    sidebar(page).getByRole("link", { name: "OpenComms", exact: true }),
    sidebar(page).getByRole("link", {
      name: "Your profile, HO Admin",
      exact: true,
    }),
  ])
    expect(Math.min(...(await size(target)))).toBeGreaterThanOrEqual(44);
});

test("the phone drawer has 44px rows with visible descriptions and the active ink", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsHarborAdmin(page);
  await page.goto("/platform");
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "OpenSlate navigation" });
  const navigation = mainNavigation(drawer);
  const access = navigation.getByRole("button", {
    name: "Access",
    exact: true,
  });
  await expect(access).toContainText("Who can see and change what");
  expect(await height(access)).toBeGreaterThanOrEqual(44);
  const active = navigation.getByRole("link", { name: "Search", exact: true });
  await expect(active).toHaveAttribute("aria-current", "page");
  expect(await height(active)).toBeGreaterThanOrEqual(44);
  await expect(active).toHaveCSS("color", "rgb(29, 78, 216)");
  await expect(active).toHaveCSS("font-weight", "600");
  for (const target of [
    drawer.getByRole("link", { name: "OpenComms", exact: true }),
    drawer.getByRole("link", { name: "Your profile, HO Admin", exact: true }),
    drawer.getByRole("link", {
      name: "Harbor Operations Group workspace",
      exact: true,
    }),
  ]) {
    const [width, tall] = await size(target);
    expect(Math.min(width, tall)).toBeGreaterThanOrEqual(44);
  }
  await expect(
    drawer.getByRole("link", { name: "OpenComms", exact: true }),
  ).toContainText("Messages and channels");
});

test("the resize separator shows a 4px handle and a focus ring when focused", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAsHarborAdmin(page);
  await page.goto("/platform");
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  await resize.focus();
  await expect(resize).toBeFocused();
  await expect(resize).toHaveCSS("outline-style", "solid");
  await expect(resize).toHaveCSS("outline-width", "2px");
  expect(
    await resize.evaluate((el) => {
      const handle = getComputedStyle(el, "::after");
      return {
        width: handle.width,
        painted: handle.backgroundColor !== "rgba(0, 0, 0, 0)",
      };
    }),
  ).toEqual({ width: "4px", painted: true });
});

const sidebarWidth = (page: Page) =>
  page
    .locator("#primary-sidebar")
    .evaluate((el) => el.getBoundingClientRect().width);
const storedWidth = (page: Page) =>
  page.evaluate(() => localStorage.getItem("openslate-sidebar-width"));
async function seedStoredWidth(page: Page, width: string) {
  await page.addInitScript((value) => {
    localStorage.setItem("openslate-sidebar-width", value);
  }, width);
}

test("a stored 271px, the old default, opens at the new 240px default", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedStoredWidth(page, "271");
  await signInAsHarborAdmin(page);
  await page.goto("/platform");
  await expect(mainNavigation(sidebar(page))).toBeVisible();
  await expect.poll(() => storedWidth(page)).toBe("240");
  expect(await sidebarWidth(page)).toBe(240);
});

test("a stored width is kept; double-click resets to 240px and Home and End reach 220 and 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedStoredWidth(page, "300");
  await signInAsHarborAdmin(page);
  await page.goto("/platform");
  await expect.poll(() => sidebarWidth(page)).toBe(300);
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  await resize.dblclick();
  await expect.poll(() => sidebarWidth(page)).toBe(240);
  await resize.press("Home");
  await expect.poll(() => sidebarWidth(page)).toBe(220);
  await resize.press("End");
  await expect.poll(() => sidebarWidth(page)).toBe(360);
});
