import { expect, test } from "../coverage";
import { fulfillWorkspaceRequest } from "../helpers/workspace-fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("**/session/status", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/session/realtime-token", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/bff/**", async (route) => {
    if (!(await fulfillWorkspaceRequest(route))) await route.continue();
  });
});

test("appearance choices apply immediately and survive reload", async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.getByRole("radio", { name: "Emerald", exact: true }).check();
  await page.getByRole("radio", { name: "Compact", exact: true }).check();
  await page.getByRole("radio", { name: "Rounded", exact: true }).check();
  await expect(
    page.getByRole("combobox", { name: "Navigation structure", exact: true }),
  ).toHaveCount(0);
  const root = page.locator("html");
  await expect(root).toHaveClass(/dark/);
  await expect(root).toHaveAttribute("data-accent", "emerald");
  await expect(root).toHaveAttribute("data-density", "compact");
  await expect(root).toHaveAttribute("data-radius", "rounded");
  await page.reload();
  for (const name of ["Dark", "Emerald", "Compact", "Rounded"])
    await expect(page.getByRole("radio", { name, exact: true })).toBeChecked();
  await expect(page.getByText("Classic", { exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(root).not.toHaveClass(/dark/);
});

test("blocked preference storage retains usable appearance controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
  });
  await page.goto("/settings/appearance");
  await expect(
    page.getByRole("radio", { name: "Light", exact: true }),
  ).toBeChecked();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("radio", { name: "Indigo", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "indigo");
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "Light", exact: true }),
  ).toBeChecked();
});

test("starts monochrome and preserves an explicitly selected cobalt accent", async ({
  page,
}) => {
  await page.goto("/settings/appearance");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "neutral");
  await page.getByRole("radio", { name: "Cobalt", exact: true }).check();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
});
