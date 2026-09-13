import { expect, test } from "../coverage";
import { installSessionMocks } from "../helpers/administration-fixtures";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";
import AxeBuilder from "@axe-core/playwright";

const screenHeadings: Record<string, string> = {
  sandbox: "Organization designer",
  openview: "Service requests",
  boards: "Boards",
  comms: "OpenComms",
  access: "Access",
  manage: "Manage",
  platform: "Platform",
};

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installSessionMocks(page);
  await page.route("**/bff/**", async (route) => {
    if (await fulfillWorkspaceRequest(route)) return;
    await route.fulfill({
      status: 404,
      json: { detail: "No live data in sample tests" },
    });
  });
});

for (const pillar of ["sandbox", "openview", "comms"]) {
  test(`sample ${pillar} retains contrast in dark mode`, async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("openslate-theme", "dark"),
    );
    await page.goto(`/${pillar}`);
    await expect(page).toHaveURL(new RegExp(`/${pillar}$`));
    await expect(
      page.getByRole("heading", {
        name: screenHeadings[pillar],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator("main h1").filter({ visible: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    const accessibility = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    if (pillar === "comms") {
      const create = page.getByRole("button", {
        name: "Create channel",
        exact: true,
      });
      await create.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Channel name")).toBeFocused();
      const modalAccessibility = await new AxeBuilder({ page })
        .include('[role="dialog"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(modalAccessibility.violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(create).toBeFocused();
    }
  });
}

for (const pillar of [
  "sandbox",
  "boards",
  "comms",
  "access",
  "openview",
  "manage",
  "platform",
]) {
  test(`sample ${pillar} has usable responsive boundaries`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (
        /\/(bff|session)\//.test(request.url()) &&
        !["GET", "HEAD"].includes(request.method()) &&
        !request.url().endsWith("/session/realtime-token")
      )
        mutations.push(request.url());
    });
    await page.goto(`/${pillar}`);
    await expect(page).toHaveURL(new RegExp(`/${pillar}$`));
    await expect(
      page.getByRole("heading", {
        name: screenHeadings[pillar],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator("main h1").filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Changes stay in this tab. No live changes.", {
        exact: true,
      }),
    ).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
    const accessibility = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });
}

test("recovers corrupted sample storage and resets only the sample workspace", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("openslate.sample.v1", "{broken"),
  );
  await page.goto("/openview");
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Saved workspace data could not be restored. Default data has been loaded.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset workspace data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/openview$/);
});

test("offers a safe reset when an old sample slice cannot render", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      "openslate.sample.v1",
      JSON.stringify({ platformNotifications: [null] }),
    ),
  );
  await page.goto("/platform#notifications");
  await expect(
    page.getByRole("heading", { name: "Workspace data could not be opened" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset workspace data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
});

for (const [legacy, destination] of [
  ["/workspace", "/openview"],
  ["/departments", "/sandbox"],
  ["/departments/legacy-department/modules/legacy-module/schema", "/sandbox"],
  ["/modules/legacy-module/records/legacy-record/edit", "/openview"],
  ["/administration/users", "/access"],
  ["/administration/audit", "/manage"],
  ["/administration/files", "/platform"],
  ["/settings/workspace", "/manage"],
  ["/onboarding", "/manage"],
]) {
  test(`legacy entrypoint ${legacy} opens the new screen`, async ({ page }) => {
    await page.goto(legacy);
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
    await expect(
      page.getByText("Changes stay in this tab. No live changes.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.locator("main h1").filter({ visible: true }),
    ).toBeVisible();
  });
}

test("workspace works with every business backend connection unavailable", async ({
  page,
}) => {
  test.slow();
  const businessRequests: string[] = [];
  const subscriptions: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/bff/") || path === "/session/realtime-token")
      businessRequests.push(path);
  });
  page.on("websocket", (socket) => {
    if (!new URL(socket.url()).pathname.startsWith("/_next/"))
      subscriptions.push(socket.url());
  });
  await page.route("**/bff/**", (route) => route.abort());
  await page.route("**/session/realtime-token", (route) => route.abort());
  for (const pillar of [
    "sandbox",
    "openview",
    "boards",
    "comms",
    "access",
    "manage",
    "platform",
  ]) {
    await page.goto(`/${pillar}`);
    await expect(page).toHaveURL(new RegExp(`/${pillar}$`));
    await expect(
      page.getByRole("heading", {
        name: screenHeadings[pillar],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator("main h1").filter({ visible: true }),
    ).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }
  expect(businessRequests).toEqual([]);
  expect(subscriptions).toEqual([]);
});

test("local workspace still requires sign-in", async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.goto("/openview");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Service requests", exact: true }),
  ).toHaveCount(0);
});

