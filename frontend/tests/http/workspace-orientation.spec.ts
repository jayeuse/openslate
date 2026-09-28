import { expect, test, type Page } from "./helpers/test";

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
    "File library",
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
