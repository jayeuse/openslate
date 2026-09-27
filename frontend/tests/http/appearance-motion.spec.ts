import { expect, test, type Page } from "@playwright/test";

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

const travel = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--nav-travel-y")
      .trim(),
  );

test("reduce motion in Appearance stops page travel and survives a reload", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/appearance");
  const toggle = page.getByRole("switch", { name: "Reduce motion" });
  await expect(toggle).not.toBeChecked();
  expect(await travel(page)).not.toBe("0px");

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  expect(await travel(page)).toBe("0px");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).toBeChecked();

  await page.getByRole("switch", { name: "Reduce motion" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-motion");
  expect(await travel(page)).not.toBe("0px");
});