test("OpenComms fits the viewport and keeps its compact navigation preference separate", async ({
  page,
  isMobile,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("openslate-sidebar-collapsed", "false"),
  );
  await page.goto("/comms");
  await expect(
    page.getByRole("heading", { name: "OpenComms", exact: true }),
  ).toBeVisible();
  if (!isMobile) {
    await expect(
      page.getByRole("button", { name: "Expand sidebar", exact: true }),
    ).toBeVisible();
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight <= window.innerHeight + 1,
      ),
    )
    .toBe(true);
  const main = await page.locator("main").boundingBox();
  expect(main).not.toBeNull();
  expect(main!.y + main!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  if (!isMobile) {
    await page
      .getByRole("button", { name: "Expand sidebar", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Collapse sidebar", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Access", exact: true })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Collapse sidebar", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("openslate-sidebar-collapsed"),
      ),
    ).toBe("false");
  }
});

test("workspace navigation avoids unused font preloads and resource warnings", async ({
  page,
  browserName,
}) => {
  const warnings: string[] = [];
  if (browserName === "chromium") {
    const devtools = await page.context().newCDPSession(page);
    await devtools.send("Log.enable");
    devtools.on("Log.entryAdded", (event: { entry: { text: string } }) =>
      warnings.push(event.entry.text),
    );
  }
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error")
      warnings.push(message.text());
  });
  await page.goto("/access");
  await page.reload();
  await page.goto("/sandbox");
  await expect(page.locator("main h1").filter({ visible: true })).toBeVisible();
  const openNavigation = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page
    .getByRole("link", { name: "Access", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/access$/);
  await expect(page.locator("main h1").filter({ visible: true })).toBeVisible();
  await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      [...document.fonts].some(
        (font) => font.family === "Geist" && font.status === "loaded",
      ),
    ),
  ).toBe(true);
  await page.waitForTimeout(7000); // Chromium reports unused preloads several seconds after loading.
  expect(
    warnings.filter(
      (message) =>
        message.includes("was preloaded") || message.includes("manhattan"),
    ),
  ).toEqual([]);
});

