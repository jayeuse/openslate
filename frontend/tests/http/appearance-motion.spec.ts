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

// The sidebar's width change is one of the glides that reduce motion stops.
const sidebarGlide = (page: Page) =>
  page.evaluate(
    () =>
      getComputedStyle(
        document.querySelector('[data-slot="sidebar-gap"]') as Element,
      ).transitionProperty,
  );

test("reduce motion in Appearance stops glides and survives a reload", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/appearance");
  const toggle = page.getByRole("switch", { name: "Reduce motion" });
  await expect(toggle).not.toBeChecked();
  expect(await sidebarGlide(page)).toBe("width");

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  expect(await sidebarGlide(page)).toBe("none");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await expect(
    page.getByRole("switch", { name: "Reduce motion" }),
  ).toBeChecked();

  await page.getByRole("switch", { name: "Reduce motion" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-motion");
  expect(await sidebarGlide(page)).toBe("width");
});
