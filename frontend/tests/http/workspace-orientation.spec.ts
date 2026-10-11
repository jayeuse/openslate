import {
  expect,
  signedInSession,
  signedOut,
  test,
  type Page,
} from "./helpers/test";
import { sandboxDocumentFromDesign } from "../helpers/sandbox-fixtures";
import { initialDesign } from "../../src/components/systems/sandbox/domain/model";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";

async function signIn(page: Page) {
  await signedInSession(page, "00000000-0000-4000-8000-000000000101");
}

const routeTitles = [
  ["/sandbox", "Sandbox | OpenSlate"],
  ["/boards", "Boards | OpenSlate"],
  ["/comms", "OpenComms | OpenSlate"],
  ["/access", "Access | OpenSlate"],
  ["/openview", "OpenView | OpenSlate"],
  ["/manage", "Manage | OpenSlate"],
  ["/platform", "Platform | OpenSlate"],
  ["/profile", "Your profile | OpenSlate"],
  ["/setup", "Setup guide | OpenSlate"],
] as const;

// The titles are static page metadata, so one journey visits every route;
// the sign-in page comes last, once the session reads as signed out.
test("every route names itself in the browser tab", async ({ page }) => {
  await signIn(page);
  for (const [path, title] of routeTitles) {
    await page.goto(path);
    await expect(page, path).toHaveTitle(title);
  }
  await signedOut(page);
  await page.goto("/login");
  await expect(page, "/login").toHaveTitle("Sign in | OpenSlate");
});

test("the breadcrumb names the workspace and its open section, and a phone shows only the current page", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/platform?section=files");
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("link", { name: "Platform" }),
  ).toBeVisible();
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("Files");

  await page.goto("/sandbox?section=history");
  await expect(
    breadcrumb.getByRole("link", { name: "Sandbox" }),
  ).toHaveAttribute("href", "/sandbox?section=build");
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
    "History",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    breadcrumb.getByRole("link", { name: "Workspace" }),
  ).toBeHidden();
  await expect(breadcrumb.getByRole("link", { name: "Sandbox" })).toBeHidden();
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
    "History",
  );
});

test("Comms snapshot recovery stays within Comms while live routes and returning drafts remain usable", async ({
  page,
}) => {
  await signIn(page);
  const document = sandboxDocumentFromDesign(initialDesign);
  await page.route("**/api/sandbox/document", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            document,
            revision: 1,
            contentHash: "a".repeat(64),
            byteCount: JSON.stringify(document).length,
            issues: [],
            latestPublishedVersion: null,
            publishedHash: null,
            hasUnpublishedChanges: true,
          },
        })
      : route.fallback(),
  );
  for (const resource of ["versions", "tests"])
    await page.route(
      (url) => url.pathname === `/api/sandbox/${resource}`,
      (route) =>
        route.request().method() === "GET"
          ? route.fulfill({
              json: {
                items: [],
                limit: 50,
                offset: 0,
                count: 0,
                total: 0,
                hasMore: false,
              },
            })
          : route.fallback(),
    );
  const snapshotKey = workspaceSessionSnapshotStorageKey(
    "00000000-0000-4000-8000-000000000101",
  );
  await page.addInitScript(
    (key) => sessionStorage.setItem(key, "{"),
    snapshotKey,
  );
  const recovery = page.getByText(
    "Saved workspace data could not be restored. Default data has been loaded.",
    { exact: true },
  );
  for (const path of [
    "/platform",
    "/manage",
    "/openview",
    "/access",
    "/boards",
    "/sandbox",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1 }),
    ).toBeVisible();
    await expect(recovery, path).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Reset workspace data", exact: true }),
      path,
    ).toHaveCount(0);
  }
  await page.goto("/comms");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeVisible();
  await expect(recovery).toBeVisible();
  await message.fill("Unsent route-owned Comms draft");
  await page
    .getByRole("link", { name: "Search workspace", exact: true })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search workspace", exact: true }),
  ).toBeVisible();
  await expect(recovery).toHaveCount(0);
  await page.getByRole("link", { name: "OpenComms", exact: true }).click();
  await expect(message).toHaveValue("Unsent route-owned Comms draft");
});

test("125 percent text scales the resizable sidebar and keeps resize units and sticky focus consistent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/profile#look");
  const textSize = page.getByRole("combobox", { name: "Text size" });
  await expect(textSize).toHaveValue("100");
  const sidebar = page.locator("#primary-sidebar");
  const resize = page.getByRole("separator", { name: "Resize sidebar" });
  const baseline = await sidebar.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  const heading = page.getByRole("heading", {
    name: "Your profile",
    exact: true,
  });
  const headingSize = () =>
    heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const headingBaseline = await headingSize();
  await textSize.selectOption("125");
  await expect
    .poll(() => sidebar.evaluate((el) => el.getBoundingClientRect().width))
    .toBeCloseTo(baseline * 1.25, 0);
  // Page headings scale with the text size, like the sidebar.
  await expect
    .poll(async () => (await headingSize()) / headingBaseline)
    .toBe(1.25);
  await resize.focus();
  await resize.press("ArrowRight");
  await expect
    .poll(() => sidebar.evaluate((el) => el.getBoundingClientRect().width))
    .toBeCloseTo(baseline * 1.25 + 20, 0);
  const increased = await sidebar.evaluate(
    (el) => el.getBoundingClientRect().width,
  );
  expect(Number(await resize.getAttribute("aria-valuenow"))).toBeCloseTo(
    increased,
    0,
  );
  const handle = await resize.boundingBox();
  if (!handle) throw new Error("Sidebar resize handle missing");
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 40,
    handle.y + handle.height / 2,
  );
  await page.mouse.up();
  await expect
    .poll(() => sidebar.evaluate((el) => el.getBoundingClientRect().width))
    .toBeCloseTo(increased + 40, 0);
  const stored = await page.evaluate(() =>
    Number(localStorage.getItem("openslate-sidebar-width")),
  );
  expect(stored).toBeCloseTo((increased + 40) / 1.25, 0);
  const keyboard = page.getByRole("switch", { name: "Convenience shortcuts" });
  await keyboard.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await keyboard.focus();
  const top = await page
    .locator('[data-skin="topbar"]')
    .evaluate((el) => el.getBoundingClientRect().bottom);
  expect((await keyboard.boundingBox())!.y).toBeGreaterThanOrEqual(top);
  await page.reload();
  await expect
    .poll(() => sidebar.evaluate((el) => el.getBoundingClientRect().width))
    .toBeCloseTo(increased + 40, 0);
});