test("OpenComms has immersive chrome and resizable side panels", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  await expect(
    page.getByRole("heading", { name: "OpenComms", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sample workspace", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByLabel("Sample viewing as", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).not.toContainText("Sample");
  if (isMobile) {
    await expect(
      page.getByRole("separator", { name: "Resize channels" }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "operations", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  } else {
    for (const [name, side] of [
      ["Resize channels", "Conversations"],
      ["Resize members", "Channel members"],
    ]) {
      const handle = page.getByRole("separator", { name, exact: true });
      const panel = page.getByRole("complementary", {
        name: side,
        exact: true,
      });
      await expect(handle).toBeVisible();
      const before = await panel.boundingBox();
      await handle.focus();
      await handle.press(
        name === "Resize channels" ? "ArrowRight" : "ArrowLeft",
      );
      await expect
        .poll(async () => (await panel.boundingBox())!.width)
        .toBeGreaterThan(before!.width);
      const grip = await handle.boundingBox();
      const width = (await panel.boundingBox())!.width;
      await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + 80);
      await page.mouse.down();
      await page.mouse.move(
        grip!.x + grip!.width / 2 + (name === "Resize channels" ? 35 : -35),
        grip!.y + 80,
      );
      await page.mouse.up();
      await expect
        .poll(async () => (await panel.boundingBox())!.width)
        .toBeGreaterThan(width);
      const saved = await panel.boundingBox();
      await page.reload();
      await expect
        .poll(async () => Math.round((await panel.boundingBox())!.width))
        .toBe(Math.round(saved!.width));
    }
    await page.getByRole("button", { name: "Members", exact: true }).click();
    await expect(
      page.getByRole("separator", { name: "Resize members" }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "Members", exact: true }).click();
    await expect(
      page.getByRole("separator", { name: "Resize members" }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("OpenComms menu opens settings and channel branches reopen and resize their threads", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  const title = page.getByRole("button", { name: "OpenComms", exact: true });
  await title.click();
  await page
    .getByRole("menuitem", { name: "Edit channel", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Edit channel",
    exact: true,
  });
  await expect(settings.getByLabel("Channel name")).toHaveValue("operations");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(title).toBeFocused();
  if (isMobile)
    await page.getByRole("button", { name: "operations", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Pump inspection planning");
  await page.getByLabel("Message", { exact: true }).press("Enter");
  const message = page
    .getByRole("article")
    .filter({ hasText: "Pump inspection planning" });
  if (isMobile)
    await message
      .getByRole("button", { name: "Message actions", exact: true })
      .click();
  else await message.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Create thread", exact: true })
    .click();
  await page
    .getByLabel("Thread reply", { exact: true })
    .fill("Inspect tomorrow");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  const branches = page.getByRole("group", {
    name: "Threads in operations",
    exact: true,
  });
  const branch = branches.getByRole("button", {
    name: "Thread: Pump inspection planning",
    exact: true,
  });
  await expect(branch).toBeVisible();
  await page.getByRole("button", { name: "workshop", exact: true }).click();
  if (isMobile)
    await page
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
  await branch.click();
  await expect(
    page
      .getByRole("region", { name: "Thread conversation" })
      .getByText("Inspect tomorrow", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to messages", exact: true })
    .click();
  await page.reload();
  await expect(branch).toBeVisible();
  await title.click();
  await page
    .getByRole("menuitem", { name: "Browse threads", exact: true })
    .click();
  const directory = page.getByRole("dialog", {
    name: "Workspace threads",
    exact: true,
  });
  await directory
    .getByRole("button", { name: /Pump inspection planning/ })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Thread conversation" })
      .getByText("Inspect tomorrow", { exact: true }),
  ).toBeVisible();
  const resize = page.getByRole("separator", {
    name: "Resize thread",
    exact: true,
  });
  if (isMobile) {
    await expect(resize).not.toBeVisible();
  } else {
    const panel = page.getByRole("complementary", {
      name: "Thread panel",
      exact: true,
    });
    const before = (await panel.boundingBox())!.width;
    await resize.focus();
    await resize.press("ArrowLeft");
    await expect
      .poll(async () => (await panel.boundingBox())!.width)
      .toBeGreaterThan(before);
    const grip = (await resize.boundingBox())!;
    const width = (await panel.boundingBox())!.width;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 80);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 40, grip.y + 80);
    await page.mouse.up();
    await expect
      .poll(async () => (await panel.boundingBox())!.width)
      .toBeGreaterThan(width);
    const saved = Math.round((await panel.boundingBox())!.width);
    await page
      .getByRole("button", { name: "Back to messages", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "Channel members", exact: true }),
    ).toHaveCSS("width", "220px");
    await page.reload();
    await branch.click();
    await expect
      .poll(async () => Math.round((await panel.boundingBox())!.width))
      .toBe(saved);
    await resize.press("Home");
    await expect
      .poll(async () => Math.round((await panel.boundingBox())!.width))
      .toBe(320);
    await resize.press("End");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("channel and category context menus edit the clicked item", async ({
  page,
  isMobile,
}) => {
  await page.goto("/comms");
  const workshop = page.getByRole("button", { name: "workshop", exact: true });
  if (isMobile)
    await page
      .getByRole("button", { name: "Channel actions: workshop", exact: true })
      .click();
  else await workshop.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Edit channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Channel name")).toHaveValue("workshop");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  if (!isMobile) {
    await expect(workshop).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "operations", exact: true }),
    ).toBeVisible();
    await workshop.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "Edit channel", exact: true })
      .click();
    await expect(dialog.getByLabel("Channel name")).toHaveValue("workshop");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  const projects = page.getByRole("button", { name: "Projects", exact: true });
  if (isMobile)
    await page
      .getByRole("button", { name: "Edit category Projects", exact: true })
      .click();
  else {
    await projects.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Edit category", exact: true })
      .click();
  }
  await expect(dialog.getByLabel("Category name")).toHaveValue("Projects");
  await dialog.getByLabel("Category name").fill("Delivery projects");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Delivery projects", exact: true }),
  ).toBeVisible();
  await expect(workshop).toBeVisible();
});

test("unknown workspace slugs remain not-found pages", async ({ page }) => {
  for (const path of ["/missing-workspace-screen", "/constructor"]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "This slate is blank.", exact: true }),
    ).toBeVisible();
  }
});
