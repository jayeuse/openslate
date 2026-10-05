import { expect, test, type Page } from "./helpers/test";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";

async function signIn(page: Page) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
  );
}

const routeTitles = [
  ["/sandbox", "Sandbox | OpenSlate"],
  ["/boards", "Boards | OpenSlate"],
  ["/comms", "OpenComms | OpenSlate"],
  ["/access", "Access | OpenSlate"],
  ["/openview", "OpenView | OpenSlate"],
  ["/manage", "Manage | OpenSlate"],
  ["/platform", "Platform | OpenSlate"],
  ["/settings/appearance", "Appearance | OpenSlate"],
  ["/login", "Sign in | OpenSlate"],
  ["/setup", "Setup guide | OpenSlate"],
] as const;

test("each route names itself in the browser tab", async ({ page }) => {
  await signIn(page);
  for (const [path, title] of routeTitles) {
    await page.goto(path);
    await expect(page, path).toHaveTitle(title);
  }
});

test("the breadcrumb names the workspace and its open section", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/sandbox?section=history");
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("link", { name: "Sandbox" }),
  ).toHaveAttribute("href", "/sandbox?section=build");
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
    "History",
  );

  await page.goto("/platform?section=files");
  await expect(
    breadcrumb.getByRole("link", { name: "Platform" }),
  ).toBeVisible();
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
    "Search",
  );
});

test("a phone breadcrumb drops the Workspace root", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/sandbox?section=history");
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("link", { name: "Workspace" }),
  ).toBeHidden();
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(
    "History",
  );
});

test("Comms snapshot recovery stays within Comms while live routes and returning drafts remain usable", async ({
  page,
}) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user_id: "00000000-0000-4000-8000-000000000101",
        setup_required: false,
      },
    }),
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
